const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_MAXIMAIMG_REFERER = 'https://api.anivideo.net/';
const EXTM3U_BYTES = [0x23, 0x45, 0x58, 0x54, 0x4d, 0x33, 0x55] as const; // "#EXTM3U"
const MAX_PEEK_BYTES = 512;
const MAX_URL_LENGTH = 2048;
const SEGMENT_CACHE_TTL_SECONDS = 31536000; // 1 ano
const MANIFEST_CACHE_TTL_SECONDS = 5;
const STABLE_SIGN_WINDOW_SECONDS = 60 * 60 * 24 * 7; // 7 dias (chave de cache estável)

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
]);

export interface WorkerEnv {
  PLAYER_SESSION_SECRET: string;
  PLAYER_MAXIMAIMG_REFERER?: string;
  PLAYER_REFERER_MAP?: string;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface CloudflareCfProperties {
  cacheEverything?: boolean;
  cacheTtl?: number;
}

export type CfRequestInit = RequestInit & {
  cf?: CloudflareCfProperties;
};

export interface WorkerFetchDeps {
  fetcher?: (input: string, init?: CfRequestInit) => Promise<Response>;
  edgeCache?: Cache | null;
  nowSeconds?: () => number;
}

function getCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Accept, Content-Type',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, CF-Cache-Status',
  };
}

function isMaximaimgHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'maximaimg.online' || lower.endsWith('.maximaimg.online');
}

function validateHttpUrl(raw: string): { valid: boolean; normalizedUrl?: string } {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) {
    return { valid: false };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false };
  }
  if (parsed.username || parsed.password || !parsed.hostname) {
    return { valid: false };
  }
  return { valid: true, normalizedUrl: parsed.toString() };
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function isPrivateOrBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !host ||
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }

  if (isIpv4Literal(host)) {
    return isPrivateIpv4(host);
  }

  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true;
    if (
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb')
    ) {
      return true;
    }
    if (host.startsWith('ff')) return true;
    if (host.startsWith('::ffff:')) {
      const mapped = host.slice('::ffff:'.length);
      return isIpv4Literal(mapped) ? isPrivateIpv4(mapped) : true;
    }
  }

  return false;
}

function assertSafeExternalUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('URL inválida para requisição externa.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Protocolo não permitido.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Credenciais na URL não são permitidas.');
  }
  if (isPrivateOrBlockedHostname(parsed.hostname)) {
    throw new Error('Destino de rede interno ou reservado bloqueado.');
  }
  return parsed;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(input: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    return null;
  }
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const keyBytes = new TextEncoder().encode(secret);
  return await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function createWorkerProxySignature(
  targetUrl: string,
  expUnixSeconds: number,
  secret: string
): Promise<string> {
  const key = await importHmacKey(secret);
  const payload = new TextEncoder().encode(`proxy:${targetUrl}:${expUnixSeconds}`);
  const sigBuf = await crypto.subtle.sign('HMAC', key, payload);
  return bytesToBase64Url(new Uint8Array(sigBuf));
}

export async function verifyWorkerProxySignature(
  targetUrl: string,
  expParam: string | null,
  sigParam: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  if (!expParam || !sigParam) return false;
  const exp = Number(expParam);
  if (!Number.isInteger(exp) || exp < nowSeconds) return false;

  const sigBytes = base64UrlToBytes(sigParam);
  if (!sigBytes || sigBytes.byteLength !== 32) return false;

  const key = await importHmacKey(secret);
  const payload = new TextEncoder().encode(`proxy:${targetUrl}:${exp}`);
  return await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes as unknown as BufferSource,
    payload as unknown as BufferSource
  );
}

export function getStableSegmentExpiry(nowSeconds = Math.floor(Date.now() / 1000)): number {
  return (Math.floor(nowSeconds / STABLE_SIGN_WINDOW_SECONDS) + 2) * STABLE_SIGN_WINDOW_SECONDS;
}

export function resolveUpstreamReferer(targetUrl: URL, env: WorkerEnv): string {
  const hostname = targetUrl.hostname.toLowerCase();
  const rules = new Map<string, string>([
    ['maximaimg.online', env.PLAYER_MAXIMAIMG_REFERER?.trim() || DEFAULT_MAXIMAIMG_REFERER],
    ['mywallpaper-4k-image.net', ''],
  ]);

  const rawMap = env.PLAYER_REFERER_MAP?.trim();
  if (rawMap) {
    try {
      const parsed = JSON.parse(rawMap) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [rawPattern, rawRef] of Object.entries(parsed)) {
          if (typeof rawRef !== 'string') continue;
          const pattern = rawPattern.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '');
          if (!pattern) continue;
          const trimmedRef = rawRef.trim();
          if (trimmedRef === '') {
            rules.set(pattern, '');
            continue;
          }
          const refCheck = validateHttpUrl(trimmedRef);
          if (refCheck.valid && refCheck.normalizedUrl) {
            rules.set(pattern, refCheck.normalizedUrl);
          }
        }
      }
    } catch {
      // Ignora JSON inválido e usa fallback abaixo
    }
  }

  let bestMatchLen = -1;
  let bestReferer: string | null = null;
  for (const [pattern, refValue] of rules.entries()) {
    if (hostname === pattern || hostname.endsWith(`.${pattern}`)) {
      if (pattern.length > bestMatchLen) {
        bestMatchLen = pattern.length;
        bestReferer = refValue;
      }
    }
  }

  if (bestReferer !== null) {
    return bestReferer;
  }

  return `${targetUrl.origin}/`;
}

export function getUpstreamHeaders(
  targetUrl: URL,
  incomingRequest: Request,
  env: WorkerEnv
): Headers {
  const headers = new Headers();
  headers.set('User-Agent', BROWSER_UA);
  headers.set('Accept', '*/*');

  const referer = resolveUpstreamReferer(targetUrl, env);
  if (referer) {
    headers.set('Referer', referer);
  }

  // Encaminhar apenas Range para seeking; remover explicitamente Origin.
  const range = incomingRequest.headers.get('range');
  if (range) {
    headers.set('Range', range);
  }
  headers.delete('Origin');

  return headers;
}

export function shouldInspectForHlsManifest(contentType: string, targetUrl: URL): boolean {
  const lowerCt = contentType.toLowerCase();
  const lowerPath = targetUrl.pathname.toLowerCase();
  if (lowerCt.includes('mpegurl') || lowerCt.includes('m3u8')) {
    return true;
  }
  if (
    lowerPath.endsWith('.webp') ||
    lowerPath.endsWith('.ts') ||
    lowerPath.endsWith('.m4s') ||
    lowerPath.endsWith('.mp4') ||
    lowerPath.endsWith('.webm') ||
    lowerPath.endsWith('.aac')
  ) {
    return false;
  }
  return (
    lowerCt.includes('text/') ||
    lowerPath.endsWith('.m3u8') ||
    lowerPath.endsWith('.m3u')
  );
}

function bytesStartWithExtM3u(bytes: Uint8Array): boolean {
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offset = 3;
  }
  while (
    offset < bytes.length &&
    (bytes[offset] === 0x20 ||
      bytes[offset] === 0x09 ||
      bytes[offset] === 0x0a ||
      bytes[offset] === 0x0d)
  ) {
    offset++;
  }
  if (bytes.length - offset < EXTM3U_BYTES.length) {
    return false;
  }
  for (let i = 0; i < EXTM3U_BYTES.length; i++) {
    if (bytes[offset + i] !== EXTM3U_BYTES[i]) {
      return false;
    }
  }
  return true;
}

function hasEnoughBytesToDecide(prefix: Uint8Array): boolean {
  let offset = 0;
  if (prefix.length >= 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf) {
    offset = 3;
  }
  while (
    offset < prefix.length &&
    (prefix[offset] === 0x20 ||
      prefix[offset] === 0x09 ||
      prefix[offset] === 0x0a ||
      prefix[offset] === 0x0d)
  ) {
    offset++;
  }
  return prefix.length - offset >= EXTM3U_BYTES.length || prefix.length >= MAX_PEEK_BYTES;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    merged.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return merged;
}

async function rewriteM3u8PlaylistAsync(
  playlistContent: string,
  baseUrl: string,
  signFn: (resolvedUrl: string) => Promise<string>
): Promise<string> {
  const lines = playlistContent.split(/\r?\n/);
  const cache = new Map<string, string>();

  const resolveAndSign = async (rawUri: string): Promise<string> => {
    const trimmed = rawUri.trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('skd:')) {
      return rawUri;
    }
    const absolute = new URL(trimmed, baseUrl).toString();
    const cached = cache.get(absolute);
    if (cached) return cached;
    const signed = await signFn(absolute);
    cache.set(absolute, signed);
    return signed;
  };

  const output: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      output.push(line);
      continue;
    }

    if (trimmed.startsWith('#')) {
      const regex = /URI=(["'])([^"']+)\1/gi;
      let lastIndex = 0;
      let rebuilt = '';
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        rebuilt += line.slice(lastIndex, match.index);
        const quote = match[1];
        const uriValue = match[2];
        try {
          const proxied = await resolveAndSign(uriValue);
          rebuilt += `URI=${quote}${proxied}${quote}`;
        } catch {
          rebuilt += `URI=${quote}${uriValue}${quote}`;
        }
        lastIndex = regex.lastIndex;
      }
      rebuilt += line.slice(lastIndex);
      output.push(rebuilt);
      continue;
    }

    try {
      output.push(await resolveAndSign(trimmed));
    } catch {
      output.push(line);
    }
  }

  return output.join('\n');
}

function resolveBinaryContentType(contentType: string, targetUrl?: URL): string {
  const lowerCt = contentType.toLowerCase();
  if (targetUrl && targetUrl.pathname.toLowerCase().endsWith('.webp')) {
    if (!lowerCt || lowerCt.startsWith('image/') || lowerCt === 'application/octet-stream') {
      return 'video/mp2t';
    }
  }
  return contentType || 'application/octet-stream';
}

function buildBinaryResponseHeaders(
  upstream: Response,
  contentType: string,
  targetUrl?: URL
): Headers {
  const outHeaders = new Headers(getCorsHeaders());
  outHeaders.set('Content-Type', resolveBinaryContentType(contentType, targetUrl));
  outHeaders.set('Cache-Control', `public, max-age=${SEGMENT_CACHE_TTL_SECONDS}, immutable`);
  outHeaders.set('CDN-Cache-Control', `public, max-age=${SEGMENT_CACHE_TTL_SECONDS}, immutable`);
  outHeaders.set('X-Content-Type-Options', 'nosniff');

  const passthroughHeaders = [
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'cf-cache-status',
  ];
  for (const h of passthroughHeaders) {
    const val = upstream.headers.get(h);
    if (val) outHeaders.set(h, val);
  }

  return outHeaders;
}

function buildManifestResponseHeaders(upstream: Response): Headers {
  const outHeaders = new Headers(getCorsHeaders());
  outHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  outHeaders.set('Cache-Control', `public, max-age=${MANIFEST_CACHE_TTL_SECONDS}`);
  outHeaders.set('CDN-Cache-Control', `public, max-age=${MANIFEST_CACHE_TTL_SECONDS}, stale-while-revalidate=30`);

  const cfStatus = upstream.headers.get('cf-cache-status');
  if (cfStatus) {
    outHeaders.set('CF-Cache-Status', cfStatus);
  }

  return outHeaders;
}

async function fetchWithRedirectsSafe(
  initialUrl: string,
  init: CfRequestInit,
  fetcher: (input: string, init?: CfRequestInit) => Promise<Response>,
  maxRedirects = 5
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validatedUrl = assertSafeExternalUrl(currentUrl);
    const response = await fetcher(validatedUrl.toString(), {
      ...init,
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error('Redirecionamento sem cabeçalho Location.');
      }
      if (hop === maxRedirects) {
        throw new Error('Número máximo de redirecionamentos excedido.');
      }
      currentUrl = new URL(location, validatedUrl).toString();
      continue;
    }

    return {
      response,
      finalUrl: validatedUrl.toString(),
    };
  }

  throw new Error('Falha ao seguir redirecionamentos.');
}

function buildStableEdgeCacheRequest(targetUrl: string): Request {
  const cacheUrl = new URL('https://hikari-edge-cache.internal/v1');
  cacheUrl.searchParams.set('url', targetUrl);
  return new Request(cacheUrl.toString(), { method: 'GET' });
}

function getDefaultEdgeCache(): Cache | null {
  try {
    const globalCaches = caches as unknown as { default?: Cache };
    return globalCaches?.default ?? null;
  } catch {
    return null;
  }
}

export async function handleWorkerProxyRequest(
  request: Request,
  env: WorkerEnv,
  ctx?: WorkerExecutionContext,
  deps: WorkerFetchDeps = {}
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...getCorsHeaders(),
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Método não permitido.', {
      status: 405,
      headers: getCorsHeaders(),
    });
  }

  const secret = env.PLAYER_SESSION_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return new Response('PLAYER_SESSION_SECRET não configurado no Worker.', {
      status: 500,
      headers: getCorsHeaders(),
    });
  }

  const reqUrl = new URL(request.url);
  const rawTarget = reqUrl.searchParams.get('url') ?? '';
  const exp = reqUrl.searchParams.get('exp');
  const sig = reqUrl.searchParams.get('sig');

  const urlCheck = validateHttpUrl(rawTarget);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    return new Response('Parâmetro de URL inválido.', {
      status: 400,
      headers: getCorsHeaders(),
    });
  }

  const nowSeconds = deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000);
  const signatureValid = await verifyWorkerProxySignature(
    urlCheck.normalizedUrl,
    exp,
    sig,
    secret,
    nowSeconds
  );
  if (!signatureValid) {
    return new Response('Assinatura de proxy inválida ou expirada.', {
      status: 403,
      headers: getCorsHeaders(),
    });
  }

  const normalizedTargetUrl = urlCheck.normalizedUrl;
  const rangeHeader = request.headers.get('range');
  const edgeCache = deps.edgeCache !== undefined ? deps.edgeCache : getDefaultEdgeCache();
  const cacheKeyReq = !rangeHeader && request.method === 'GET'
    ? buildStableEdgeCacheRequest(normalizedTargetUrl)
    : null;

  if (edgeCache && cacheKeyReq) {
    try {
      const cached = await edgeCache.match(cacheKeyReq);
      if (cached) {
        const hitHeaders = new Headers(cached.headers);
        for (const [k, v] of Object.entries(getCorsHeaders())) {
          hitHeaders.set(k, v);
        }
        hitHeaders.set('CF-Cache-Status', 'HIT');
        return new Response(cached.body, {
          status: cached.status,
          headers: hitHeaders,
        });
      }
    } catch {
      // Ignora erro da Cache API e segue para origem
    }
  }

  const fetcher =
    deps.fetcher ?? ((input: string, init?: CfRequestInit) => fetch(input, init));

  try {
    const targetUrl = new URL(normalizedTargetUrl);
    const upstreamHeaders = getUpstreamHeaders(targetUrl, request, env);
    const isLikelyManifest = shouldInspectForHlsManifest('', targetUrl);
    const cfTtl = isLikelyManifest ? MANIFEST_CACHE_TTL_SECONDS : SEGMENT_CACHE_TTL_SECONDS;

    const { response: upstream, finalUrl } = await fetchWithRedirectsSafe(
      targetUrl.toString(),
      {
        method: request.method,
        headers: upstreamHeaders,
        cf: {
          cacheEverything: true,
          cacheTtl: cfTtl,
        },
      },
      fetcher
    );

    if (!upstream.ok && upstream.status !== 206) {
      return new Response(`Origem retornou erro HTTP ${upstream.status}.`, {
        status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
        headers: getCorsHeaders(),
      });
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const finalParsed = new URL(finalUrl);
    const proxyPath = reqUrl.pathname || '/api/proxy/stream';
    const stableExp = getStableSegmentExpiry(nowSeconds);

    const signChildUrl = async (resolvedUrl: string): Promise<string> => {
      const childSig = await createWorkerProxySignature(resolvedUrl, stableExp, secret);
      const params = new URLSearchParams({
        url: resolvedUrl,
        exp: String(stableExp),
        sig: childSig,
      });
      return `${proxyPath}?${params.toString()}`;
    };

    const cacheIfEligible = (res: Response): Response => {
      if (edgeCache && cacheKeyReq && res.status === 200) {
        const putPromise = edgeCache.put(cacheKeyReq, res.clone()).catch(() => {});
        if (ctx) {
          ctx.waitUntil(putPromise);
        }
      }
      return res;
    };

    if (request.method === 'GET' && upstream.status !== 206 && shouldInspectForHlsManifest(contentType, finalParsed)) {
      if (!upstream.body) {
        const rawBytes = new Uint8Array(await upstream.arrayBuffer());
        if (bytesStartWithExtM3u(rawBytes)) {
          const text = new TextDecoder('utf-8').decode(rawBytes);
          const rewritten = await rewriteM3u8PlaylistAsync(text, finalUrl, signChildUrl);
          return cacheIfEligible(
            new Response(rewritten, {
              status: 200,
              headers: buildManifestResponseHeaders(upstream),
            })
          );
        }
        return cacheIfEligible(
          new Response(rawBytes, {
            status: upstream.status,
            headers: buildBinaryResponseHeaders(upstream, contentType, finalParsed),
          })
        );
      }

      const reader = upstream.body.getReader();
      const bufferedChunks: Uint8Array[] = [];
      let streamEnded = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          streamEnded = true;
          break;
        }
        if (value && value.byteLength > 0) {
          bufferedChunks.push(value);
          if (hasEnoughBytesToDecide(concatChunks(bufferedChunks))) {
            break;
          }
        }
      }

      const initialBytes = concatChunks(bufferedChunks);
      if (bytesStartWithExtM3u(initialBytes)) {
        while (!streamEnded) {
          const { done, value } = await reader.read();
          if (done) {
            streamEnded = true;
            break;
          }
          if (value && value.byteLength > 0) {
            bufferedChunks.push(value);
          }
        }
        const text = new TextDecoder('utf-8').decode(concatChunks(bufferedChunks));
        const rewritten = await rewriteM3u8PlaylistAsync(text, finalUrl, signChildUrl);
        return cacheIfEligible(
          new Response(rewritten, {
            status: 200,
            headers: buildManifestResponseHeaders(upstream),
          })
        );
      }

      const outHeaders = buildBinaryResponseHeaders(upstream, contentType, finalParsed);
      let chunkIndex = 0;
      const passthroughStream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (chunkIndex < bufferedChunks.length) {
            controller.enqueue(bufferedChunks[chunkIndex]);
            chunkIndex++;
            return;
          }
          if (streamEnded) {
            controller.close();
            return;
          }
          const { done, value } = await reader.read();
          if (done) {
            streamEnded = true;
            controller.close();
            return;
          }
          if (value && value.byteLength > 0) {
            controller.enqueue(value);
          }
        },
        async cancel() {
          try {
            await reader.cancel();
          } catch {
            // Ignorar erro ao cancelar leitura
          }
        },
      });

      return cacheIfEligible(
        new Response(passthroughStream, {
          status: upstream.status,
          headers: outHeaders,
        })
      );
    }

    const outHeaders = buildBinaryResponseHeaders(upstream, contentType, finalParsed);
    return cacheIfEligible(
      new Response(upstream.body, {
        status: upstream.status,
        headers: outHeaders,
      })
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Falha ao processar stream via Worker.';
    return new Response(message, {
      status: 502,
      headers: getCorsHeaders(),
    });
  }
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: WorkerExecutionContext
  ): Promise<Response> {
    return await handleWorkerProxyRequest(request, env, ctx);
  },
};
