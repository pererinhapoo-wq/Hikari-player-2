import {
  classifyEmbedHost,
  type ExplicitSourceKind,
  isVercelBlobUrl,
  normalizeVideoSource,
  type SourceKind,
  validateHttpUrl,
} from '@/lib/video-sources';

export const THUMBNAIL_DEFAULT_COUNT = 6;
export const THUMBNAIL_MIN_COUNT = 5;
export const MAX_THUMBNAIL_UPLOAD_BYTES = 512 * 1024; // 512 KB

export interface ThumbnailSourceInput {
  slot?: number;
  url: string;
  kind?: ExplicitSourceKind | string | null;
  isMirror?: boolean | null;
  isFormSource?: boolean | null;
}

export interface ThumbnailSourcePlan {
  ok: boolean;
  mode: 'direct' | 'hls' | 'incompatible';
  sourceKind: SourceKind | 'unknown';
  sourceLabel: string;
  sourceUrl: string;
  directUrl: string | null;
  proxyUrl: string | null;
  blobPreferred: boolean;
  needsBunnyResolve?: boolean;
  reason?: string;
}

export interface GeneratedThumbnailCandidate {
  id: string;
  timestampSeconds: number;
  timestampLabel: string;
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
}

const DEFAULT_RATIOS_6 = [0.1, 0.25, 0.42, 0.58, 0.75, 0.88] as const;
const DEFAULT_RATIOS_5 = [0.12, 0.3, 0.5, 0.7, 0.88] as const;

export function buildThumbnailTimestamps(
  durationSeconds: number,
  count: number = THUMBNAIL_DEFAULT_COUNT
): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [];
  }

  const targetCount = Math.max(THUMBNAIL_MIN_COUNT, Math.min(THUMBNAIL_DEFAULT_COUNT, Math.round(count)));
  const ratios = targetCount === 5 ? DEFAULT_RATIOS_5 : DEFAULT_RATIOS_6;

  // For ultra-short videos (< 1.5s), distribute safely inside (0, duration)
  const minTime = durationSeconds >= 4 ? 0.5 : Math.min(0.1, durationSeconds * 0.08);
  const maxTime =
    durationSeconds >= 4
      ? Math.max(minTime, durationSeconds - 0.5)
      : Math.max(minTime, durationSeconds * 0.94);

  const results: number[] = [];
  for (const ratio of ratios) {
    const raw = durationSeconds * ratio;
    const clamped = Math.max(minTime, Math.min(maxTime, raw));
    const rounded = Math.round(clamped * 100) / 100;
    if (results.length === 0 || rounded > results[results.length - 1] + 0.04) {
      results.push(rounded);
    }
  }

  return results;
}

export function formatThumbnailTimeLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

function getCandidatePriorityScore(
  isBlob: boolean,
  kind: SourceKind,
  requiresServerResolve: boolean,
  isFormSource: boolean
): number {
  if (isFormSource) {
    if (kind === 'mp4' || kind === 'webm' || kind === 'hls' || kind === 'bunny') {
      return 0; // Current form source has top priority when extractable
    }
    return 10; // Form source is an iframe embed that cannot extract frames directly
  }
  if (isBlob) return 1; // Existing episode Vercel Blob mirror
  if (kind === 'mp4' || kind === 'webm') return 2;
  if (kind === 'hls' && !requiresServerResolve) return 3;
  if (kind === 'bunny' || requiresServerResolve) return 4;
  return 11; // Other iframe embeds
}

export interface PickedThumbnailCandidate {
  slot: 1 | 2 | 3 | 4 | 5;
  rawUrl: string;
  resolvedUrl: string;
  kind: SourceKind;
  formatLabel: string;
  isBlob: boolean;
  requiresServerResolve: boolean;
  embedMode: 'direct' | 'proxied' | 'other';
}

function isExplicitHlsPlaylistUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname.toLowerCase();
    return /\.(m3u8|m3u)$/i.test(path) || path.includes('/index.m3u8') || path.includes('/index.m3u');
  } catch {
    return /\.(m3u8|m3u)(?:[?#]|$)/i.test(rawUrl) || rawUrl.includes('/index.m3u8');
  }
}

export function pickBestThumbnailCandidate(
  sources: ThumbnailSourceInput[]
): PickedThumbnailCandidate | null {
  const seen = new Set<string>();
  const candidates: Array<{ score: number; order: number; data: PickedThumbnailCandidate }> = [];

  sources.forEach((entry, index) => {
    const trimmed = entry.url?.trim();
    if (!trimmed) return;
    const validation = validateHttpUrl(trimmed);
    if (!validation.valid || !validation.normalizedUrl) return;
    if (seen.has(validation.normalizedUrl)) return;
    seen.add(validation.normalizedUrl);

    const slot = ([1, 2, 3, 4, 5].includes(Number(entry.slot)) ? Number(entry.slot) : 1) as
      | 1
      | 2
      | 3
      | 4
      | 5;
    const normalized = normalizeVideoSource(validation.normalizedUrl, slot, entry.kind ?? null);
    if (!normalized) return;

    const isBlob = isVercelBlobUrl(normalized.resolvedUrl) || isVercelBlobUrl(normalized.rawUrl);
    const effectiveKind: SourceKind =
      !isBlob && isExplicitHlsPlaylistUrl(normalized.resolvedUrl) ? 'hls' : normalized.kind;
    const score = getCandidatePriorityScore(
      isBlob,
      effectiveKind,
      normalized.requiresServerResolve,
      Boolean(entry.isFormSource)
    );

    const formatLabel = isBlob
      ? effectiveKind === 'mp4'
        ? 'MP4 Vercel Blob'
        : effectiveKind === 'hls'
          ? 'HLS Vercel Blob'
          : `${effectiveKind.toUpperCase()} Vercel Blob`
      : effectiveKind === 'hls'
        ? (normalized.rawUrl.includes('.m3u8') ? 'M3U8 externo' : 'HLS externo')
        : effectiveKind === 'mp4'
          ? 'MP4 externo'
          : effectiveKind === 'webm'
            ? 'WebM'
            : normalized.formatLabel;

    candidates.push({
      score,
      order: index,
      data: {
        slot,
        rawUrl: normalized.rawUrl,
        resolvedUrl: normalized.resolvedUrl,
        kind: effectiveKind,
        formatLabel,
        isBlob,
        requiresServerResolve: normalized.requiresServerResolve,
        embedMode: classifyEmbedHost(normalized.resolvedUrl),
      },
    });
  });

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => a.score - b.score || a.order - b.order);
  return candidates[0].data;
}

export interface HlsLevelSummary {
  height?: number;
  width?: number;
  bitrate?: number;
  videoCodec?: string;
}

export function pickPreferredHlsLevelIndex(levels: ReadonlyArray<HlsLevelSummary>): number {
  if (!levels || levels.length <= 1) return levels.length === 1 ? 0 : -1;

  const annotated = levels.map((lvl, index) => ({
    index,
    height: typeof lvl.height === 'number' && lvl.height > 0 ? lvl.height : 0,
    bitrate: typeof lvl.bitrate === 'number' && lvl.bitrate > 0 ? lvl.bitrate : Number.MAX_SAFE_INTEGER,
    codec: (lvl.videoCodec ?? '').toLowerCase(),
  }));

  // Prefer H.264/AVC variants when available for widest browser canvas/MSE compatibility
  const avcLevels = annotated.filter((l) => !l.codec || l.codec.includes('avc1'));
  const pool = avcLevels.length > 0 ? avcLevels : annotated;

  // Ideal for 640px thumbnail capture: smallest variant >= 360p (fast download, crisp frame)
  const sdOrHd = pool
    .filter((l) => l.height >= 360)
    .sort((a, b) => a.height - b.height || a.bitrate - b.bitrate);

  if (sdOrHd.length > 0) {
    return sdOrHd[0].index;
  }

  // Fallback to highest available if all are < 360p or lack height metadata
  const byBitrate = [...pool].sort((a, b) => a.bitrate - b.bitrate);
  return byBitrate[0]?.index ?? 0;
}

export interface HlsThumbnailErrorInput {
  type?: string;
  details?: string;
  httpCode?: number;
}

export function classifyHlsThumbnailError(input: HlsThumbnailErrorInput): string {
  const type = (input.type ?? '').toLowerCase();
  const details = (input.details ?? '').toLowerCase();
  const httpCode =
    typeof input.httpCode === 'number' && Number.isFinite(input.httpCode) && input.httpCode > 0
      ? input.httpCode
      : null;

  if (details.includes('manifestload') || details.includes('levelload') || details.includes('audiotrackload')) {
    if (httpCode === 401 || httpCode === 403 || httpCode === 451) {
      return `Playlist M3U8 bloqueada ou com acesso negado pelo servidor externo (HTTP ${httpCode}).`;
    }
    if (httpCode === 404 || httpCode === 410) {
      return `Playlist M3U8 não encontrada no servidor externo (HTTP ${httpCode}).`;
    }
    if (httpCode !== null && httpCode >= 500) {
      return `Erro no servidor externo ou proxy ao carregar a playlist M3U8 (HTTP ${httpCode}).`;
    }
    if (details.includes('timeout')) {
      return 'Tempo limite esgotado ao carregar a playlist M3U8.';
    }
    return 'Playlist M3U8 inacessível ou bloqueada pelo servidor externo.';
  }

  if (details.includes('manifestparsing') || details.includes('levelparsing')) {
    return 'A URL não retornou uma playlist M3U8 válida (conteúdo inválido ou página de erro HTML).';
  }

  if (
    details.includes('fragload') ||
    details.includes('keyload') ||
    details.includes('internalexception')
  ) {
    if (httpCode === 401 || httpCode === 403 || httpCode === 451) {
      return `Servidor externo bloqueou o carregamento dos segmentos de vídeo (HTTP ${httpCode}).`;
    }
    if (httpCode === 404 || httpCode === 410) {
      return `Segmentos de vídeo da playlist M3U8 não encontrados (HTTP ${httpCode}).`;
    }
    if (httpCode !== null && httpCode >= 500) {
      return `Falha ao carregar segmentos de vídeo da playlist M3U8 (HTTP ${httpCode}).`;
    }
    if (details.includes('timeout')) {
      return 'Tempo limite esgotado ao baixar os segmentos de vídeo da playlist M3U8.';
    }
    return 'Falha ao carregar os segmentos de vídeo da playlist M3U8.';
  }

  if (
    type === 'mediaerror' ||
    details.includes('bufferaddcodec') ||
    details.includes('incompatiblecodecs') ||
    details.includes('fragparsing') ||
    details.includes('bufferappend')
  ) {
    return 'Formato ou codec do stream M3U8 incompatível com a captura no navegador.';
  }

  if (type === 'networkerror') {
    return 'Falha de rede ao carregar o stream M3U8.';
  }

  return 'Erro no motor HLS.js ao processar a playlist M3U8.';
}

export function buildIncompatibleEmbedMessage(urlOrHostHint?: string): string {
  const suffix = urlOrHostHint ? ` (${urlOrHostHint})` : '';
  return `Esta fonte usa um embed externo${suffix} que bloqueia a captura de frames pelo navegador (CORS/restrição de origem). Gere uma cópia no Vercel Blob, informe uma URL direta MP4/WebM/M3U8 ou preencha a capa manualmente.`;
}
