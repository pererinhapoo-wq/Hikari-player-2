import type { PlayableSource } from '@/lib/types';
import { isMaximaimgHost, validateHttpUrl } from '@/lib/video-sources';

export type PlaybackStrategy = 'proxy' | 'direct' | 'iframe';

export type HlsErrorCategory =
  | 'auth_forbidden'
  | 'not_found'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'decode'
  | 'unknown';

export interface HlsErrorInput {
  type?: string;
  details?: string;
  httpCode?: number;
  url?: string;
}

export interface HlsDiagnosticInfo {
  category: HlsErrorCategory;
  type: string;
  details: string;
  httpCode: number | null;
  url: string | null;
  userMessage: string;
}

export type HlsErrorAction =
  | { action: 'recover_media' }
  | { action: 'retry_load'; attempt: number; delayMs: number }
  | { action: 'fallback_direct'; reason: string }
  | { action: 'failover'; reason: string };

export const MAX_HLS_NETWORK_RETRIES = 2;
export const MAX_HLS_MEDIA_RECOVERIES = 2;
export const HLS_NETWORK_RETRY_BASE_DELAY_MS = 500;
export const HLS_NETWORK_RETRY_MAX_DELAY_MS = 2000;

export function getHlsNetworkRetryDelayMs(retryAttemptIndex: number): number {
  const safeAttempt = Number.isFinite(retryAttemptIndex)
    ? Math.max(0, Math.floor(retryAttemptIndex))
    : 0;
  return Math.min(
    HLS_NETWORK_RETRY_MAX_DELAY_MS,
    HLS_NETWORK_RETRY_BASE_DELAY_MS * 2 ** safeAttempt
  );
}

export function sanitizeUrlForConsole(rawUrl: string | undefined | null): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    if (parsed.pathname === '/api/proxy/stream') {
      const target = parsed.searchParams.get('url');
      if (target) {
        const targetParsed = new URL(target);
        return `/api/proxy/stream -> ${targetParsed.origin}${targetParsed.pathname}`;
      }
      return '/api/proxy/stream';
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export function classifyHlsError(input: HlsErrorInput): HlsDiagnosticInfo {
  const type = input.type ?? 'unknown';
  const details = input.details ?? 'unknown';
  const httpCode =
    typeof input.httpCode === 'number' && Number.isFinite(input.httpCode) && input.httpCode > 0
      ? input.httpCode
      : null;
  const url = sanitizeUrlForConsole(input.url);

  if (type === 'mediaError' || details.toLowerCase().includes('parsing') || details.toLowerCase().includes('buffer')) {
    return {
      category: 'decode',
      type,
      details,
      httpCode,
      url,
      userMessage: 'Erro ao decodificar o vídeo nesta fonte.',
    };
  }

  if (httpCode === 401 || httpCode === 403 || httpCode === 451) {
    return {
      category: 'auth_forbidden',
      type,
      details,
      httpCode,
      url,
      userMessage: 'Fonte indisponível por restrição de acesso.',
    };
  }

  if (httpCode === 404 || httpCode === 410) {
    return {
      category: 'not_found',
      type,
      details,
      httpCode,
      url,
      userMessage: 'Arquivo de vídeo não encontrado nesta fonte.',
    };
  }

  if (httpCode !== null && httpCode >= 500) {
    return {
      category: 'server_error',
      type,
      details,
      httpCode,
      url,
      userMessage: 'O servidor da fonte está temporariamente indisponível.',
    };
  }

  if (details.toLowerCase().includes('timeout')) {
    return {
      category: 'timeout',
      type,
      details,
      httpCode,
      url,
      userMessage: 'Tempo esgotado ao carregar o stream.',
    };
  }

  if (type === 'networkError' || details.toLowerCase().includes('loaderror')) {
    return {
      category: 'network',
      type,
      details,
      httpCode,
      url,
      userMessage: 'Falha de rede ao carregar a transmissão HLS.',
    };
  }

  return {
    category: 'unknown',
    type,
    details,
    httpCode,
    url,
    userMessage: 'Falha ao carregar transmissão HLS.',
  };
}

export function canUseDirectMaximaimgFallback(
  source: Pick<PlayableSource, 'provider' | 'kind' | 'resolvedUrl' | 'playUrl'> | null | undefined,
  currentStrategy: PlaybackStrategy,
  alreadyAttemptedDirect: boolean
): boolean {
  if (!source) return false;
  if (source.provider !== 'maximaimg' || source.kind !== 'hls') {
    return false;
  }
  if (currentStrategy !== 'proxy' || alreadyAttemptedDirect) {
    return false;
  }

  const check = validateHttpUrl(source.resolvedUrl);
  if (!check.valid || !check.normalizedUrl) {
    return false;
  }

  try {
    const parsed = new URL(check.normalizedUrl);
    if (!isMaximaimgHost(parsed.hostname)) {
      return false;
    }
    if (check.normalizedUrl === source.playUrl) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function shouldFallbackToDirectOnCategory(category: HlsErrorCategory): boolean {
  return (
    category === 'auth_forbidden' ||
    category === 'server_error' ||
    category === 'timeout' ||
    category === 'network'
  );
}

export function decideHlsErrorAction(params: {
  source: Pick<PlayableSource, 'provider' | 'kind' | 'resolvedUrl' | 'playUrl'> | null | undefined;
  strategy: PlaybackStrategy;
  alreadyAttemptedDirect: boolean;
  networkRetriesUsed: number;
  mediaRecoveriesUsed: number;
  diagnostic: HlsDiagnosticInfo;
}): HlsErrorAction {
  const {
    source,
    strategy,
    alreadyAttemptedDirect,
    networkRetriesUsed,
    mediaRecoveriesUsed,
    diagnostic,
  } = params;

  if (diagnostic.category === 'decode' && mediaRecoveriesUsed < MAX_HLS_MEDIA_RECOVERIES) {
    return { action: 'recover_media' };
  }

  const eligibleForDirectFallback = canUseDirectMaximaimgFallback(
    source,
    strategy,
    alreadyAttemptedDirect
  );

  // Erros de autorização (403/401/451) no proxy Maximaimg não devem repetir startLoad():
  // avançar imediatamente para uma única tentativa direta ou para o failover de slots.
  if (diagnostic.category === 'auth_forbidden') {
    if (eligibleForDirectFallback) {
      return {
        action: 'fallback_direct',
        reason: diagnostic.userMessage,
      };
    }
    return {
      action: 'failover',
      reason: diagnostic.userMessage,
    };
  }

  if (
    eligibleForDirectFallback &&
    shouldFallbackToDirectOnCategory(diagnostic.category) &&
    (diagnostic.details.toLowerCase().includes('manifest') ||
      diagnostic.details.toLowerCase().includes('level'))
  ) {
    return {
      action: 'fallback_direct',
      reason: diagnostic.userMessage,
    };
  }

  const isRetryableTransient =
    diagnostic.category === 'network' ||
    diagnostic.category === 'timeout' ||
    diagnostic.category === 'server_error';

  if (isRetryableTransient && networkRetriesUsed < MAX_HLS_NETWORK_RETRIES) {
    return {
      action: 'retry_load',
      attempt: networkRetriesUsed + 1,
      delayMs: getHlsNetworkRetryDelayMs(networkRetriesUsed),
    };
  }

  if (eligibleForDirectFallback && shouldFallbackToDirectOnCategory(diagnostic.category)) {
    return {
      action: 'fallback_direct',
      reason: diagnostic.userMessage,
    };
  }

  return {
    action: 'failover',
    reason: diagnostic.userMessage,
  };
}

export interface HlsRecoveryTarget {
  startLoad: (startPosition?: number) => void;
  recoverMediaError: () => void;
}

export interface HlsTimerApi {
  setTimeout: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
}

export interface CreateHlsRecoveryControllerOptions {
  source: Pick<PlayableSource, 'provider' | 'kind' | 'resolvedUrl' | 'playUrl'> | null | undefined;
  strategy: PlaybackStrategy;
  alreadyAttemptedDirect: boolean;
  hls: HlsRecoveryTarget;
  onRetryScheduled?: (info: {
    attempt: number;
    maxRetries: number;
    delayMs: number;
    diagnostic: HlsDiagnosticInfo;
  }) => void;
  onRetryExecuted?: (info: {
    attempt: number;
    maxRetries: number;
    delayMs: number;
    diagnostic: HlsDiagnosticInfo;
  }) => void;
  onRecoverMedia?: (info: {
    attempt: number;
    maxRecoveries: number;
    diagnostic: HlsDiagnosticInfo;
  }) => void;
  onFallbackDirect: (reason: string, diagnostic: HlsDiagnosticInfo) => void;
  onFailover: (reason: string, diagnostic: HlsDiagnosticInfo) => void;
  timers?: HlsTimerApi;
}

export function createHlsRecoveryController(options: CreateHlsRecoveryControllerOptions) {
  const timers: HlsTimerApi = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  };

  let disposed = false;
  let networkRetriesUsed = 0;
  let mediaRecoveriesUsed = 0;
  let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPendingTimer = () => {
    if (pendingRetryTimer !== null) {
      timers.clearTimeout(pendingRetryTimer);
      pendingRetryTimer = null;
    }
  };

  const dispose = () => {
    disposed = true;
    clearPendingTimer();
  };

  const handleFatalError = (input: HlsErrorInput): HlsErrorAction | null => {
    if (disposed) {
      return null;
    }

    if (pendingRetryTimer !== null) {
      return null;
    }

    const diagnostic = classifyHlsError(input);
    const decision = decideHlsErrorAction({
      source: options.source,
      strategy: options.strategy,
      alreadyAttemptedDirect: options.alreadyAttemptedDirect,
      networkRetriesUsed,
      mediaRecoveriesUsed,
      diagnostic,
    });

    if (decision.action === 'recover_media') {
      mediaRecoveriesUsed += 1;
      options.onRecoverMedia?.({
        attempt: mediaRecoveriesUsed,
        maxRecoveries: MAX_HLS_MEDIA_RECOVERIES,
        diagnostic,
      });
      options.hls.recoverMediaError();
      return decision;
    }

    if (decision.action === 'retry_load') {
      networkRetriesUsed += 1;
      const currentAttempt = decision.attempt;
      const delayMs = decision.delayMs;

      options.onRetryScheduled?.({
        attempt: currentAttempt,
        maxRetries: MAX_HLS_NETWORK_RETRIES,
        delayMs,
        diagnostic,
      });

      pendingRetryTimer = timers.setTimeout(() => {
        pendingRetryTimer = null;
        if (disposed) {
          return;
        }
        options.onRetryExecuted?.({
          attempt: currentAttempt,
          maxRetries: MAX_HLS_NETWORK_RETRIES,
          delayMs,
          diagnostic,
        });
        options.hls.startLoad();
      }, delayMs);

      return decision;
    }

    if (decision.action === 'fallback_direct') {
      clearPendingTimer();
      options.onFallbackDirect(decision.reason, diagnostic);
      return decision;
    }

    clearPendingTimer();
    options.onFailover(decision.reason, diagnostic);
    return decision;
  };

  return {
    handleFatalError,
    dispose,
    hasPendingRetry: () => pendingRetryTimer !== null,
    getState: () => ({
      disposed,
      networkRetriesUsed,
      mediaRecoveriesUsed,
      hasPendingRetry: pendingRetryTimer !== null,
    }),
  };
}
