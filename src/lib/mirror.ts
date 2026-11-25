import { put } from '@vercel/blob';
import { buildPublicEpisodeUrl, verifyAdminRequest } from '@/lib/auth';
import {
  findEpisodeMirrorSlot,
  findNextFreeMirrorSlot,
  getEpisodeById,
  isDatabaseConfigured,
  type PlayerEpisode,
  saveEpisodeMirrorSource,
} from '@/lib/db';
import { assertSafeExternalUrl, isTrustedMediaHost } from '@/lib/ssrf';
import { BROWSER_UA, resolveUpstreamReferer } from '@/lib/stream-proxy';
import type { EpisodeDto, MirrorEpisodeResult } from '@/lib/types';
import { validateHttpUrl } from '@/lib/video-sources';

export const EXPIRED_MIRROR_LINK_MESSAGE = 'link vencido, pegue um novo no 1DM';

const ALLOWED_EXACT_MEDIA_CDN_HOSTS = new Set([
  'stream.mux.com',
  'api.anivideo.net',
]);

export function isAllowedMirrorSourceHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  if (!lower) return false;

  if (
    lower.endsWith('.r2.cloudflarestorage.com') &&
    lower.length > '.r2.cloudflarestorage.com'.length
  ) {
    return true;
  }

  if (isTrustedMediaHost(lower)) {
    return true;
  }

  if (lower.endsWith('.b-cdn.net') && lower.length > '.b-cdn.net'.length) {
    return true;
  }

  if (ALLOWED_EXACT_MEDIA_CDN_HOSTS.has(lower)) {
    return true;
  }

  return false;
}

export function buildMirrorBlobPathname(
  animeName: string | null | undefined,
  episodeId: string
): string {
  const cleanEpisodeId = episodeId.trim();
  if (!cleanEpisodeId || !/^[A-Za-z0-9_-]+$/.test(cleanEpisodeId)) {
    throw new Error('ID do episódio inválido para espelhamento.');
  }

  const rawAnime = typeof animeName === 'string' ? animeName.trim() : '';
  const slug = rawAnime
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const animeSegment = slug || 'sem-anime';
  return `mirrors/${animeSegment}/${cleanEpisodeId}.mp4`;
}

export function isExpiredUpstreamResponse(status: number, bodyText = ''): boolean {
  if (status === 403) {
    return true;
  }
  const lower = bodyText.toLowerCase();
  if (!lower) return false;
  return (
    lower.includes('expiredrequest') ||
    lower.includes('request has expired') ||
    lower.includes('<code') && lower.includes('expired')
  );
}

export function getMirrorUpstreamHeaders(targetUrl: URL): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
  };

  const lowerHost = targetUrl.hostname.toLowerCase();
  if (!lowerHost.endsWith('.r2.cloudflarestorage.com')) {
    const referer = resolveUpstreamReferer(targetUrl);
    if (referer && referer !== `${targetUrl.origin}/`) {
      headers['Referer'] = referer;
    }
  }

  return headers;
}

async function readSmallErrorSnippet(response: Response, maxBytes = 8192): Promise<string> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        const remaining = maxBytes - total;
        chunks.push(value.byteLength > remaining ? value.subarray(0, remaining) : value);
        total += Math.min(value.byteLength, remaining);
      }
    }
  } catch {
    // Ignorar falha de leitura de corpo de erro
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignorar erro de cancelamento
    }
  }

  if (chunks.length === 0) return '';
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

export async function safeFetchMirrorStream(
  initialUrl: string,
  options: {
    maxRedirects?: number;
    connectTimeoutMs?: number;
    fetchImpl?: typeof fetch;
    assertSafeUrl?: typeof assertSafeExternalUrl;
  } = {}
): Promise<{ response: Response; finalUrl: string }> {
  const maxRedirects = options.maxRedirects ?? 5;
  const connectTimeoutMs = options.connectTimeoutMs ?? 20000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const assertSafe = options.assertSafeUrl ?? assertSafeExternalUrl;
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validatedUrl = await assertSafe(currentUrl);
    if (!isAllowedMirrorSourceHost(validatedUrl.hostname)) {
      throw new Error(
        'Host de origem não permitido para espelhamento. Use apenas *.r2.cloudflarestorage.com ou CDNs de mídia do projeto.'
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), connectTimeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(validatedUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: getMirrorUpstreamHeaders(validatedUrl),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignorar erro ao descartar corpo de redirect
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new Error('Redirecionamento sem cabeçalho Location.');
      }
      if (hop === maxRedirects) {
        throw new Error('Número máximo de redirecionamentos excedido.');
      }
      currentUrl = new URL(location, validatedUrl).toString();
      continue;
    }

    return {
      response,
      finalUrl: validatedUrl.toString(),
    };
  }

  throw new Error('Falha ao seguir redirecionamentos da origem.');
}

export type MirrorPutBlobFn = (
  pathname: string,
  body: ReadableStream<Uint8Array>,
  options: {
    access: 'public';
    allowOverwrite: boolean;
    addRandomSuffix: boolean;
    contentType: string;
    multipart: boolean;
    token: string;
  }
) => Promise<{ url: string; pathname: string }>;

export interface MirrorEpisodeDeps {
  getEpisode?: (id: string) => Promise<PlayerEpisode | null>;
  fetchStream?: typeof safeFetchMirrorStream;
  putBlob?: MirrorPutBlobFn;
  saveMirrorSource?: (
    episodeId: string,
    blobUrl: string,
    options: { force?: boolean }
  ) => Promise<{ episode: PlayerEpisode; slot: 1 | 2 | 3 | 4 | 5 }>;
  blobToken?: string;
  isDbConfigured?: () => boolean;
}

export type MirrorServiceOutcome =
  | {
      status: 200;
      body: Extract<MirrorEpisodeResult, { ok: true }>;
    }
  | {
      status: 400 | 401 | 403 | 404 | 409 | 500 | 502;
      body: Extract<MirrorEpisodeResult, { ok: false }>;
    };

function toEpisodeDto(ep: PlayerEpisode): EpisodeDto {
  return {
    ...ep,
    public_url: buildPublicEpisodeUrl(ep.id),
  };
}

export async function mirrorEpisodeSource(
  params: {
    episodeId: string;
    sourceUrl: string;
    force?: boolean;
  },
  deps: MirrorEpisodeDeps = {}
): Promise<MirrorServiceOutcome> {
  const isDbReady = deps.isDbConfigured ?? isDatabaseConfigured;
  if (!isDbReady()) {
    return {
      status: 500,
      body: { ok: false, error: 'DATABASE_URL não configurada no servidor.' },
    };
  }

  const cleanEpisodeId = typeof params.episodeId === 'string' ? params.episodeId.trim() : '';
  if (!cleanEpisodeId || cleanEpisodeId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cleanEpisodeId)) {
    return {
      status: 400,
      body: { ok: false, error: 'ID do episódio inválido.' },
    };
  }

  const urlCheck = validateHttpUrl(typeof params.sourceUrl === 'string' ? params.sourceUrl : '');
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    return {
      status: 400,
      body: { ok: false, error: urlCheck.error ?? 'URL de origem inválida.' },
    };
  }

  const parsedSource = new URL(urlCheck.normalizedUrl);
  if (!isAllowedMirrorSourceHost(parsedSource.hostname)) {
    return {
      status: 403,
      body: {
        ok: false,
        error:
          'Host de origem não permitido para espelhamento. Use apenas *.r2.cloudflarestorage.com ou CDNs de mídia do projeto.',
      },
    };
  }

  const token = (deps.blobToken ?? process.env.BLOB_READ_WRITE_TOKEN ?? '').trim();
  if (!token) {
    return {
      status: 500,
      body: { ok: false, error: 'BLOB_READ_WRITE_TOKEN não está configurada no servidor.' },
    };
  }

  const getEpisode = deps.getEpisode ?? getEpisodeById;
  const episode = await getEpisode(cleanEpisodeId);
  if (!episode) {
    return {
      status: 404,
      body: { ok: false, error: 'Episódio não encontrado.' },
    };
  }

  const force = Boolean(params.force);
  const existingMirrorSlot = findEpisodeMirrorSlot(episode);
  if (existingMirrorSlot && !force) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'Este episódio já possui espelho salvo. Marque "forçar refazer" para substituir.',
      },
    };
  }

  if (!existingMirrorSlot && !findNextFreeMirrorSlot(episode)) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'Todos os 5 slots de fontes deste episódio já estão ocupados.',
      },
    };
  }

  const fetchStream = deps.fetchStream ?? safeFetchMirrorStream;
  let upstream: Response;
  try {
    const fetched = await fetchStream(urlCheck.normalizedUrl);
    upstream = fetched.response;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Falha ao conectar na URL de origem.';
    const status = message.includes('não permitido') ? 403 : 502;
    return {
      status,
      body: { ok: false, error: message },
    };
  }

  if (!upstream.ok) {
    const snippet = await readSmallErrorSnippet(upstream);
    if (isExpiredUpstreamResponse(upstream.status, snippet)) {
      return {
        status: 403,
        body: { ok: false, error: EXPIRED_MIRROR_LINK_MESSAGE },
      };
    }
    return {
      status: 502,
      body: {
        ok: false,
        error: `Origem retornou erro HTTP ${upstream.status} ao baixar episódio.`,
      },
    };
  }

  const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('xml') || contentType.includes('text/html')) {
    const snippet = await readSmallErrorSnippet(upstream);
    if (isExpiredUpstreamResponse(upstream.status, snippet)) {
      return {
        status: 403,
        body: { ok: false, error: EXPIRED_MIRROR_LINK_MESSAGE },
      };
    }
    return {
      status: 502,
      body: {
        ok: false,
        error: 'A origem retornou HTML/XML em vez de um stream de vídeo válido.',
      },
    };
  }

  if (!upstream.body) {
    return {
      status: 502,
      body: {
        ok: false,
        error: 'A resposta da origem não forneceu corpo em streaming.',
      },
    };
  }

  const pathname = buildMirrorBlobPathname(episode.anime_name, episode.id);
  const putBlob: MirrorPutBlobFn =
    deps.putBlob ??
    (async (path, body, opts) => {
      const result = await put(path, body, opts);
      return { url: result.url, pathname: result.pathname };
    });

  let blobResult: { url: string; pathname: string };
  try {
    blobResult = await putBlob(pathname, upstream.body, {
      access: 'public',
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: 'video/mp4',
      multipart: true,
      token,
    });
  } catch (err) {
    try {
      await upstream.body.cancel();
    } catch {
      // Ignorar erro de cancelamento
    }
    return {
      status: 502,
      body: {
        ok: false,
        error:
          err instanceof Error
            ? `Falha ao enviar vídeo em streaming para o Vercel Blob: ${err.message}`
            : 'Falha ao enviar vídeo para o Vercel Blob.',
      },
    };
  }

  const saveMirrorSource =
    deps.saveMirrorSource ??
    ((epId: string, blobUrl: string, opts: { force?: boolean }) =>
      saveEpisodeMirrorSource(epId, blobUrl, opts));

  try {
    const saved = await saveMirrorSource(episode.id, blobResult.url, { force });
    return {
      status: 200,
      body: {
        ok: true,
        episode: toEpisodeDto(saved.episode),
        blobUrl: blobResult.url,
        pathname: blobResult.pathname || pathname,
        slot: saved.slot,
      },
    };
  } catch (err) {
    return {
      status: 500,
      body: {
        ok: false,
        error:
          err instanceof Error ? err.message : 'Falha ao gravar espelho no banco de dados.',
      },
    };
  }
}

export async function handleMirrorRequest(
  request: Request,
  deps: MirrorEpisodeDeps & {
    verifyAdmin?: typeof verifyAdminRequest;
  } = {}
): Promise<Response> {
  if (request.method.toUpperCase() !== 'POST') {
    return Response.json(
      { ok: false, error: 'Método não permitido. Use POST.' },
      { status: 405, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const checkAdmin = deps.verifyAdmin ?? verifyAdminRequest;
  const auth = checkAdmin(request);

  if (!auth.sameOrigin) {
    return Response.json(
      { ok: false, error: 'Origem da requisição não permitida.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (!auth.authenticated) {
    return Response.json(
      { ok: false, error: 'Sessão administrativa expirada ou não autenticada.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return Response.json(
        { ok: false, error: 'Corpo JSON inválido.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json(
      { ok: false, error: 'Corpo JSON inválido.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const episodeId = String(body.episodeId ?? body.id ?? '');
  const sourceUrl = String(body.sourceUrl ?? body.url ?? '');
  const force = Boolean(body.force);

  const outcome = await mirrorEpisodeSource(
    { episodeId, sourceUrl, force },
    deps
  );

  return Response.json(outcome.body, {
    status: outcome.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
