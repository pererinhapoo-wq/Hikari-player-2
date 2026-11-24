import { assertSafeExternalUrl } from '@/lib/ssrf';
import type { EmbedAuthStrategy, EmbedRedirectHopDiagnostic } from '@/lib/types';
import {
  isEmbedAllowedFinalHost,
  isEmbedProxiedHost,
  validateHttpUrl,
} from '@/lib/video-sources';

export const MAX_EMBED_BODY_BYTES = 1024 * 1024; // 1 MB
export const EMBED_FETCH_TIMEOUT_MS = 10_000;
export const MAX_EMBED_REDIRECTS = 3;

export const EMBED_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const EMBED_NAVIGATION_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': EMBED_CHROME_UA,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'cross-site',
  'upgrade-insecure-requests': '1',
};

export function buildEmbedRequestHeaders(referer?: string): Record<string, string> {
  if (referer) {
    return {
      ...EMBED_NAVIGATION_HEADERS,
      Referer: referer,
    };
  }
  return { ...EMBED_NAVIGATION_HEADERS };
}

export function formatEmbedAttemptSequence(
  redirectChain: readonly EmbedRedirectHopDiagnostic[]
): string {
  if (redirectChain.length === 0) return 'nenhuma';
  return redirectChain
    .map((hop, idx) => {
      const mode = hop.authMode === 'chrome_ua_no_referer' ? 'sem Referer' : 'com Referer';
      const statusText = hop.status !== null ? `HTTP ${hop.status}` : hop.error ?? 'erro';
      return `#${idx + 1} ${hop.host} [${mode}]: ${statusText}`;
    })
    .join(' -> ');
}

export const EMBED_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=900';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

const STRIPPED_EMBED_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'set-cookie',
  ...HOP_BY_HOP_HEADERS,
]);

export interface EmbedProxyDeps {
  fetchImpl?: typeof fetch;
  assertSafeUrl?: (rawUrl: string) => Promise<URL>;
}

export interface EmbedProxyExecutionResult {
  response: Response;
  redirectChain: EmbedRedirectHopDiagnostic[];
  successfulStrategy: EmbedAuthStrategy | null;
  finalUrl: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildBaseHref(url: URL): string {
  const pathname = url.pathname || '/';
  if (pathname.endsWith('/')) {
    return `${url.origin}${pathname}`;
  }
  const lastSlash = pathname.lastIndexOf('/');
  const dirPath = lastSlash >= 0 ? pathname.slice(0, lastSlash + 1) : '/';
  return `${url.origin}${dirPath}`;
}

export function injectBaseTag(html: string, baseHref: string): string {
  const baseTag = `<base href="${escapeHtml(baseHref)}">`;
  const headMatch = /<head(?:\s[^>]*)?>/i.exec(html);
  if (headMatch && typeof headMatch.index === 'number') {
    const insertAt = headMatch.index + headMatch[0].length;
    return `${html.slice(0, insertAt)}${baseTag}${html.slice(insertAt)}`;
  }
  return `${baseTag}${html}`;
}

export function buildMinimalEmbedErrorHtml(reason: string, title = 'Falha ao carregar embed'): string {
  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head><meta charset="utf-8"><title>' + escapeHtml(title) + '</title></head>',
    '<body>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(reason)}</p>`,
    '</body>',
    '</html>',
  ].join('');
}

function buildErrorResponse(status: number, reason: string, title?: string): Response {
  return new Response(buildMinimalEmbedErrorHtml(reason, title), {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'CDN-Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function sanitizeResponseHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();
  const connectionHeader = upstreamHeaders.get('connection');
  const dynamicHopByHop = new Set<string>();
  if (connectionHeader) {
    for (const token of connectionHeader.split(',')) {
      const normalized = token.trim().toLowerCase();
      if (normalized) dynamicHopByHop.add(normalized);
    }
  }

  upstreamHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (STRIPPED_EMBED_HEADERS.has(lower) || dynamicHopByHop.has(lower)) {
      return;
    }
    headers.append(key, value);
  });

  headers.delete('set-cookie');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', EMBED_CACHE_CONTROL);
  headers.set('Access-Control-Allow-Origin', '*');

  return headers;
}

async function cancelBodySafely(response: Response): Promise<void> {
  if (response.body) {
    try {
      await response.body.cancel();
    } catch {
      // ignore
    }
  }
}

async function readBodyWithinLimit(
  response: Response,
  maxBytes: number
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const rawContentLength = response.headers.get('content-length');
  if (rawContentLength) {
    const parsedLen = Number(rawContentLength);
    if (Number.isFinite(parsedLen) && parsedLen > maxBytes) {
      await cancelBodySafely(response);
      return { ok: false, reason: 'Corpo da resposta excede o limite de 1 MB.' };
    }
  }

  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      return { ok: false, reason: 'Corpo da resposta excede o limite de 1 MB.' };
    }
    return {
      ok: true,
      text: new TextDecoder('utf-8', { fatal: false }).decode(buffer),
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        return { ok: false, reason: 'Corpo da resposta excede o limite de 1 MB.' };
      }
      chunks.push(value);
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'Erro ao ler corpo da resposta.',
    };
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    ok: true,
    text: new TextDecoder('utf-8', { fatal: false }).decode(combined),
  };
}

type RedirectChainStepResult =
  | {
      kind: 'response';
      response: Response;
      finalUrl: URL;
      redirectsUsed: number;
    }
  | {
      kind: 'error';
      httpStatus: number;
      reason: string;
      title: string;
    };

async function executeValidatedRedirectChain(params: {
  startUrl: string;
  headers: Record<string, string>;
  authMode: EmbedAuthStrategy;
  maxRedirects: number;
  assertSafeUrl: (rawUrl: string) => Promise<URL>;
  fetchImpl: typeof fetch;
  redirectChain: EmbedRedirectHopDiagnostic[];
}): Promise<RedirectChainStepResult> {
  const {
    startUrl,
    headers,
    authMode,
    maxRedirects,
    assertSafeUrl,
    fetchImpl,
    redirectChain,
  } = params;

  let currentUrl = startUrl;
  let redirectsUsed = 0;

  while (true) {
    let parsedCurrent: URL;
    try {
      parsedCurrent = await assertSafeUrl(currentUrl);
    } catch (err) {
      let host = '';
      try {
        host = new URL(currentUrl).hostname;
      } catch {
        host = 'desconhecido';
      }
      const reason =
        err instanceof Error ? err.message : 'URL inválida ou bloqueada na validação SSRF.';
      redirectChain.push({
        host,
        url: currentUrl,
        status: null,
        location: null,
        authMode,
        error: reason,
      });
      return {
        kind: 'error',
        httpStatus: 502,
        reason,
        title: 'Erro ao carregar embed',
      };
    }

    let response: Response;
    try {
      response = await fetchImpl(parsedCurrent.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers,
        signal: AbortSignal.timeout(EMBED_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : 'Falha de rede ao buscar página do embed.';
      redirectChain.push({
        host: parsedCurrent.hostname,
        url: parsedCurrent.toString(),
        status: null,
        location: null,
        authMode,
        error: reason,
      });
      return {
        kind: 'error',
        httpStatus: 502,
        reason,
        title: 'Erro ao carregar embed',
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await cancelBodySafely(response);

      redirectChain.push({
        host: parsedCurrent.hostname,
        url: parsedCurrent.toString(),
        status: response.status,
        location,
        authMode,
        error: null,
      });

      if (!location) {
        return {
          kind: 'error',
          httpStatus: 502,
          reason: 'Redirecionamento sem cabeçalho Location.',
          title: 'Erro ao carregar embed',
        };
      }

      if (redirectsUsed >= maxRedirects) {
        return {
          kind: 'error',
          httpStatus: 502,
          reason: `Número máximo de redirecionamentos (${MAX_EMBED_REDIRECTS}) excedido.`,
          title: 'Excesso de redirecionamentos',
        };
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(location, parsedCurrent);
      } catch {
        return {
          kind: 'error',
          httpStatus: 502,
          reason: 'Cabeçalho Location inválido no redirecionamento.',
          title: 'Erro ao carregar embed',
        };
      }

      if (nextUrl.protocol !== 'https:') {
        const reason = `Redirecionamento para protocolo não HTTPS ("${nextUrl.protocol}") bloqueado.`;
        redirectChain.push({
          host: nextUrl.hostname,
          url: nextUrl.toString(),
          status: null,
          location: null,
          authMode,
          error: reason,
        });
        return {
          kind: 'error',
          httpStatus: 403,
          reason,
          title: 'Host não autorizado',
        };
      }

      if (!isEmbedAllowedFinalHost(nextUrl.hostname)) {
        const reason = `Host de redirecionamento ("${nextUrl.hostname}") não está em EMBED_ALLOWED_FINAL_HOSTS.`;
        redirectChain.push({
          host: nextUrl.hostname,
          url: nextUrl.toString(),
          status: null,
          location: null,
          authMode,
          error: reason,
        });
        return {
          kind: 'error',
          httpStatus: 403,
          reason,
          title: 'Host não autorizado',
        };
      }

      redirectsUsed += 1;
      currentUrl = nextUrl.toString();
      continue;
    }

    redirectChain.push({
      host: parsedCurrent.hostname,
      url: parsedCurrent.toString(),
      status: response.status,
      location: null,
      authMode,
      error: null,
    });

    return {
      kind: 'response',
      response,
      finalUrl: parsedCurrent,
      redirectsUsed,
    };
  }
}

export async function resolveEmbedProxy(
  request: Request,
  deps: EmbedProxyDeps = {}
): Promise<EmbedProxyExecutionResult> {
  if (request.method === 'OPTIONS') {
    return {
      response: new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      }),
      redirectChain: [],
      successfulStrategy: null,
      finalUrl: null,
    };
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const assertSafeUrl = deps.assertSafeUrl ?? assertSafeExternalUrl;

  const reqUrl = new URL(request.url);
  const rawTarget = reqUrl.searchParams.get('u') ?? '';

  const validation = validateHttpUrl(rawTarget);
  if (!validation.valid || !validation.normalizedUrl) {
    return {
      response: buildErrorResponse(400, validation.error ?? 'Parâmetro u inválido.', 'URL inválida'),
      redirectChain: [],
      successfulStrategy: null,
      finalUrl: null,
    };
  }

  const targetUrl = new URL(validation.normalizedUrl);
  if (targetUrl.protocol !== 'https:') {
    return {
      response: buildErrorResponse(
        400,
        'Apenas URLs HTTPS são permitidas em /api/embed.',
        'Protocolo inválido'
      ),
      redirectChain: [],
      successfulStrategy: null,
      finalUrl: null,
    };
  }

  if (!isEmbedProxiedHost(targetUrl.hostname)) {
    return {
      response: buildErrorResponse(
        403,
        `Host "${targetUrl.hostname}" não está na allowlist de entrada de /api/embed.`,
        'Host não autorizado'
      ),
      redirectChain: [],
      successfulStrategy: null,
      finalUrl: null,
    };
  }

  const isCoempregosTarget =
    targetUrl.hostname.toLowerCase().includes('anitube') ||
    targetUrl.hostname.toLowerCase().includes('hinatasoul');
  const entryOriginReferer = isCoempregosTarget
    ? 'https://www.coempregos.com.br/'
    : `${targetUrl.origin}/`;
  const redirectChain: EmbedRedirectHopDiagnostic[] = [];

  const attempt1 = await executeValidatedRedirectChain({
    startUrl: targetUrl.toString(),
    headers: buildEmbedRequestHeaders(entryOriginReferer),
    authMode: 'chrome_ua_with_referer',
    maxRedirects: MAX_EMBED_REDIRECTS,
    assertSafeUrl,
    fetchImpl,
    redirectChain,
  });

  if (attempt1.kind === 'error') {
    const attemptSummary = formatEmbedAttemptSequence(redirectChain);
    return {
      response: buildErrorResponse(
        attempt1.httpStatus,
        `${attempt1.reason} (${attemptSummary})`,
        attempt1.title
      ),
      redirectChain,
      successfulStrategy: null,
      finalUrl: null,
    };
  }

  let finalUpstream = attempt1.response;
  let finalParsed = attempt1.finalUrl;
  let successfulStrategy: EmbedAuthStrategy = 'chrome_ua_with_referer';

  if (finalUpstream.status === 403) {
    await cancelBodySafely(finalUpstream);
    const remainingRedirects = Math.max(0, MAX_EMBED_REDIRECTS - attempt1.redirectsUsed);

    const attempt2 = await executeValidatedRedirectChain({
      startUrl: finalParsed.toString(),
      headers: buildEmbedRequestHeaders(),
      authMode: 'chrome_ua_no_referer',
      maxRedirects: remainingRedirects,
      assertSafeUrl,
      fetchImpl,
      redirectChain,
    });

    if (attempt2.kind === 'error') {
      const attemptSummary = formatEmbedAttemptSequence(redirectChain);
      return {
        response: buildErrorResponse(
          attempt2.httpStatus,
          `${attempt2.reason} (${attemptSummary})`,
          attempt2.title
        ),
        redirectChain,
        successfulStrategy: null,
        finalUrl: null,
      };
    }

    finalUpstream = attempt2.response;
    finalParsed = attempt2.finalUrl;
    successfulStrategy = 'chrome_ua_no_referer';
  }

  if (!finalUpstream.ok) {
    await cancelBodySafely(finalUpstream);
    const attemptSummary = formatEmbedAttemptSequence(redirectChain);
    const reason =
      successfulStrategy === 'chrome_ua_no_referer'
        ? `Origem respondeu HTTP ${finalUpstream.status} mesmo após fallback sem Referer (${attemptSummary}).`
        : `Origem respondeu HTTP ${finalUpstream.status} (${attemptSummary}).`;
    return {
      response: buildErrorResponse(502, reason, 'Erro ao carregar embed'),
      redirectChain,
      successfulStrategy: null,
      finalUrl: finalParsed.toString(),
    };
  }

  const bodyResult = await readBodyWithinLimit(finalUpstream, MAX_EMBED_BODY_BYTES);
  if (!bodyResult.ok) {
    return {
      response: buildErrorResponse(413, bodyResult.reason, 'Conteúdo muito grande'),
      redirectChain,
      successfulStrategy: null,
      finalUrl: finalParsed.toString(),
    };
  }

  const baseHref = buildBaseHref(finalParsed);
  const htmlWithBase = injectBaseTag(bodyResult.text, baseHref);
  const headers = sanitizeResponseHeaders(finalUpstream.headers);

  return {
    response: new Response(htmlWithBase, {
      status: 200,
      headers,
    }),
    redirectChain,
    successfulStrategy,
    finalUrl: finalParsed.toString(),
  };
}

export async function handleEmbedRequest(
  request: Request,
  deps: EmbedProxyDeps = {}
): Promise<Response> {
  const result = await resolveEmbedProxy(request, deps);
  return result.response;
}
