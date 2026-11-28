import {
  computePlaybackDiagnosticsSummary,
  MAX_DIAGNOSTIC_BATCH_SIZE,
  MAX_SESSION_DIAGNOSTIC_EVENTS,
  type PlaybackDiagnosticEvent,
  type PlaybackDiagnosticsSummary,
  sanitizeDiagnosticEvent,
} from '@/lib/playback-diagnostics';

export const MAX_SERVER_DIAGNOSTIC_EVENTS = 500;
const MAX_TRACKED_SESSIONS = 200;

export interface PlaybackDiagnosticsSnapshot {
  storageMode: 'in_memory';
  maxRetainedEvents: number;
  retainedEventsCount: number;
  summary: PlaybackDiagnosticsSummary;
  recentEvents: PlaybackDiagnosticEvent[];
}

const retainedEvents: PlaybackDiagnosticEvent[] = [];
const sessionCounts = new Map<string, number>();

export function recordDiagnosticEventsBatch(rawEvents: unknown): {
  accepted: number;
  rejected: number;
} {
  if (!Array.isArray(rawEvents)) {
    return { accepted: 0, rejected: 0 };
  }

  let accepted = 0;
  let rejected = 0;
  const slice = rawEvents.slice(0, MAX_DIAGNOSTIC_BATCH_SIZE);

  for (const raw of slice) {
    const sanitized = sanitizeDiagnosticEvent(raw);
    if (!sanitized) {
      rejected += 1;
      continue;
    }

    const currentSessionCount = sessionCounts.get(sanitized.sessionId) ?? 0;
    if (currentSessionCount >= MAX_SESSION_DIAGNOSTIC_EVENTS) {
      rejected += 1;
      continue;
    }

    if (!sessionCounts.has(sanitized.sessionId) && sessionCounts.size >= MAX_TRACKED_SESSIONS) {
      const oldestKey = sessionCounts.keys().next().value;
      if (oldestKey !== undefined) {
        sessionCounts.delete(oldestKey);
      }
    }
    sessionCounts.set(sanitized.sessionId, currentSessionCount + 1);

    retainedEvents.push(sanitized);
    if (retainedEvents.length > MAX_SERVER_DIAGNOSTIC_EVENTS) {
      retainedEvents.splice(0, retainedEvents.length - MAX_SERVER_DIAGNOSTIC_EVENTS);
    }

    accepted += 1;
  }

  return { accepted, rejected };
}

export function getPlaybackDiagnosticsSnapshot(recentLimit = 30): PlaybackDiagnosticsSnapshot {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(recentLimit)));
  return {
    storageMode: 'in_memory',
    maxRetainedEvents: MAX_SERVER_DIAGNOSTIC_EVENTS,
    retainedEventsCount: retainedEvents.length,
    summary: computePlaybackDiagnosticsSummary(retainedEvents),
    recentEvents: retainedEvents.slice(-safeLimit).reverse(),
  };
}

export function clearPlaybackDiagnosticsStore(): void {
  retainedEvents.length = 0;
  sessionCounts.clear();
}
