import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { CSP_NONCE_STORE_SYMBOL, type CspNonceStore } from '@/lib/csp-nonce';

export const SECURITY_HEADER_VALUES = {
  xContentTypeOptions: 'nosniff',
  referrerPolicyDefault: 'strict-origin-when-cross-origin',
  xFrameOptionsSameOrigin: 'SAMEORIGIN',
  hsts: 'max-age=31536000',
} as const;

const globalRegistry = globalThis as Record<symbol, CspNonceStore | undefined>;
const nonceStorage =
  (globalRegistry[CSP_NONCE_STORE_SYMBOL] as AsyncLocalStorage<string> | undefined) ??
  new AsyncLocalStorage<string>();
globalRegistry[CSP_NONCE_STORE_SYMBOL] = nonceStorage;

export function generateCspNonce(): string {
  return randomBytes(16).toString('base64');
}

export function runWithCspNonce<T>(nonce: string | undefined, fn: () => T): T {
  if (!nonce) {
    return fn();
  }
  return nonceStorage.run(nonce, fn);
}

export function isHttpsRequest(request: Request): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto) {
    const firstProto = forwardedProto.split(',')[0]?.trim().toLowerCase();
    if (firstProto) {
      return firstProto === 'https';
    }
  }

  const forwarded = request.headers.get('forwarded');
  if (forwarded) {
    const match = /\bproto=(https?)\b/i.exec(forwarded);
    if (match) {
      return match[1].toLowerCase() === 'https';
    }
  }

  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function getWorkerOrigin(workerBaseEnv = process.env.WORKER_BASE): string | null {
  const raw = workerBaseEnv?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
    return null;
  } catch {
    return null;
  }
}

export function buildDocumentCsp(options: { nonce?: string; workerBase?: string } = {}): string {
  const scriptSrcParts = ["'self'"];
  if (options.nonce) {
    scriptSrcParts.push(`'nonce-${options.nonce}'`);
  }

  const connectSrcParts = ["'self'"];
  const mediaSrcParts = ["'self'", 'blob:'];
  const workerOrigin = getWorkerOrigin(options.workerBase);
  if (workerOrigin) {
    if (!connectSrcParts.includes(workerOrigin)) {
      connectSrcParts.push(workerOrigin);
    }
    if (!mediaSrcParts.includes(workerOrigin)) {
      mediaSrcParts.push(workerOrigin);
    }
  }
  connectSrcParts.push('https:');
  mediaSrcParts.push('https:');

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrcParts.join(' ')}`,
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
    "img-src 'self' https: blob:",
    "font-src 'self' https://fonts.gstatic.com",
    `connect-src ${connectSrcParts.join(' ')}`,
    `media-src ${mediaSrcParts.join(' ')}`,
    "frame-src 'self' https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ];

  return directives.join('; ');
}

function getPathname(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return '/';
  }
}

export function isEmbedEndpointPath(pathname: string): boolean {
  return pathname === '/api/embed' || pathname.startsWith('/api/embed/');
}

export function isProxyStreamEndpointPath(pathname: string): boolean {
  return pathname === '/api/proxy/stream' || pathname.startsWith('/api/proxy/stream/');
}

export function isApiOrServerFnPath(pathname: string): boolean {
  const serverFnBase = process.env.TSS_SERVER_FN_BASE?.trim() || '/_serverFn';
  const normalizedServerFnBase = serverFnBase.endsWith('/')
    ? serverFnBase.slice(0, -1)
    : serverFnBase;
  return (
    pathname.startsWith('/api/') ||
    pathname === '/api' ||
    pathname === normalizedServerFnBase ||
    pathname.startsWith(`${normalizedServerFnBase}/`)
  );
}

export function shouldGenerateDocumentNonce(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return false;
  }
  const pathname = getPathname(request);
  return !isApiOrServerFnPath(pathname);
}

export interface ApplySecurityHeadersOptions {
  nonce?: string;
  nodeEnv?: string;
  workerBase?: string;
}

export function applySecurityHeaders(
  request: Request,
  response: Response,
  options: ApplySecurityHeadersOptions = {}
): Response {
  const pathname = getPathname(request);
  const https = isHttpsRequest(request);
  const headers = new Headers(response.headers);
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const isDev = nodeEnv === 'development';

  // 1. /api/embed mantém estritamente sua CSP sandbox, Referrer-Policy: no-referrer e X-Frame-Options: SAMEORIGIN
  if (isEmbedEndpointPath(pathname)) {
    if (!headers.has('X-Content-Type-Options')) {
      headers.set('X-Content-Type-Options', SECURITY_HEADER_VALUES.xContentTypeOptions);
    }
    if (https) {
      headers.set('Strict-Transport-Security', SECURITY_HEADER_VALUES.hsts);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // 2. /api/proxy/stream preserva headers de streaming/206/CORS e nunca recebe X-Frame-Options: DENY, COEP ou CORP restritivo
  if (isProxyStreamEndpointPath(pathname)) {
    headers.set('X-Content-Type-Options', SECURITY_HEADER_VALUES.xContentTypeOptions);
    if (!headers.has('Referrer-Policy')) {
      headers.set('Referrer-Policy', SECURITY_HEADER_VALUES.referrerPolicyDefault);
    }
    if (https) {
      headers.set('Strict-Transport-Security', SECURITY_HEADER_VALUES.hsts);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // 3. Headers independentes comuns para páginas e demais endpoints
  headers.set('X-Content-Type-Options', SECURITY_HEADER_VALUES.xContentTypeOptions);
  if (!headers.has('Referrer-Policy')) {
    headers.set('Referrer-Policy', SECURITY_HEADER_VALUES.referrerPolicyDefault);
  }
  if (https) {
    headers.set('Strict-Transport-Security', SECURITY_HEADER_VALUES.hsts);
  }

  const contentType = (headers.get('content-type') ?? '').toLowerCase();
  const isBodylessOrRedirect =
    response.status === 204 ||
    response.status === 304 ||
    (response.status >= 300 && response.status < 400);
  const isHtmlDocument =
    !isBodylessOrRedirect &&
    (contentType.includes('text/html') || (!isApiOrServerFnPath(pathname) && contentType === ''));

  if (isHtmlDocument) {
    if (!headers.has('X-Frame-Options')) {
      headers.set('X-Frame-Options', SECURITY_HEADER_VALUES.xFrameOptionsSameOrigin);
    }
    const cspPolicy = buildDocumentCsp({
      nonce: options.nonce,
      workerBase: options.workerBase,
    });
    if (isDev) {
      headers.set('Content-Security-Policy-Report-Only', cspPolicy);
    } else if (!headers.has('Content-Security-Policy')) {
      headers.set('Content-Security-Policy', cspPolicy);
    }
  } else if (!headers.has('X-Frame-Options')) {
    headers.set('X-Frame-Options', SECURITY_HEADER_VALUES.xFrameOptionsSameOrigin);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
