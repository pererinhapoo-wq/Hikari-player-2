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
  | { action: 'retry_load' }
  | { action: 'fallback_direct'; reason: string }
  | { action: 'failover'; reason: string };

export const MAX_HLS_NETWORK_RETRIES = 1;
export const MAX_HLS_MEDIA_RECOVERIES = 2;

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
    return { action: 'retry_load' };
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
