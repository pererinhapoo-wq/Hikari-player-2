import type { HlsDiagnosticInfo, HlsErrorInput, PlaybackStrategy } from '@/lib/hls-playback';
import type { PlayableSource } from '@/lib/types';

export type PlaybackSourceCategory =
  | 'mp4_direct'
  | 'webm_direct'
  | 'hls_m3u8'
  | 'maximaimg'
  | 'bunny_mux'
  | 'iframe'
  | 'proxy'
  | 'other';

export const PLAYBACK_SOURCE_CATEGORY_LABELS: Record<PlaybackSourceCategory, string> = {
  mp4_direct: 'MP4 direto',
  webm_direct: 'WebM direto',
  hls_m3u8: 'HLS/M3U8',
  maximaimg: 'Maximaimg',
  bunny_mux: 'Bunny/Mux',
  iframe: 'Iframe',
  proxy: 'Proxy',
  other: 'Outras fontes',
};

export type PlaybackDeliveryMode = 'proxy' | 'direct' | 'iframe';

export type PlaybackDiagnosticEventType =
  | 'play_clicked'
  | 'initial_loaded'
  | 'playback_started'
  | 'buffering'
  | 'network_error'
  | 'timeout'
  | 'http_error'
  | 'manifest_load_error'
  | 'segment_load_error'
  | 'hls_retry_scheduled'
  | 'hls_recovery_media'
  | 'hls_recovery_succeeded'
  | 'failover'
  | 'source_switch'
  | 'fatal_playback_failure'
  | 'playback_completed';

export type PlaybackSwitchReason = 'manual' | 'failover' | 'direct_fallback' | 'mux_embed';

export type HlsResourceType = 'manifest' | 'segment';

export interface PlaybackDiagnosticEvent {
  type: PlaybackDiagnosticEventType;
  timestamp: number;
  sessionId: string;
  slot: 1 | 2 | 3 | 4 | 5;
  sourceCategory: PlaybackSourceCategory;
  deliveryMode: PlaybackDeliveryMode;
  httpStatus?: number | null;
  errorCode?: string | null;
  hlsResource?: HlsResourceType | null;
  durationMs?: number | null;
  attempt?: number | null;
  fromSlot?: (1 | 2 | 3 | 4 | 5) | null;
  toSlot?: (1 | 2 | 3 | 4 | 5) | null;
  switchReason?: PlaybackSwitchReason | null;
}

export interface PlaybackSourceCategoryBreakdown {
  category: PlaybackSourceCategory;
  label: string;
  playsStarted: number;
  errorCount: number;
  bufferingCount: number;
  failoverCount: number;
  fatalFailures: number;
}

export interface PlaybackDiagnosticsSummary {
  totalEvents: number;
  playsStarted: number;
  playsCompleted: number;
  failureRate: number | null;
  bufferingCount: number;
  averageStartupMs: number | null;
  averageInitialLoadMs: number | null;
  hlsRetryCount: number;
  hlsSuccessfulRecoveries: number;
  failoverCount: number;
  fatalFailures: number;
  networkErrors: number;
  timeoutErrors: number;
  manifestLoadErrors: number;
  segmentLoadErrors: number;
  httpErrorsByCode: {
    403: number;
    404: number;
    429: number;
    '5xx': number;
  };
  topErrorCategories: PlaybackSourceCategoryBreakdown[];
  categoryBreakdown: PlaybackSourceCategoryBreakdown[];
}

export const MAX_SESSION_DIAGNOSTIC_EVENTS = 60;
export const MAX_DIAGNOSTIC_BATCH_SIZE = 20;
export const DIAGNOSTIC_DEDUP_WINDOW_MS = 3000;
export const DIAGNOSTIC_FLUSH_INTERVAL_MS = 15000;

const VALID_EVENT_TYPES = new Set<PlaybackDiagnosticEventType>([
  'play_clicked',
  'initial_loaded',
  'playback_started',
  'buffering',
  'network_error',
  'timeout',
  'http_error',
  'manifest_load_error',
  'segment_load_error',
  'hls_retry_scheduled',
  'hls_recovery_media',
  'hls_recovery_succeeded',
  'failover',
  'source_switch',
  'fatal_playback_failure',
  'playback_completed',
]);

const VALID_SOURCE_CATEGORIES = new Set<PlaybackSourceCategory>([
  'mp4_direct',
  'webm_direct',
  'hls_m3u8',
  'maximaimg',
  'bunny_mux',
  'iframe',
  'proxy',
  'other',
]);

const VALID_DELIVERY_MODES = new Set<PlaybackDeliveryMode>(['proxy', 'direct', 'iframe']);

const VALID_SWITCH_REASONS = new Set<PlaybackSwitchReason>([
  'manual',
  'failover',
  'direct_fallback',
  'mux_embed',
]);

const SENSITIVE_PATTERN =
  /(https?:\/\/|\/api\/proxy\/stream|[?&](?:token|sig|xsig|rsig|exp|expires|auth|hmac|signature|hdnea|x-amz-[a-z-]+)=|\b\d{1,3}(?:\.\d{1,3}){3}\b|referer\s*:|cookie\s*:|set-cookie\s*:)/i;

export function containsSensitiveDiagnosticData(value: unknown): boolean {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (!serialized) return false;
    return SENSITIVE_PATTERN.test(serialized);
  } catch {
    return true;
  }
}

export function classifyPlaybackSourceCategory(
  source: Pick<PlayableSource, 'provider' | 'kind' | 'needsProxy'> | null | undefined,
  strategy?: PlaybackStrategy | null
): PlaybackSourceCategory {
  if (!source) return 'other';
  if (source.provider === 'maximaimg') return 'maximaimg';
  if (source.provider === 'bunny' || source.provider === 'mux') return 'bunny_mux';
  if (source.kind === 'iframe' || strategy === 'iframe') return 'iframe';
  if (strategy === 'proxy' || source.needsProxy) return 'proxy';
  if (source.kind === 'hls') return 'hls_m3u8';
  if (source.kind === 'mp4') return 'mp4_direct';
  if (source.kind === 'webm') return 'webm_direct';
  return 'other';
}

function normalizeSlot(raw: unknown): (1 | 2 | 3 | 4 | 5) | null {
  if (raw === 1 || raw === 2 || raw === 3 || raw === 4 || raw === 5) {
    return raw;
  }
  return null;
}

function sanitizeSafeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 40) return null;
  if (!/^[a-z0-9_]+$/.test(trimmed)) return null;
  if (containsSensitiveDiagnosticData(trimmed)) return null;
  return trimmed;
}

function sanitizeSessionId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^[a-zA-Z0-9_-]{6,48}$/.test(trimmed)) return null;
  return trimmed;
}

function sanitizeDurationMs(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return Math.min(3_600_000, Math.round(raw));
}

function sanitizeAttempt(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return null;
  return Math.min(20, Math.floor(raw));
}

function sanitizeHttpStatus(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const code = Math.floor(raw);
  if (code < 100 || code > 599) return null;
  return code;
}

export function sanitizeDiagnosticEvent(raw: unknown): PlaybackDiagnosticEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;

  if (!VALID_EVENT_TYPES.has(candidate.type as PlaybackDiagnosticEventType)) {
    return null;
  }

  const slot = normalizeSlot(candidate.slot);
  if (!slot) return null;

  const sessionId = sanitizeSessionId(candidate.sessionId);
  if (!sessionId) return null;

  const sourceCategory = VALID_SOURCE_CATEGORIES.has(
    candidate.sourceCategory as PlaybackSourceCategory
  )
    ? (candidate.sourceCategory as PlaybackSourceCategory)
    : 'other';

  const deliveryMode = VALID_DELIVERY_MODES.has(candidate.deliveryMode as PlaybackDeliveryMode)
    ? (candidate.deliveryMode as PlaybackDeliveryMode)
    : 'direct';

  const timestamp =
    typeof candidate.timestamp === 'number' &&
    Number.isFinite(candidate.timestamp) &&
    candidate.timestamp > 0
      ? Math.floor(candidate.timestamp)
      : Date.now();

  const sanitized: PlaybackDiagnosticEvent = {
    type: candidate.type as PlaybackDiagnosticEventType,
    timestamp,
    sessionId,
    slot,
    sourceCategory,
    deliveryMode,
  };

  const httpStatus = sanitizeHttpStatus(candidate.httpStatus);
  if (httpStatus !== null) sanitized.httpStatus = httpStatus;

  const errorCode = sanitizeSafeCode(candidate.errorCode);
  if (errorCode !== null) sanitized.errorCode = errorCode;

  if (candidate.hlsResource === 'manifest' || candidate.hlsResource === 'segment') {
    sanitized.hlsResource = candidate.hlsResource;
  }

  const durationMs = sanitizeDurationMs(candidate.durationMs);
  if (durationMs !== null) sanitized.durationMs = durationMs;

  const attempt = sanitizeAttempt(candidate.attempt);
  if (attempt !== null) sanitized.attempt = attempt;

  const fromSlot = normalizeSlot(candidate.fromSlot);
  if (fromSlot !== null) sanitized.fromSlot = fromSlot;

  const toSlot = normalizeSlot(candidate.toSlot);
  if (toSlot !== null) sanitized.toSlot = toSlot;

  if (VALID_SWITCH_REASONS.has(candidate.switchReason as PlaybackSwitchReason)) {
    sanitized.switchReason = candidate.switchReason as PlaybackSwitchReason;
  }

  if (containsSensitiveDiagnosticData(sanitized)) {
    return null;
  }

  return sanitized;
}

export function mapHlsErrorToDiagnostic(
  input: HlsErrorInput,
  diagnostic: HlsDiagnosticInfo
): {
  type: PlaybackDiagnosticEventType;
  errorCode: string;
  httpStatus: number | null;
  hlsResource: HlsResourceType | null;
} {
  const detailsLower = (input.details ?? diagnostic.details ?? '').toLowerCase();
  const httpStatus = sanitizeHttpStatus(input.httpCode ?? diagnostic.httpCode);

  const hlsResource: HlsResourceType | null =
    detailsLower.includes('manifest') || detailsLower.includes('level')
      ? 'manifest'
      : detailsLower.includes('frag') || detailsLower.includes('key')
        ? 'segment'
        : null;

  if (httpStatus !== null && (httpStatus === 403 || httpStatus === 404 || httpStatus === 429 || httpStatus >= 500)) {
    const errorCode =
      httpStatus === 403
        ? 'http_403'
        : httpStatus === 404
          ? 'http_404'
          : httpStatus === 429
            ? 'http_429'
            : 'http_5xx';
    return {
      type: 'http_error',
      errorCode,
      httpStatus,
      hlsResource,
    };
  }

  if (diagnostic.category === 'timeout' || detailsLower.includes('timeout')) {
    return {
      type: 'timeout',
      errorCode: hlsResource ? `${hlsResource}_timeout` : 'hls_timeout',
      httpStatus,
      hlsResource,
    };
  }

  if (hlsResource === 'manifest') {
    return {
      type: 'manifest_load_error',
      errorCode: 'manifest_load_error',
      httpStatus,
      hlsResource,
    };
  }

  if (hlsResource === 'segment') {
    return {
      type: 'segment_load_error',
      errorCode: 'segment_load_error',
      httpStatus,
      hlsResource,
    };
  }

  if (diagnostic.category === 'auth_forbidden') {
    return {
      type: 'http_error',
      errorCode: httpStatus === 401 ? 'http_401' : 'http_403',
      httpStatus,
      hlsResource,
    };
  }

  if (diagnostic.category === 'not_found') {
    return {
      type: 'http_error',
      errorCode: 'http_404',
      httpStatus,
      hlsResource,
    };
  }

  return {
    type: 'network_error',
    errorCode: diagnostic.category === 'decode' ? 'decode_error' : 'hls_network_error',
    httpStatus,
    hlsResource,
  };
}

export function isErrorDiagnosticEventType(type: PlaybackDiagnosticEventType): boolean {
  return (
    type === 'network_error' ||
    type === 'timeout' ||
    type === 'http_error' ||
    type === 'manifest_load_error' ||
    type === 'segment_load_error' ||
    type === 'fatal_playback_failure'
  );
}

export function computePlaybackDiagnosticsSummary(
  events: readonly PlaybackDiagnosticEvent[]
): PlaybackDiagnosticsSummary {
  let playsStarted = 0;
  let playsCompleted = 0;
  let bufferingCount = 0;
  let startupSum = 0;
  let startupSamples = 0;
  let initialLoadSum = 0;
  let initialLoadSamples = 0;
  let hlsRetryCount = 0;
  let hlsSuccessfulRecoveries = 0;
  let failoverCount = 0;
  let fatalFailures = 0;
  let networkErrors = 0;
  let timeoutErrors = 0;
  let manifestLoadErrors = 0;
  let segmentLoadErrors = 0;

  const httpErrorsByCode = {
    403: 0,
    404: 0,
    429: 0,
    '5xx': 0,
  };

  const categoryMap = new Map<PlaybackSourceCategory, PlaybackSourceCategoryBreakdown>();
  const ensureCategory = (category: PlaybackSourceCategory): PlaybackSourceCategoryBreakdown => {
    let entry = categoryMap.get(category);
    if (!entry) {
      entry = {
        category,
        label: PLAYBACK_SOURCE_CATEGORY_LABELS[category],
        playsStarted: 0,
        errorCount: 0,
        bufferingCount: 0,
        failoverCount: 0,
        fatalFailures: 0,
      };
      categoryMap.set(category, entry);
    }
    return entry;
  };

  for (const ev of events) {
    const cat = ensureCategory(ev.sourceCategory);

    switch (ev.type) {
      case 'playback_started':
        playsStarted += 1;
        cat.playsStarted += 1;
        if (typeof ev.durationMs === 'number' && Number.isFinite(ev.durationMs)) {
          startupSum += ev.durationMs;
          startupSamples += 1;
        }
        break;
      case 'initial_loaded':
        if (typeof ev.durationMs === 'number' && Number.isFinite(ev.durationMs)) {
          initialLoadSum += ev.durationMs;
          initialLoadSamples += 1;
        }
        break;
      case 'playback_completed':
        playsCompleted += 1;
        break;
      case 'buffering':
        bufferingCount += 1;
        cat.bufferingCount += 1;
        break;
      case 'hls_retry_scheduled':
        hlsRetryCount += 1;
        break;
      case 'hls_recovery_succeeded':
        hlsSuccessfulRecoveries += 1;
        break;
      case 'failover':
        failoverCount += 1;
        cat.failoverCount += 1;
        break;
      case 'fatal_playback_failure':
        fatalFailures += 1;
        cat.fatalFailures += 1;
        cat.errorCount += 1;
        break;
      case 'network_error':
        networkErrors += 1;
        cat.errorCount += 1;
        break;
      case 'timeout':
        timeoutErrors += 1;
        cat.errorCount += 1;
        break;
      case 'manifest_load_error':
        manifestLoadErrors += 1;
        cat.errorCount += 1;
        break;
      case 'segment_load_error':
        segmentLoadErrors += 1;
        cat.errorCount += 1;
        break;
      case 'http_error':
        cat.errorCount += 1;
        if (ev.httpStatus === 403) httpErrorsByCode[403] += 1;
        else if (ev.httpStatus === 404) httpErrorsByCode[404] += 1;
        else if (ev.httpStatus === 429) httpErrorsByCode[429] += 1;
        else if (typeof ev.httpStatus === 'number' && ev.httpStatus >= 500 && ev.httpStatus < 600) {
          httpErrorsByCode['5xx'] += 1;
        }
        break;
      default:
        break;
    }

    if (ev.type !== 'manifest_load_error' && ev.type !== 'segment_load_error') {
      if (ev.hlsResource === 'manifest' && isErrorDiagnosticEventType(ev.type)) {
        manifestLoadErrors += 1;
      } else if (ev.hlsResource === 'segment' && isErrorDiagnosticEventType(ev.type)) {
        segmentLoadErrors += 1;
      }
    }
  }

  const categoryBreakdown = Array.from(categoryMap.values()).sort(
    (a, b) => b.errorCount - a.errorCount || b.playsStarted - a.playsStarted
  );
  const topErrorCategories = categoryBreakdown.filter((entry) => entry.errorCount > 0);

  return {
    totalEvents: events.length,
    playsStarted,
    playsCompleted,
    failureRate: playsStarted > 0 ? Number((fatalFailures / playsStarted).toFixed(4)) : null,
    bufferingCount,
    averageStartupMs: startupSamples > 0 ? Math.round(startupSum / startupSamples) : null,
    averageInitialLoadMs:
      initialLoadSamples > 0 ? Math.round(initialLoadSum / initialLoadSamples) : null,
    hlsRetryCount,
    hlsSuccessfulRecoveries,
    failoverCount,
    fatalFailures,
    networkErrors,
    timeoutErrors,
    manifestLoadErrors,
    segmentLoadErrors,
    httpErrorsByCode,
    topErrorCategories,
    categoryBreakdown,
  };
}

export function generateEphemeralSessionId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return `s_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    }
  } catch {
    // Fallback below
  }
  return `s_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36).slice(-6)}`;
}

export type DiagnosticsTransport = (events: PlaybackDiagnosticEvent[]) => void | Promise<void>;

export interface PlaybackDiagnosticsCollectorOptions {
  sessionId?: string;
  maxSessionEvents?: number;
  dedupWindowMs?: number;
  flushIntervalMs?: number;
  nowMs?: () => number;
  transport?: DiagnosticsTransport;
}

const MILESTONE_FLUSH_TYPES = new Set<PlaybackDiagnosticEventType>([
  'playback_started',
  'failover',
  'fatal_playback_failure',
  'playback_completed',
]);

const DEDUPLICATED_TYPES = new Set<PlaybackDiagnosticEventType>([
  'playback_started',
  'playback_completed',
  'buffering',
  'network_error',
  'timeout',
  'http_error',
  'manifest_load_error',
  'segment_load_error',
  'failover',
  'source_switch',
  'fatal_playback_failure',
]);

export function defaultDiagnosticsTransport(events: PlaybackDiagnosticEvent[]): void {
  if (typeof window === 'undefined' || events.length === 0) return;
  try {
    const body = JSON.stringify({ events });
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function' &&
      body.length <= 16_384
    ) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon('/api/playback-diagnostics', blob)) {
        return;
      }
    }
    if (typeof fetch === 'function') {
      void fetch('/api/playback-diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // Diagnóstico é estritamente fail-open e nunca interrompe a reprodução
  }
}

export function createPlaybackDiagnosticsCollector(
  options: PlaybackDiagnosticsCollectorOptions = {}
) {
  const sessionId = sanitizeSessionId(options.sessionId) ?? generateEphemeralSessionId();
  const maxEvents = Math.max(1, options.maxSessionEvents ?? MAX_SESSION_DIAGNOSTIC_EVENTS);
  const dedupWindowMs = Math.max(0, options.dedupWindowMs ?? DIAGNOSTIC_DEDUP_WINDOW_MS);
  const flushIntervalMs = Math.max(1000, options.flushIntervalMs ?? DIAGNOSTIC_FLUSH_INTERVAL_MS);
  const nowMs = options.nowMs ?? (() => Date.now());
  const transport = options.transport ?? defaultDiagnosticsTransport;

  const sessionEvents: PlaybackDiagnosticEvent[] = [];
  let pendingQueue: PlaybackDiagnosticEvent[] = [];
  const lastEventAtByKey = new Map<string, number>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearFlushTimer = () => {
    if (flushTimer !== null) {
      globalThis.clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const flush = () => {
    clearFlushTimer();
    if (pendingQueue.length === 0) return;

    const batch = pendingQueue.slice(0, MAX_DIAGNOSTIC_BATCH_SIZE);
    pendingQueue = pendingQueue.slice(MAX_DIAGNOSTIC_BATCH_SIZE);

    try {
      const result = transport(batch);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Fail-open: nunca quebra o player
    }

    if (!disposed && pendingQueue.length > 0) {
      flushTimer = globalThis.setTimeout(() => {
        flushTimer = null;
        flush();
      }, flushIntervalMs);
    }
  };

  const scheduleFlushIfNeeded = () => {
    if (disposed || flushTimer !== null || pendingQueue.length === 0) return;
    flushTimer = globalThis.setTimeout(() => {
      flushTimer = null;
      flush();
    }, flushIntervalMs);
  };

  const record = (
    input: Omit<PlaybackDiagnosticEvent, 'timestamp' | 'sessionId'> & { timestamp?: number }
  ): PlaybackDiagnosticEvent | null => {
    if (disposed) return null;
    if (sessionEvents.length >= maxEvents) return null;

    const timestamp = input.timestamp ?? nowMs();
    const sanitized = sanitizeDiagnosticEvent({
      ...input,
      timestamp,
      sessionId,
    });
    if (!sanitized) return null;

    if (DEDUPLICATED_TYPES.has(sanitized.type) && dedupWindowMs > 0) {
      const dedupKey = `${sanitized.type}:${sanitized.slot}:${sanitized.sourceCategory}:${sanitized.errorCode ?? ''}:${sanitized.httpStatus ?? ''}:${sanitized.hlsResource ?? ''}:${sanitized.fromSlot ?? ''}:${sanitized.toSlot ?? ''}:${sanitized.switchReason ?? ''}`;
      const prevTs = lastEventAtByKey.get(dedupKey);
      if (prevTs !== undefined && timestamp - prevTs < dedupWindowMs) {
        return null;
      }
      lastEventAtByKey.set(dedupKey, timestamp);
    }

    sessionEvents.push(sanitized);
    pendingQueue.push(sanitized);

    if (MILESTONE_FLUSH_TYPES.has(sanitized.type) || pendingQueue.length >= MAX_DIAGNOSTIC_BATCH_SIZE) {
      flush();
    } else {
      scheduleFlushIfNeeded();
    }

    return sanitized;
  };

  const dispose = () => {
    if (disposed) return;
    flush();
    disposed = true;
    clearFlushTimer();
    lastEventAtByKey.clear();
  };

  return {
    sessionId,
    record,
    flush,
    dispose,
    getEvents: (): readonly PlaybackDiagnosticEvent[] => sessionEvents,
    getPendingCount: () => pendingQueue.length,
    getSummary: () => computePlaybackDiagnosticsSummary(sessionEvents),
  };
}
