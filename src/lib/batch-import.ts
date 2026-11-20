import { resolveEmbedProxy } from '@/lib/embed-proxy';
import {
  classifyEmbedHost,
  detectSourceKind,
  type ExplicitSourceKind,
  validateHttpUrl,
} from '@/lib/video-sources';

export const BATCH_MAX_ITEMS = 100;
export const BATCH_ITEM_DELAY_MS = 400;
export const BATCH_JOB_STORAGE_KEY = 'player_admin_batch_import_job_v1';

export type BatchImportMode = 'validate' | 'validate_and_save';
export type BatchVerdict = 'aprovado' | 'reprovado';
export type BatchSaveStatus = 'salvo' | 'skipado';

export interface ParsedBatchLine {
  lineNumber: number;
  rawLine: string;
  episodeId: string;
  url: string;
  explicitKind: ExplicitSourceKind | null;
  parseError: string | null;
}

export interface BatchItemReport {
  lineNumber: number;
  episodeId: string;
  url: string;
  explicitKind: ExplicitSourceKind | null;
  verdict: BatchVerdict;
  saveStatus: BatchSaveStatus;
  savedSlot: 1 | 2 | 3 | 4 | 5 | null;
  reason: string;
}

export interface BatchJobTotals {
  total: number;
  processed: number;
  aprovados: number;
  reprovados: number;
  salvos: number;
}

export interface BatchImportJobState {
  id: string;
  rawInput: string;
  mode: BatchImportMode;
  items: ParsedBatchLine[];
  lastProcessedIndex: number;
  results: BatchItemReport[];
  status: 'idle' | 'running' | 'paused' | 'completed';
  updatedAt: string;
}

export interface EpisodeSlotRecord {
  id: string;
  video_url: string;
  video_url_2: string | null;
  video_url_3: string | null;
  video_url_4: string | null;
  video_url_5: string | null;
  source_kind: ExplicitSourceKind | null;
  source_kind_2: ExplicitSourceKind | null;
  source_kind_3: ExplicitSourceKind | null;
  source_kind_4: ExplicitSourceKind | null;
  source_kind_5: ExplicitSourceKind | null;
}

export type EpisodeSlotInsertionPlan =
  | {
      action: 'save';
      slot: 1 | 2 | 3 | 4 | 5;
      reason: string;
      patch: {
        video_url?: string;
        video_url_2?: string | null;
        video_url_3?: string | null;
        video_url_4?: string | null;
        video_url_5?: string | null;
        source_kind?: ExplicitSourceKind | null;
        source_kind_2?: ExplicitSourceKind | null;
        source_kind_3?: ExplicitSourceKind | null;
        source_kind_4?: ExplicitSourceKind | null;
        source_kind_5?: ExplicitSourceKind | null;
      };
    }
  | {
      action: 'skip';
      slot: null;
      reason: string;
    };

export interface BatchValidateDeps {
  embedFetchImpl?: typeof fetch;
  embedAssertSafeUrl?: (rawUrl: string) => Promise<URL>;
  probeDirectHost?: (url: string) => Promise<{ status: number | null; error?: string | null }>;
}

export interface BatchValidationResult {
  verdict: BatchVerdict;
  normalizedUrl: string | null;
  resolvedKind: ExplicitSourceKind | null;
  reason: string;
}

const EPISODE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export function parseBatchInputLines(rawText: string): ParsedBatchLine[] {
  const lines = rawText.split(/\r?\n/);
  const parsed: ParsedBatchLine[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const lineNumber = idx + 1;
    const parts = trimmed.split(';').map((part) => part.trim());

    if (parts.length < 2 || parts.length > 3) {
      parsed.push({
        lineNumber,
        rawLine: trimmed,
        episodeId: parts[0] || '',
        url: parts[1] || '',
        explicitKind: null,
        parseError: 'Formato inválido. Use: <id_do_episodio> ; <url> [; <kind>]',
      });
      continue;
    }

    const [episodeId, url, rawKind = ''] = parts;

    if (!episodeId || !EPISODE_ID_REGEX.test(episodeId)) {
      parsed.push({
        lineNumber,
        rawLine: trimmed,
        episodeId,
        url,
        explicitKind: null,
        parseError: 'ID do episódio inválido.',
      });
      continue;
    }

    if (!url) {
      parsed.push({
        lineNumber,
        rawLine: trimmed,
        episodeId,
        url: '',
        explicitKind: null,
        parseError: 'URL ausente.',
      });
      continue;
    }

    const lowerKind = rawKind.toLowerCase();
    let explicitKind: ExplicitSourceKind | null = null;
    if (lowerKind && lowerKind !== 'auto') {
      if (lowerKind === 'iframe' || lowerKind === 'hls' || lowerKind === 'mp4') {
        explicitKind = lowerKind;
      } else {
        parsed.push({
          lineNumber,
          rawLine: trimmed,
          episodeId,
          url,
          explicitKind: null,
          parseError: `Kind inválido ("${rawKind}"). Use auto, iframe, hls ou mp4.`,
        });
        continue;
      }
    }

    parsed.push({
      lineNumber,
      rawLine: trimmed,
      episodeId,
      url,
      explicitKind,
      parseError: null,
    });
  }

  return parsed;
}

export async function validateBatchIframeItem(
  item: ParsedBatchLine,
  deps: BatchValidateDeps = {}
): Promise<BatchValidationResult> {
  if (item.parseError) {
    return {
      verdict: 'reprovado',
      normalizedUrl: null,
      resolvedKind: null,
      reason: item.parseError,
    };
  }

  const urlCheck = validateHttpUrl(item.url);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    return {
      verdict: 'reprovado',
      normalizedUrl: null,
      resolvedKind: null,
      reason: urlCheck.error ?? 'URL inválida.',
    };
  }

  const parsedUrl = new URL(urlCheck.normalizedUrl);
  if (parsedUrl.protocol !== 'https:') {
    return {
      verdict: 'reprovado',
      normalizedUrl: urlCheck.normalizedUrl,
      resolvedKind: null,
      reason: 'Apenas URLs HTTPS são permitidas.',
    };
  }

  const resolvedKind = detectSourceKind(urlCheck.normalizedUrl, item.explicitKind);
  if (resolvedKind !== 'iframe') {
    return {
      verdict: 'reprovado',
      normalizedUrl: urlCheck.normalizedUrl,
      resolvedKind,
      reason: 'não é página de player',
    };
  }

  const hostCategory = classifyEmbedHost(urlCheck.normalizedUrl);
  if (hostCategory === 'direct') {
    if (deps.probeDirectHost) {
      const probe = await deps.probeDirectHost(urlCheck.normalizedUrl);
      const statusNote =
        probe.status === 403
          ? ' (HTTP 403 do WAF ignorado)'
          : probe.status !== null
            ? ` (HTTP ${probe.status})`
            : '';
      return {
        verdict: 'aprovado',
        normalizedUrl: urlCheck.normalizedUrl,
        resolvedKind,
        reason: `Aprovado por allowlist (${parsedUrl.hostname})${statusNote}.`,
      };
    }

    return {
      verdict: 'aprovado',
      normalizedUrl: urlCheck.normalizedUrl,
      resolvedKind,
      reason: `Aprovado por allowlist (${parsedUrl.hostname}).`,
    };
  }

  if (hostCategory === 'proxied') {
    try {
      const embedReq = new Request(
        `https://local.test/api/embed?u=${encodeURIComponent(urlCheck.normalizedUrl)}`,
        { method: 'GET' }
      );
      const embedResult = await resolveEmbedProxy(embedReq, {
        fetchImpl: deps.embedFetchImpl,
        assertSafeUrl: deps.embedAssertSafeUrl,
      });

      const status = embedResult.response.status;
      if (status === 200) {
        if (embedResult.response.body) {
          try {
            await embedResult.response.body.cancel();
          } catch {
            // ignore
          }
        }
        return {
          verdict: 'aprovado',
          normalizedUrl: urlCheck.normalizedUrl,
          resolvedKind,
          reason: 'Aprovado via /api/embed (HTTP 200).',
        };
      }

      const errorHtml = await embedResult.response.text();
      const match = /<p>([^<]+)<\/p>/i.exec(errorHtml);
      const detail = match?.[1]
        ? match[1]
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
        : `HTTP ${status}`;

      return {
        verdict: 'reprovado',
        normalizedUrl: urlCheck.normalizedUrl,
        resolvedKind,
        reason: `Falha no /api/embed (HTTP ${status}): ${detail}`,
      };
    } catch (err) {
      return {
        verdict: 'reprovado',
        normalizedUrl: urlCheck.normalizedUrl,
        resolvedKind,
        reason:
          err instanceof Error
            ? `Falha no /api/embed: ${err.message}`
            : 'Falha ao validar via /api/embed.',
      };
    }
  }

  return {
    verdict: 'reprovado',
    normalizedUrl: urlCheck.normalizedUrl,
    resolvedKind,
    reason: 'host não mapeado',
  };
}

function normalizeComparableUrl(rawUrl: string | null | undefined): string {
  const trimmed = rawUrl?.trim() ?? '';
  if (!trimmed) return '';
  const check = validateHttpUrl(trimmed);
  return check.valid && check.normalizedUrl ? check.normalizedUrl : trimmed;
}

export function planEpisodeSlotInsertion(
  episode: EpisodeSlotRecord,
  newNormalizedUrl: string,
  kind: ExplicitSourceKind = 'iframe'
): EpisodeSlotInsertionPlan {
  const targetComparable = normalizeComparableUrl(newNormalizedUrl);

  const slots: Array<{
    slot: 1 | 2 | 3 | 4 | 5;
    url: string | null | undefined;
  }> = [
    { slot: 1, url: episode.video_url },
    { slot: 2, url: episode.video_url_2 },
    { slot: 3, url: episode.video_url_3 },
    { slot: 4, url: episode.video_url_4 },
    { slot: 5, url: episode.video_url_5 },
  ];

  for (const entry of slots) {
    const existing = normalizeComparableUrl(entry.url);
    if (existing && existing === targetComparable) {
      return {
        action: 'skip',
        slot: null,
        reason: `URL duplicada (já cadastrada no Player ${entry.slot}).`,
      };
    }
  }

  for (const entry of slots) {
    if (!entry.url || !entry.url.trim()) {
      const slot = entry.slot;
      const urlKey = slot === 1 ? 'video_url' : (`video_url_${slot}` as const);
      const kindKey = slot === 1 ? 'source_kind' : (`source_kind_${slot}` as const);
      return {
        action: 'save',
        slot,
        reason: `Salvo no Player ${slot}.`,
        patch: {
          [urlKey]: targetComparable,
          [kindKey]: kind,
        },
      };
    }
  }

  return {
    action: 'skip',
    slot: null,
    reason: 'Todos os 5 slots de player já estão ocupados.',
  };
}

export function computeBatchTotals(
  totalItems: number,
  results: readonly BatchItemReport[]
): BatchJobTotals {
  let aprovados = 0;
  let reprovados = 0;
  let salvos = 0;

  for (const row of results) {
    if (row.verdict === 'aprovado') {
      aprovados += 1;
    } else {
      reprovados += 1;
    }
    if (row.saveStatus === 'salvo') {
      salvos += 1;
    }
  }

  return {
    total: totalItems,
    processed: results.length,
    aprovados,
    reprovados,
    salvos,
  };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function saveBatchJobState(
  state: BatchImportJobState,
  storage?: StorageLike | null
): void {
  const targetStorage =
    storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
  if (!targetStorage) return;
  try {
    targetStorage.setItem(BATCH_JOB_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignora falha de quota em storage
  }
}

export function loadBatchJobState(storage?: StorageLike | null): BatchImportJobState | null {
  const targetStorage =
    storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
  if (!targetStorage) return null;
  try {
    const raw = targetStorage.getItem(BATCH_JOB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BatchImportJobState;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.items) ||
      !Array.isArray(parsed.results) ||
      typeof parsed.lastProcessedIndex !== 'number'
    ) {
      return null;
    }
    return {
      ...parsed,
      status: parsed.status === 'running' ? 'paused' : parsed.status,
    };
  } catch {
    return null;
  }
}

export function clearBatchJobState(storage?: StorageLike | null): void {
  const targetStorage =
    storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
  if (!targetStorage) return;
  try {
    targetStorage.removeItem(BATCH_JOB_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function hasPendingBatchResume(job: BatchImportJobState | null): boolean {
  if (!job || job.items.length === 0) return false;
  return job.status !== 'completed' && job.lastProcessedIndex < job.items.length - 1;
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RunBatchSequenceParams {
  items: ParsedBatchLine[];
  startIndex: number;
  processItem: (item: ParsedBatchLine, index: number) => Promise<BatchItemReport>;
  onItemComplete: (index: number, report: BatchItemReport) => void;
  shouldStop?: () => boolean;
  delayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export async function runBatchSequence(
  params: RunBatchSequenceParams
): Promise<{ completed: boolean; lastProcessedIndex: number; results: BatchItemReport[] }> {
  const {
    items,
    startIndex,
    processItem,
    onItemComplete,
    shouldStop,
    delayMs = BATCH_ITEM_DELAY_MS,
    sleepFn = sleepMs,
  } = params;

  const collected: BatchItemReport[] = [];
  let lastIndex = startIndex - 1;

  for (let idx = Math.max(0, startIndex); idx < items.length; idx++) {
    if (shouldStop?.()) {
      return { completed: false, lastProcessedIndex: lastIndex, results: collected };
    }

    const report = await processItem(items[idx], idx);
    collected.push(report);
    lastIndex = idx;
    onItemComplete(idx, report);

    if (idx < items.length - 1) {
      if (shouldStop?.()) {
        return { completed: false, lastProcessedIndex: lastIndex, results: collected };
      }
      if (delayMs > 0) {
        await sleepFn(delayMs);
      }
    }
  }

  return {
    completed: !shouldStop?.(),
    lastProcessedIndex: lastIndex,
    results: collected,
  };
}
