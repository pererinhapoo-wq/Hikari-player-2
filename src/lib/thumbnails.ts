import { put } from '@vercel/blob';
import { verifyAdminRequest } from '@/lib/auth';
import { resolveBunnyStreamSource } from '@/lib/bunny';
import { getEpisodeById, isDatabaseConfigured, type PlayerEpisode } from '@/lib/db';
import {
  buildSignedProxyPath,
  createProxySignature,
  getStableProxyExpiry,
} from '@/lib/proxy-signing';
import {
  buildIncompatibleEmbedMessage,
  MAX_THUMBNAIL_UPLOAD_BYTES,
  pickBestThumbnailCandidate,
  type ThumbnailSourceInput,
  type ThumbnailSourcePlan,
} from '@/lib/thumbnail-utils';
import { type ExplicitSourceKind, isVercelBlobUrl } from '@/lib/video-sources';

export type SupportedThumbnailMime = 'image/jpeg' | 'image/webp' | 'image/png';

const MIME_TO_EXT: Record<SupportedThumbnailMime, 'jpg' | 'webp' | 'png'> = {
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/png': 'png',
};

function resolveProxyUrlWithOptionalWorker(
  targetUrl: string,
  workerBaseEnv = process.env.WORKER_BASE,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const rawBase = workerBaseEnv?.trim();
  if (rawBase) {
    try {
      const parsed = new URL(rawBase);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const normalizedBase = parsed
          .toString()
          .replace(/\/+$/, '')
          .replace(/\/api\/proxy\/stream$/, '');
        const stableExp = getStableProxyExpiry(nowSeconds);
        const sig = createProxySignature(targetUrl, stableExp);
        const params = new URLSearchParams({
          url: targetUrl,
          exp: String(stableExp),
          sig,
        });
        return `${normalizedBase}/api/proxy/stream?${params.toString()}`;
      }
    } catch {
      // Fallback para /api/proxy/stream local
    }
  }
  return buildSignedProxyPath(targetUrl, undefined, nowSeconds);
}

export function detectImageMagicMime(bytes: Uint8Array): SupportedThumbnailMime | null {
  if (!bytes || bytes.length < 12) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

export function buildThumbnailBlobPathname(
  animeName: string | null | undefined,
  episodeId: string | null | undefined,
  ext: 'jpg' | 'webp' | 'png' = 'jpg'
): string {
  const rawAnime = typeof animeName === 'string' ? animeName.trim() : '';
  const animeSlug = rawAnime
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  const rawEpId = typeof episodeId === 'string' ? episodeId.trim() : '';
  const safeEpId = rawEpId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'novo';
  const animeSegment = animeSlug || 'sem-anime';
  return `thumbnails/${animeSegment}/${safeEpId}.${ext}`;
}

export interface ResolveThumbnailSourceInput {
  episodeId?: string | null;
  videoUrl?: string | null;
  sourceKind?: ExplicitSourceKind | '' | null;
}

export interface ResolveThumbnailSourceDeps {
  getEpisodeById?: (id: string) => Promise<PlayerEpisode | null>;
  isDbConfigured?: () => boolean;
  resolveBunny?: typeof resolveBunnyStreamSource;
  signProxyUrl?: (targetUrl: string) => string;
}

function collectSourcesFromEpisode(ep: PlayerEpisode): ThumbnailSourceInput[] {
  const slots: Array<{
    slot: 1 | 2 | 3 | 4 | 5;
    url: string | null | undefined;
    kind: ExplicitSourceKind | null | undefined;
    isMirror: boolean | null | undefined;
  }> = [
    { slot: 1, url: ep.video_url, kind: ep.source_kind, isMirror: ep.is_mirror },
    { slot: 2, url: ep.video_url_2, kind: ep.source_kind_2, isMirror: ep.is_mirror_2 },
    { slot: 3, url: ep.video_url_3, kind: ep.source_kind_3, isMirror: ep.is_mirror_3 },
    { slot: 4, url: ep.video_url_4, kind: ep.source_kind_4, isMirror: ep.is_mirror_4 },
    { slot: 5, url: ep.video_url_5, kind: ep.source_kind_5, isMirror: ep.is_mirror_5 },
  ];

  return slots
    .filter((item): item is { slot: 1 | 2 | 3 | 4 | 5; url: string; kind: ExplicitSourceKind | null | undefined; isMirror: boolean | null | undefined } =>
      Boolean(item.url && item.url.trim())
    )
    .map((item) => ({
      slot: item.slot,
      url: item.url.trim(),
      kind: item.kind ?? null,
      isMirror: Boolean(item.isMirror || isVercelBlobUrl(item.url)),
    }));
}

export async function resolveThumbnailSourceForAdmin(
  input: ResolveThumbnailSourceInput,
  deps: ResolveThumbnailSourceDeps = {}
): Promise<ThumbnailSourcePlan> {
  const candidateSources: ThumbnailSourceInput[] = [];

  const formVideoUrl = input.videoUrl?.trim();
  if (formVideoUrl) {
    candidateSources.push({
      slot: 1,
      url: formVideoUrl,
      kind: input.sourceKind || null,
      isMirror: isVercelBlobUrl(formVideoUrl),
      isFormSource: true,
    });
  }

  const episodeId = input.episodeId?.trim();
  const dbReady = deps.isDbConfigured ? deps.isDbConfigured() : isDatabaseConfigured();
  if (episodeId && dbReady) {
    const loadEp = deps.getEpisodeById ?? getEpisodeById;
    try {
      const ep = await loadEp(episodeId);
      if (ep) {
        candidateSources.push(...collectSourcesFromEpisode(ep));
      }
    } catch {
      // Continua usando a URL informada no formulário caso o lookup falhe
    }
  }

  const picked = pickBestThumbnailCandidate(candidateSources);
  if (!picked) {
    return {
      ok: false,
      mode: 'incompatible',
      sourceKind: 'unknown',
      sourceLabel: 'Nenhuma fonte válida',
      sourceUrl: '',
      directUrl: null,
      proxyUrl: null,
      blobPreferred: false,
      reason: 'Informe uma URL de vídeo válida antes de gerar thumbnails.',
    };
  }

  const signProxy = deps.signProxyUrl ?? ((url: string) => resolveProxyUrlWithOptionalWorker(url));

  if (picked.kind === 'bunny' && picked.requiresServerResolve) {
    const resolveBunny = deps.resolveBunny ?? resolveBunnyStreamSource;
    try {
      const bunnyRes = await resolveBunny(picked.rawUrl);
      if (bunnyRes.ok && bunnyRes.hlsUrl) {
        return {
          ok: true,
          mode: 'hls',
          sourceKind: 'hls',
          sourceLabel: 'Bunny Stream · HLS',
          sourceUrl: bunnyRes.hlsUrl,
          directUrl: bunnyRes.hlsUrl,
          proxyUrl: signProxy(bunnyRes.hlsUrl),
          blobPreferred: false,
        };
      }
      return {
        ok: false,
        mode: 'incompatible',
        sourceKind: 'bunny',
        sourceLabel: picked.formatLabel,
        sourceUrl: picked.rawUrl,
        directUrl: null,
        proxyUrl: null,
        blobPreferred: false,
        reason:
          bunnyRes.reason ||
          buildIncompatibleEmbedMessage('Bunny Stream protegido'),
      };
    } catch {
      return {
        ok: false,
        mode: 'incompatible',
        sourceKind: 'bunny',
        sourceLabel: picked.formatLabel,
        sourceUrl: picked.rawUrl,
        directUrl: null,
        proxyUrl: null,
        blobPreferred: false,
        reason: buildIncompatibleEmbedMessage('Bunny Stream'),
      };
    }
  }

  if (picked.kind === 'iframe') {
    let hostHint = '';
    try {
      hostHint = new URL(picked.resolvedUrl).hostname;
    } catch {
      hostHint = '';
    }
    return {
      ok: false,
      mode: 'incompatible',
      sourceKind: 'iframe',
      sourceLabel: picked.formatLabel,
      sourceUrl: picked.resolvedUrl,
      directUrl: null,
      proxyUrl: null,
      blobPreferred: false,
      reason: buildIncompatibleEmbedMessage(hostHint),
    };
  }

  if (picked.kind === 'hls') {
    return {
      ok: true,
      mode: 'hls',
      sourceKind: 'hls',
      sourceLabel: picked.formatLabel,
      sourceUrl: picked.resolvedUrl,
      directUrl: picked.resolvedUrl,
      proxyUrl: signProxy(picked.resolvedUrl),
      blobPreferred: picked.isBlob,
    };
  }

  // mp4 or webm
  return {
    ok: true,
    mode: 'direct',
    sourceKind: picked.kind,
    sourceLabel: picked.formatLabel,
    sourceUrl: picked.resolvedUrl,
    directUrl: picked.resolvedUrl,
    proxyUrl: signProxy(picked.resolvedUrl),
    blobPreferred: picked.isBlob,
  };
}

export interface ThumbnailUploadDeps {
  verifyAdmin?: typeof verifyAdminRequest;
  putBlob?: typeof put;
  blobToken?: string;
}

export async function handleThumbnailUploadRequest(
  request: Request,
  deps: ThumbnailUploadDeps = {}
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

  const token = (deps.blobToken ?? process.env.BLOB_READ_WRITE_TOKEN ?? '').trim();
  if (!token) {
    return Response.json(
      {
        ok: false,
        error:
          'BLOB_READ_WRITE_TOKEN não configurado no servidor para salvar a thumbnail escolhida.',
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json(
      { ok: false, error: 'Envio inválido. Utilize multipart/form-data com o arquivo de imagem.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const fileEntry = formData.get('file');
  if (!fileEntry || typeof fileEntry === 'string' || typeof fileEntry.arrayBuffer !== 'function') {
    return Response.json(
      { ok: false, error: 'Arquivo de thumbnail ausente no envio.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (fileEntry.size <= 0 || fileEntry.size > MAX_THUMBNAIL_UPLOAD_BYTES) {
    return Response.json(
      {
        ok: false,
        error: `Imagem inválida ou excede o limite de ${Math.round(MAX_THUMBNAIL_UPLOAD_BYTES / 1024)} KB.`,
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const bytes = new Uint8Array(await fileEntry.arrayBuffer());
  if (bytes.length <= 0 || bytes.length > MAX_THUMBNAIL_UPLOAD_BYTES) {
    return Response.json(
      { ok: false, error: 'Tamanho do arquivo de thumbnail fora dos limites permitidos.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const verifiedMime = detectImageMagicMime(bytes);
  if (!verifiedMime) {
    return Response.json(
      { ok: false, error: 'Formato de imagem não suportado. Use JPEG, WebP ou PNG.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const animeNameRaw = formData.get('animeName');
  const episodeIdRaw = formData.get('episodeId');
  const pathname = buildThumbnailBlobPathname(
    typeof animeNameRaw === 'string' ? animeNameRaw : '',
    typeof episodeIdRaw === 'string' ? episodeIdRaw : '',
    MIME_TO_EXT[verifiedMime]
  );

  const putBlob = deps.putBlob ?? put;
  try {
    const result = await putBlob(pathname, Buffer.from(bytes), {
      access: 'public',
      addRandomSuffix: true,
      contentType: verifiedMime,
      token,
    });

    return Response.json(
      {
        ok: true,
        url: result.url,
        pathname: result.pathname || pathname,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? `Falha ao enviar thumbnail para o Vercel Blob: ${err.message}`
            : 'Falha ao enviar thumbnail para o Vercel Blob.',
      },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
