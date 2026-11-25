import { del, put } from '@vercel/blob';
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
import {
  deriveKindFromExtension,
  type ExplicitSourceKind,
  validateHttpUrl,
} from '@/lib/video-sources';

export function deriveMirrorSourceKind(fileUrlOrPath: string): ExplicitSourceKind {
  return deriveKindFromExtension(fileUrlOrPath);
}

export const EXPIRED_MIRROR_LINK_MESSAGE = 'link vencido, pegue um novo no 1DM';
export const TOO_LARGE_MIRROR_MESSAGE = 'arquivo grande demais para cópia';
export const INCOMPLETE_MIRROR_MESSAGE = 'cópia incompleta, tente de novo';
export const MAX_MIRROR_BYTES = 400 * 1024 * 1024;
export const MIRROR_CHUNK_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MIRROR_SOFT_TIMEOUT_MS = 285_000;

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
    (lower.includes('<code') && lower.includes('expired'))
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

export function parseMirrorContentLength(response: Response): number | null {
  const contentRange = response.headers.get('content-range');
  if (contentRange) {
    const match = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(contentRange.trim());
    if (match) {
      const total = Number(match[1]);
      if (Number.isFinite(total) && total >= 0) {
        return total;
      }
    }
  }

  const rawLength = response.headers.get('content-length');
  if (rawLength && /^\d+$/.test(rawLength.trim())) {
    const parsed = Number(rawLength.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return null;
}

function parseDirectHeaderLength(response: Response): number | null {
  const rawLength = response.headers.get('content-length');
  if (rawLength && /^\d+$/.test(rawLength.trim())) {
    const parsed = Number(rawLength.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
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
    range?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    assertSafeUrl?: typeof assertSafeExternalUrl;
  } = {}
): Promise<{ response: Response; finalUrl: string }> {
  const maxRedirects = options.maxRedirects ?? 5;
  const connectTimeoutMs = options.connectTimeoutMs ?? 30000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const assertSafe = options.assertSafeUrl ?? assertSafeExternalUrl;
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (options.signal?.aborted) {
      throw new DOMException('Operação abortada.', 'AbortError');
    }

    const validatedUrl = await assertSafe(currentUrl);
    if (!isAllowedMirrorSourceHost(validatedUrl.hostname)) {
      throw new Error(
        'Host de origem não permitido para espelhamento. Use apenas *.r2.cloudflarestorage.com ou CDNs de mídia do projeto.'
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const headers = getMirrorUpstreamHeaders(validatedUrl);
    if (options.range) {
      headers['Range'] = options.range;
    }

    let response: Response;
    try {
      response = await fetchImpl(validatedUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener('abort', onExternalAbort);
      }
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
    abortSignal?: AbortSignal;
  }
) => Promise<{ url: string; pathname: string }>;

export type MirrorDelBlobFn = (
  urlOrPathname: string | string[],
  options?: { token?: string }
) => Promise<void>;

export interface MirrorEpisodeDeps {
  getEpisode?: (id: string) => Promise<PlayerEpisode | null>;
  fetchStream?: typeof safeFetchMirrorStream;
  putBlob?: MirrorPutBlobFn;
  delBlob?: MirrorDelBlobFn;
  saveMirrorSource?: (
    episodeId: string,
    blobUrl: string,
    options: { force?: boolean; kind?: ExplicitSourceKind; forceProxy?: boolean }
  ) => Promise<{ episode: PlayerEpisode; slot: 1 | 2 | 3 | 4 | 5 }>;
  blobToken?: string;
  isDbConfigured?: () => boolean;
  maxDurationMs?: number;
  signal?: AbortSignal;
}

export type MirrorServiceOutcome =
  | {
      status: 200;
      body: Extract<MirrorEpisodeResult, { ok: true }>;
    }
  | {
      status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502 | 504;
      body: Extract<MirrorEpisodeResult, { ok: false }>;
    };

function toEpisodeDto(ep: PlayerEpisode): EpisodeDto {
  return {
    ...ep,
    public_url: buildPublicEpisodeUrl(ep.id),
  };
}

class MirrorExpiredLinkError extends Error {
  constructor(message = EXPIRED_MIRROR_LINK_MESSAGE) {
    super(message);
    this.name = 'MirrorExpiredLinkError';
  }
}

class MirrorTooLargeError extends Error {
  constructor(message = TOO_LARGE_MIRROR_MESSAGE) {
    super(message);
    this.name = 'MirrorTooLargeError';
  }
}

class MirrorIncompleteError extends Error {
  constructor(message = INCOMPLETE_MIRROR_MESSAGE) {
    super(message);
    this.name = 'MirrorIncompleteError';
  }
}

function resolveSoftTimeoutMs(depsTimeoutMs?: number): number {
  if (typeof depsTimeoutMs === 'number' && Number.isFinite(depsTimeoutMs) && depsTimeoutMs > 0) {
    return depsTimeoutMs;
  }
  const envVal = Number(process.env.MIRROR_MAX_DURATION_MS);
  if (Number.isFinite(envVal) && envVal > 0) {
    return envVal;
  }
  return DEFAULT_MIRROR_SOFT_TIMEOUT_MS;
}

async function safeCancelBody(response: Response | null | undefined): Promise<void> {
  if (!response?.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Ignorar falha ao cancelar body
  }
}

async function safeDeleteBlob(
  target: string | null | undefined,
  token: string,
  delBlob: MirrorDelBlobFn
): Promise<void> {
  const clean = target?.trim();
  if (!clean) return;
  try {
    await delBlob(clean, { token });
  } catch {
    // Ignorar se blob parcial ainda não foi finalizado no store
  }
}

async function validateUpstreamResponse(upstream: Response): Promise<
  | { ok: true }
  | { ok: false; status: 403 | 502; error: string }
> {
  if (!upstream.ok) {
    const snippet = await readSmallErrorSnippet(upstream);
    if (isExpiredUpstreamResponse(upstream.status, snippet)) {
      return {
        ok: false,
        status: 403,
        error: EXPIRED_MIRROR_LINK_MESSAGE,
      };
    }
    return {
      ok: false,
      status: 502,
      error: `Origem retornou erro HTTP ${upstream.status} ao baixar episódio.`,
    };
  }

  const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('xml') || contentType.includes('text/html')) {
    const snippet = await readSmallErrorSnippet(upstream);
    if (isExpiredUpstreamResponse(upstream.status, snippet)) {
      return {
        ok: false,
        status: 403,
        error: EXPIRED_MIRROR_LINK_MESSAGE,
      };
    }
    return {
      ok: false,
      status: 502,
      error: 'A origem retornou HTML/XML em vez de um stream de vídeo válido.',
    };
  }

  if (!upstream.body) {
    return {
      ok: false,
      status: 502,
      error: 'A resposta da origem não forneceu corpo em streaming.',
    };
  }

  return { ok: true };
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
  const putBlob: MirrorPutBlobFn =
    deps.putBlob ??
    (async (path, body, opts) => {
      const result = await put(path, body, opts);
      return { url: result.url, pathname: result.pathname };
    });
  const delBlob: MirrorDelBlobFn =
    deps.delBlob ??
    (async (urlOrPathname, opts) => {
      await del(urlOrPathname, opts);
    });

  const deadlineController = new AbortController();
  let timedOut = false;
  const softTimeoutMs = resolveSoftTimeoutMs(deps.maxDurationMs);

  const triggerTimeoutAbort = () => {
    timedOut = true;
    if (!deadlineController.signal.aborted) {
      deadlineController.abort(new MirrorIncompleteError());
    }
  };

  const deadlineTimer = setTimeout(triggerTimeoutAbort, softTimeoutMs);
  const onExternalAbort = () => {
    timedOut = true;
    if (!deadlineController.signal.aborted) {
      deadlineController.abort(new MirrorIncompleteError());
    }
  };
  if (deps.signal) {
    if (deps.signal.aborted) {
      triggerTimeoutAbort();
    } else {
      deps.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const hasProcessSigterm = typeof process !== 'undefined' && typeof process.once === 'function';
  if (hasProcessSigterm) {
    process.once('SIGTERM', triggerTimeoutAbort);
  }

  let firstResponse: Response | null = null;
  let finalSourceUrl = urlCheck.normalizedUrl;

  try {
    const firstRange = `bytes=0-${MIRROR_CHUNK_BYTES - 1}`;
    try {
      const fetched = await fetchStream(urlCheck.normalizedUrl, {
        range: firstRange,
        signal: deadlineController.signal,
      });
      firstResponse = fetched.response;
      finalSourceUrl = fetched.finalUrl;
    } catch (err) {
      if (timedOut || deadlineController.signal.aborted) {
        return {
          status: 504,
          body: { ok: false, error: INCOMPLETE_MIRROR_MESSAGE },
        };
      }
      const message = err instanceof Error ? err.message : 'Falha ao conectar na URL de origem.';
      const status = message.includes('não permitido') ? 403 : 502;
      return {
        status,
        body: { ok: false, error: message },
      };
    }

    const validation = await validateUpstreamResponse(firstResponse);
    if (!validation.ok) {
      await safeCancelBody(firstResponse);
      return {
        status: validation.status,
        body: { ok: false, error: validation.error },
      };
    }

    const expectedContentLength = parseMirrorContentLength(firstResponse);
    if (expectedContentLength === null || expectedContentLength <= 0) {
      await safeCancelBody(firstResponse);
      return {
        status: 502,
        body: {
          ok: false,
          error: 'Origem não informou o tamanho (content-length) válido do arquivo.',
        },
      };
    }

    if (expectedContentLength > MAX_MIRROR_BYTES) {
      await safeCancelBody(firstResponse);
      return {
        status: 413,
        body: { ok: false, error: TOO_LARGE_MIRROR_MESSAGE },
      };
    }

    const pathname = buildMirrorBlobPathname(episode.anime_name, episode.id);
    const usesRangeLoop = firstResponse.status === 206;

    let bytesSent = 0;
    let currentPartBytes = 0;
    let currentPartHeaderLength: number | null = parseDirectHeaderLength(firstResponse);
    let currentResponse: Response | null = firstResponse;
    let currentReader: ReadableStreamDefaultReader<Uint8Array> | null =
      firstResponse.body!.getReader();
    let streamFinished = false;
    let streamError: unknown = null;

    const cleanupActiveReader = async () => {
      if (currentReader) {
        try {
          await currentReader.cancel();
        } catch {
          // Ignorar falha ao cancelar reader
        }
        currentReader = null;
      }
    };

    const uploadStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (true) {
            if (timedOut || deadlineController.signal.aborted) {
              throw new MirrorIncompleteError();
            }

            if (!currentReader) {
              if (!usesRangeLoop || bytesSent >= expectedContentLength) {
                streamFinished = true;
                controller.close();
                return;
              }

              const start = bytesSent;
              const end = Math.min(start + MIRROR_CHUNK_BYTES - 1, expectedContentLength - 1);
              const fetchedPart = await fetchStream(finalSourceUrl, {
                range: `bytes=${start}-${end}`,
                signal: deadlineController.signal,
              });
              const partResponse = fetchedPart.response;
              const partCheck = await validateUpstreamResponse(partResponse);
              if (!partCheck.ok) {
                await safeCancelBody(partResponse);
                if (partCheck.status === 403) {
                  throw new MirrorExpiredLinkError(partCheck.error);
                }
                throw new MirrorIncompleteError();
              }
              if (partResponse.status !== 206) {
                await safeCancelBody(partResponse);
                throw new MirrorIncompleteError();
              }
              currentPartBytes = 0;
              currentPartHeaderLength = parseDirectHeaderLength(partResponse);
              currentResponse = partResponse;
              currentReader = partResponse.body!.getReader();
            }

            const { done, value } = await currentReader.read();
            if (done) {
              currentReader = null;
              currentResponse = null;

              if (!usesRangeLoop) {
                streamFinished = true;
                controller.close();
                return;
              }

              if (
                currentPartHeaderLength !== null &&
                currentPartBytes < currentPartHeaderLength
              ) {
                throw new MirrorIncompleteError();
              }

              if (bytesSent >= expectedContentLength) {
                streamFinished = true;
                controller.close();
                return;
              }

              if (currentPartBytes === 0) {
                throw new MirrorIncompleteError();
              }

              // Continua no loop para buscar a próxima parte de 8 MB via Range
              continue;
            }

            if (value && value.byteLength > 0) {
              if (bytesSent + value.byteLength > MAX_MIRROR_BYTES) {
                await cleanupActiveReader();
                throw new MirrorTooLargeError();
              }
              bytesSent += value.byteLength;
              currentPartBytes += value.byteLength;
              controller.enqueue(value);
              return;
            }
          }
        } catch (err) {
          streamError = err;
          await cleanupActiveReader();
          controller.error(err);
        }
      },
      async cancel() {
        await cleanupActiveReader();
        await safeCancelBody(currentResponse);
      },
    });

    let blobResult: { url: string; pathname: string };
    try {
      blobResult = await putBlob(pathname, uploadStream, {
        access: 'public',
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'video/mp4',
        multipart: true,
        token,
        abortSignal: deadlineController.signal,
      });
    } catch (err) {
      await cleanupActiveReader();
      await safeDeleteBlob(pathname, token, delBlob);

      if (err instanceof MirrorExpiredLinkError || streamError instanceof MirrorExpiredLinkError) {
        return {
          status: 403,
          body: { ok: false, error: EXPIRED_MIRROR_LINK_MESSAGE },
        };
      }
      if (err instanceof MirrorTooLargeError || streamError instanceof MirrorTooLargeError) {
        return {
          status: 413,
          body: { ok: false, error: TOO_LARGE_MIRROR_MESSAGE },
        };
      }
      if (
        timedOut ||
        deadlineController.signal.aborted ||
        err instanceof MirrorIncompleteError ||
        streamError instanceof MirrorIncompleteError
      ) {
        return {
          status: timedOut ? 504 : 502,
          body: { ok: false, error: INCOMPLETE_MIRROR_MESSAGE },
        };
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

    if (
      timedOut ||
      deadlineController.signal.aborted ||
      !streamFinished ||
      bytesSent !== expectedContentLength
    ) {
      await safeDeleteBlob(blobResult.url || blobResult.pathname || pathname, token, delBlob);
      if (blobResult.pathname && blobResult.pathname !== blobResult.url) {
        await safeDeleteBlob(blobResult.pathname, token, delBlob);
      }
      return {
        status: timedOut ? 504 : 502,
        body: { ok: false, error: INCOMPLETE_MIRROR_MESSAGE },
      };
    }

    const mirrorKind = deriveMirrorSourceKind(
      blobResult.url || blobResult.pathname || pathname
    );
    const saveMirrorSource =
      deps.saveMirrorSource ??
      ((
        epId: string,
        blobUrl: string,
        opts: { force?: boolean; kind?: ExplicitSourceKind; forceProxy?: boolean }
      ) => saveEpisodeMirrorSource(epId, blobUrl, opts));

    try {
      const saved = await saveMirrorSource(episode.id, blobResult.url, {
        force,
        kind: mirrorKind,
        forceProxy: false,
      });
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
  } finally {
    clearTimeout(deadlineTimer);
    if (deps.signal) {
      deps.signal.removeEventListener('abort', onExternalAbort);
    }
    if (hasProcessSigterm && typeof process.off === 'function') {
      process.off('SIGTERM', triggerTimeoutAbort);
    }
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
    { signal: request.signal, ...deps }
  );

  return Response.json(outcome.body, {
    status: outcome.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
