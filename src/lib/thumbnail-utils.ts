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
  requiresServerResolve: boolean
): number {
  if (isBlob) return 0; // Always highest priority: Vercel Blob mirror
  if (kind === 'mp4' || kind === 'webm') return 1;
  if (kind === 'hls' && !requiresServerResolve) return 2;
  if (kind === 'bunny' || requiresServerResolve) return 3;
  return 4; // iframe embeds
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
    const score = getCandidatePriorityScore(isBlob, normalized.kind, normalized.requiresServerResolve);

    candidates.push({
      score,
      order: index,
      data: {
        slot,
        rawUrl: normalized.rawUrl,
        resolvedUrl: normalized.resolvedUrl,
        kind: normalized.kind,
        formatLabel: isBlob ? `${normalized.kind.toUpperCase()} · Vercel Blob` : normalized.formatLabel,
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

export function buildIncompatibleEmbedMessage(urlOrHostHint?: string): string {
  const suffix = urlOrHostHint ? ` (${urlOrHostHint})` : '';
  return `Esta fonte usa um embed externo${suffix} que bloqueia a captura de frames pelo navegador (CORS/restrição de origem). Gere uma cópia no Vercel Blob, informe uma URL direta MP4/WebM/M3U8 ou preencha a capa manualmente.`;
}
