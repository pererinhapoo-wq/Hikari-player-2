const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_MAXIMAIMG_REFERER = 'https://www.anitube.biz/';
const LEGACY_MAXIMAIMG_REFERER = 'https://api.anivideo.net/';
const DEFAULT_COEMPREGOS_REFERER = 'https://www.coempregos.com.br/';
const EXTM3U_BYTES = [0x23, 0x45, 0x58, 0x54, 0x4d, 0x33, 0x55] as const; // "#EXTM3U"
const MAX_PEEK_BYTES = 512;
const MAX_URL_LENGTH = 8192;
const MAX_HLS_REWRITE_DEPTH = 2;
const SEGMENT_CACHE_TTL_SECONDS = 31536000; // 1 ano
const EXPIRABLE_SEGMENT_CACHE_TTL_SECONDS = 30;
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
    'Access-Control-Expose-Headers':
      'Accept-Ranges, Content-Length, Content-Range, CF-Cache-Status, X-Hikari-Source-Expirable',
  };
}

function hasExpirableHlsTokens(input: string): boolean {
  if (!input) return false;
  return /(?:x-amz-expires|(?:^|[?&#,;,\s"'])token=|(?:^|[?&#,;,\s"'])sig=)/i.test(input);
}

function isMaximaimgHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  return lower === 'maximaimg.online' || lower.endsWith('.maximaimg.online');
}

function isMywallpaperHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  return lower === 'mywallpaper-4k-image.net' || lower.endsWith('.mywallpaper-4k-image.net');
}

function isCdnSubdomainHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  const labels = lower.split('.').filter(Boolean);
  if (labels.length < 2) return false;
  return labels.slice(0, -1).some((label) => label.startsWith('cdn-'));
}

function matchesRefererPattern(hostname: string, pattern: string): number {
  if (pattern.startsWith('cdn-*.')) {
    const suffix = pattern.slice('cdn-*.'.length);
    if (
      suffix &&
      isCdnSubdomainHost(hostname) &&
      (hostname === suffix || hostname.endsWith(`.${suffix}`))
    ) {
      return pattern.length;
    }
    return -1;
  }
  if (hostname === pattern || hostname.endsWith(`.${pattern}`)) {
    return pattern.length;
  }
  return -1;
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

export async function createWorkerDepthSignature(
  targetUrl: string,
  expUnixSeconds: number,
  depth: number,
  secret: string
): Promise<string> {
  const key = await importHmacKey(secret);
  const payload = new TextEncoder().encode(`proxy-depth:${targetUrl}:${expUnixSeconds}:${depth}`);
  const sigBuf = await crypto.subtle.sign('HMAC', key, payload);
  return bytesToBase64Url(new Uint8Array(sigBuf));
}

export async function verifyWorkerProxyDepth(
  targetUrl: string,
  expParam: string | null,
  depthParam: string | null,
  depthSigParam: string | null,
  secret: string
): Promise<{ valid: boolean; depth: number; fromPlaylist: boolean }> {
  if (depthParam === null) {
    return { valid: true, depth: 0, fromPlaylist: false };
  }
  if (!expParam || !depthSigParam) {
    return { valid: false, depth: 0, fromPlaylist: false };
  }
  const exp = Number(expParam);
  const depth = Number(depthParam);
  if (
    !Number.isInteger(exp) ||
    !Number.isInteger(depth) ||
    depth < 1 ||
    depth > MAX_HLS_REWRITE_DEPTH + 1
  ) {
    return { valid: false, depth: 0, fromPlaylist: false };
  }

  const sigBytes = base64UrlToBytes(depthSigParam);
  if (!sigBytes || sigBytes.byteLength !== 32) {
    return { valid: false, depth: 0, fromPlaylist: false };
  }

  const key = await importHmacKey(secret);
  const payload = new TextEncoder().encode(`proxy-depth:${targetUrl}:${exp}:${depth}`);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes as unknown as BufferSource,
    payload as unknown as BufferSource
  );

  return valid
    ? { valid: true, depth, fromPlaylist: true }
    : { valid: false, depth: 0, fromPlaylist: false };
}

export async function createWorkerRefererSignature(
  targetUrl: string,
  expUnixSeconds: number,
  referer: string,
  secret: string
): Promise<string> {
  const key = await importHmacKey(secret);
  const payload = new TextEncoder().encode(`proxy-ref:${targetUrl}:${expUnixSeconds}:${referer}`);
  const sigBuf = await crypto.subtle.sign('HMAC', key, payload);
  return bytesToBase64Url(new Uint8Array(sigBuf));
}

export async function verifyWorkerProxyReferer(
  targetUrl: string,
  expParam: string | null,
  refParam: string | null,
  refSigParam: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<{ valid: boolean; referer: string | null }> {
  if (refParam === null) {
    return { valid: true, referer: null };
  }
  if (!expParam || !refSigParam || !refParam.trim()) {
    return { valid: false, referer: null };
  }
  const exp = Number(expParam);
  if (!Number.isInteger(exp) || exp < nowSeconds) {
    return { valid: false, referer: null };
  }
  let parsedRef: URL;
  try {
    parsedRef = new URL(refParam);
  } catch {
    return { valid: false, referer: null };
  }
  if (
    (parsedRef.protocol !== 'http:' && parsedRef.protocol !== 'https:') ||
    parsedRef.username ||
    parsedRef.password
  ) {
    return { valid: false, referer: null };
  }
  const sigBytes = base64UrlToBytes(refSigParam);
  if (!sigBytes || sigBytes.byteLength !== 32) {
    return { valid: false, referer: null };
  }
  const key = await importHmacKey(secret);
  const payload = new TextEncoder().encode(`proxy-ref:${targetUrl}:${exp}:${refParam}`);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes as unknown as BufferSource,
    payload as unknown as BufferSource
  );
  return valid ? { valid: true, referer: refParam } : { valid: false, referer: null };
}

export function getStableSegmentExpiry(nowSeconds = Math.floor(Date.now() / 1000)): number {
  return (Math.floor(nowSeconds / STABLE_SIGN_WINDOW_SECONDS) + 2) * STABLE_SIGN_WINDOW_SECONDS;
}

export function resolveUpstreamReferer(targetUrl: URL, env: WorkerEnv): string {
  const hostname = targetUrl.hostname.toLowerCase().replace(/\.+$/, '');
  const rules = new Map<string, string>([
    ['maximaimg.online', env.PLAYER_MAXIMAIMG_REFERER?.trim() || DEFAULT_MAXIMAIMG_REFERER],
    ['mywallpaper-4k-image.net', DEFAULT_MAXIMAIMG_REFERER],
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
    const matchLen = matchesRefererPattern(hostname, pattern);
    if (matchLen > bestMatchLen) {
      bestMatchLen = matchLen;
      bestReferer = refValue;
    }
  }

  if (bestReferer !== null) {
    return bestReferer;
  }

  if (isCdnSubdomainHost(hostname)) {
    return DEFAULT_MAXIMAIMG_REFERER;
  }

  return `${targetUrl.origin}/`;
}

export function resolveUpstreamRefererCandidates(
  targetUrl: URL,
  env: WorkerEnv,
  customReferer?: string | null
): string[] {
  const candidates: string[] = [];
  const pushUnique = (value: string) => {
    if (!candidates.includes(value)) {
      candidates.push(value);
    }
  };

  if (customReferer && customReferer.trim()) {
    const check = validateHttpUrl(customReferer);
    if (check.valid && check.normalizedUrl) {
      pushUnique(check.normalizedUrl);
    }
  }

  const primary = resolveUpstreamReferer(targetUrl, env);
  pushUnique(primary);

  const hostname = targetUrl.hostname.toLowerCase().replace(/\.+$/, '');
  const hostOrigin = `${targetUrl.origin}/`;

  if (isMaximaimgHost(hostname)) {
    pushUnique(DEFAULT_MAXIMAIMG_REFERER);
    pushUnique(LEGACY_MAXIMAIMG_REFERER);
    pushUnique(hostOrigin);
    pushUnique('');
    return candidates;
  }

  if (isMywallpaperHost(hostname)) {
    pushUnique(DEFAULT_MAXIMAIMG_REFERER);
    pushUnique(LEGACY_MAXIMAIMG_REFERER);
    pushUnique('');
    pushUnique(hostOrigin);
    return candidates;
  }

  if (isCdnSubdomainHost(hostname)) {
    pushUnique(DEFAULT_MAXIMAIMG_REFERER);
    pushUnique(LEGACY_MAXIMAIMG_REFERER);
    pushUnique(DEFAULT_COEMPREGOS_REFERER);
    pushUnique(hostOrigin);
    pushUnique('');
    return candidates;
  }

  pushUnique(hostOrigin);
  pushUnique('');
  return candidates;
}

export function getUpstreamHeaders(
  targetUrl: URL,
  incomingRequest: Request,
  env: WorkerEnv,
  customReferer?: string | null
): Headers {
  const headers = new Headers();
  headers.set('User-Agent', BROWSER_UA);
  headers.set('Accept', '*/*');

  let referer = resolveUpstreamReferer(targetUrl, env);
  if (customReferer && customReferer.trim()) {
    const check = validateHttpUrl(customReferer);
    if (check.valid && check.normalizedUrl) {
      referer = check.normalizedUrl;
    }
  }
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

export function shouldInspectForHlsManifest(
  contentType: string,
  targetUrl: URL,
  fromPlaylist = false
): boolean {
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
    lowerPath.endsWith('.m4v') ||
    lowerPath.endsWith('.webm') ||
    lowerPath.endsWith('.aac') ||
    lowerPath.endsWith('.mp3') ||
    lowerPath.endsWith('.vtt') ||
    lowerPath.endsWith('.srt') ||
    lowerPath.endsWith('.png') ||
    lowerPath.endsWith('.jpg') ||
    lowerPath.endsWith('.jpeg') ||
    lowerPath.endsWith('.gif') ||
    lowerPath.endsWith('.key')
  ) {
    return false;
  }
  if (
    lowerCt.includes('text/') ||
    lowerPath.endsWith('.m3u8') ||
    lowerPath.endsWith('.m3u')
  ) {
    return true;
  }
  return fromPlaylist;
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

function isPassthroughUriScheme(trimmedUri: string): boolean {
  const lower = trimmedUri.toLowerCase();
  return (
    lower.startsWith('data:') ||
    lower.startsWith('skd:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('javascript:')
  );
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
    if (!trimmed || isPassthroughUriScheme(trimmed)) {
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
      if (/^#EXT-X-PREFETCH:/i.test(trimmed)) {
        const rawPrefetchUri = trimmed.slice('#EXT-X-PREFETCH:'.length).trim();
        try {
          const proxied = await resolveAndSign(rawPrefetchUri);
          output.push(`#EXT-X-PREFETCH:${proxied}`);
        } catch {
          output.push(line);
        }
        continue;
      }

      const regex = /URI\s*=\s*(?:(["'])([^"']+)\1|([^,\s]+))/gi;
      let lastIndex = 0;
      let rebuilt = '';
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        rebuilt += line.slice(lastIndex, match.index);
        const quote = match[1];
        const uriValue = match[2] ?? match[3] ?? '';
        const outQuote = quote ?? '"';
        try {
          const proxied = await resolveAndSign(uriValue);
          rebuilt += `URI=${outQuote}${proxied}${outQuote}`;
        } catch {
          rebuilt += quote ? `URI=${quote}${uriValue}${quote}` : `URI=${uriValue}`;
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
  const isExpirable = Boolean(targetUrl && hasExpirableHlsTokens(targetUrl.toString()));
  const cacheHeader = isExpirable
    ? `public, max-age=${EXPIRABLE_SEGMENT_CACHE_TTL_SECONDS}, must-revalidate`
    : `public, max-age=${SEGMENT_CACHE_TTL_SECONDS}, immutable`;
  outHeaders.set('Cache-Control', cacheHeader);
  outHeaders.set('CDN-Cache-Control', cacheHeader);
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

function buildManifestResponseHeaders(upstream: Response, isExpirable = false): Headers {
  const outHeaders = new Headers(getCorsHeaders());
  outHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  outHeaders.set('Cache-Control', `public, max-age=${MANIFEST_CACHE_TTL_SECONDS}`);
  outHeaders.set('CDN-Cache-Control', `public, max-age=${MANIFEST_CACHE_TTL_SECONDS}, stale-while-revalidate=30`);
  if (isExpirable) {
    outHeaders.set('X-Hikari-Source-Expirable', '1');
  }

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

async function cancelResponseBodySafely(res: Response): Promise<void> {
  if (!res.body) return;
  try {
    await res.body.cancel();
  } catch {
    // Ignorar erro ao descartar corpo anterior
  }
}

async function fetchWith403RefererFallbackWorker(
  targetUrl: URL,
  incomingRequest: Request,
  env: WorkerEnv,
  cf: CloudflareCfProperties,
  fetcher: (input: string, init?: CfRequestInit) => Promise<Response>,
  customReferer?: string | null
): Promise<{
  response: Response;
  finalUrl: string;
  winningReferer: string;
  usedFallback: boolean;
}> {
  const baseHeaders = getUpstreamHeaders(targetUrl, incomingRequest, env, customReferer);
  const refererCandidates = resolveUpstreamRefererCandidates(targetUrl, env, customReferer);

  let lastResult: { response: Response; finalUrl: string } | null = null;

  for (let i = 0; i < refererCandidates.length; i++) {
    const candidateRef = refererCandidates[i];
    const headers = new Headers(baseHeaders);
    if (candidateRef) {
      headers.set('Referer', candidateRef);
    } else {
      headers.delete('Referer');
    }

    if (lastResult) {
      await cancelResponseBodySafely(lastResult.response);
    }

    lastResult = await fetchWithRedirectsSafe(
      targetUrl.toString(),
      {
        method: incomingRequest.method,
        headers,
        cf,
      },
      fetcher
    );

    if (lastResult.response.status !== 403) {
      return {
        ...lastResult,
        winningReferer: candidateRef,
        usedFallback: i > 0,
      };
    }
  }

  return {
    ...lastResult!,
    winningReferer: refererCandidates[refererCandidates.length - 1] ?? '',
    usedFallback: refererCandidates.length > 1,
  };
}

function buildStableEdgeCacheRequest(targetUrl: string, depth = 0): Request {
  const cacheUrl = new URL('https://hikari-edge-cache.internal/v1');
  cacheUrl.searchParams.set('url', targetUrl);
  if (depth > 0) {
    cacheUrl.searchParams.set('d', String(depth));
  }
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

function looksLikeBinaryMediaPrefix(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  if (bytes[0] === 0x47) return true;
  for (let i = 0; i < Math.min(bytes.length, 64); i++) {
    if (bytes[i] === 0x00) return true;
  }
  return false;
}

function isInvalidHtmlManifestResponse(
  bytes: Uint8Array,
  contentType: string,
  targetUrl: URL
): boolean {
  if (looksLikeBinaryMediaPrefix(bytes)) {
    return false;
  }

  const lowerCt = contentType.toLowerCase();
  const lowerPath = targetUrl.pathname.toLowerCase();
  const isManifestTarget =
    lowerPath.endsWith('.m3u8') ||
    lowerPath.endsWith('.m3u') ||
    lowerCt.includes('mpegurl') ||
    lowerCt.includes('m3u8');

  if (lowerCt.includes('text/html') || lowerCt.includes('application/xhtml')) {
    return true;
  }

  if (!isManifestTarget) {
    return false;
  }

  const headText = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, 256))
    .trimStart()
    .toLowerCase();

  return (
    headText.startsWith('<!doctype') ||
    headText.startsWith('<html') ||
    headText.startsWith('<head') ||
    headText.startsWith('<body') ||
    headText.startsWith('<?xml')
  );
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
  const depthParam = reqUrl.searchParams.get('d');
  const depthSigParam = reqUrl.searchParams.get('dsig');
  const refParam = reqUrl.searchParams.get('ref');
  const refSigParam = reqUrl.searchParams.get('rsig');

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

  const depthCheck = await verifyWorkerProxyDepth(
    urlCheck.normalizedUrl,
    exp,
    depthParam,
    depthSigParam,
    secret
  );
  if (!depthCheck.valid) {
    return new Response('Assinatura de profundidade do proxy inválida.', {
      status: 403,
      headers: getCorsHeaders(),
    });
  }

  const refCheck = await verifyWorkerProxyReferer(
    urlCheck.normalizedUrl,
    exp,
    refParam,
    refSigParam,
    secret,
    nowSeconds
  );
  if (!refCheck.valid) {
    return new Response('Assinatura de Referer do proxy inválida.', {
      status: 403,
      headers: getCorsHeaders(),
    });
  }

  const normalizedTargetUrl = urlCheck.normalizedUrl;
  const targetIsExpirable = hasExpirableHlsTokens(normalizedTargetUrl);
  const rangeHeader = request.headers.get('range');
  const edgeCache = deps.edgeCache !== undefined ? deps.edgeCache : getDefaultEdgeCache();
  const cacheKeyReq = !rangeHeader && request.method === 'GET' && !targetIsExpirable && !refCheck.referer
    ? buildStableEdgeCacheRequest(normalizedTargetUrl, depthCheck.depth)
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
    const isLikelyManifest = shouldInspectForHlsManifest('', targetUrl);
    const cfTtl = isLikelyManifest
      ? MANIFEST_CACHE_TTL_SECONDS
      : targetIsExpirable
        ? EXPIRABLE_SEGMENT_CACHE_TTL_SECONDS
        : SEGMENT_CACHE_TTL_SECONDS;

    const {
      response: upstream,
      finalUrl,
      winningReferer,
      usedFallback,
    } = await fetchWith403RefererFallbackWorker(
      targetUrl,
      request,
      env,
      {
        cacheEverything: true,
        cacheTtl: cfTtl,
      },
      fetcher,
      refCheck.referer
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
    const nextDepth = depthCheck.depth + 1;
    const propagatedReferer =
      winningReferer && (usedFallback || Boolean(refCheck.referer))
        ? winningReferer
        : null;

    const signChildUrl = async (resolvedUrl: string): Promise<string> => {
      const childSig = await createWorkerProxySignature(resolvedUrl, stableExp, secret);
      const childDepthSig = await createWorkerDepthSignature(resolvedUrl, stableExp, nextDepth, secret);
      const params = new URLSearchParams({
        url: resolvedUrl,
        exp: String(stableExp),
        sig: childSig,
        d: String(nextDepth),
        dsig: childDepthSig,
      });
      if (propagatedReferer) {
        const childRefSig = await createWorkerRefererSignature(
          resolvedUrl,
          stableExp,
          propagatedReferer,
          secret
        );
        params.set('ref', propagatedReferer);
        params.set('rsig', childRefSig);
      }
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

    if (
      request.method === 'GET' &&
      upstream.status !== 206 &&
      shouldInspectForHlsManifest(contentType, finalParsed, depthCheck.fromPlaylist)
    ) {
      if (!upstream.body) {
        const rawBytes = new Uint8Array(await upstream.arrayBuffer());
        if (bytesStartWithExtM3u(rawBytes)) {
          if (depthCheck.depth > MAX_HLS_REWRITE_DEPTH) {
            return new Response(
              `Profundidade máxima de playlist HLS (${MAX_HLS_REWRITE_DEPTH}) excedida.`,
              {
                status: 502,
                headers: getCorsHeaders(),
              }
            );
          }
          const text = new TextDecoder('utf-8').decode(rawBytes);
          const isExpirable =
            targetIsExpirable ||
            hasExpirableHlsTokens(finalUrl) ||
            hasExpirableHlsTokens(text);
          const rewritten = await rewriteM3u8PlaylistAsync(text, finalUrl, signChildUrl);
          return cacheIfEligible(
            new Response(rewritten, {
              status: 200,
              headers: buildManifestResponseHeaders(upstream, isExpirable),
            })
          );
        }
        if (isInvalidHtmlManifestResponse(rawBytes, contentType, finalParsed)) {
          return new Response('Origem retornou página HTML em vez de manifesto HLS válido.', {
            status: 502,
            headers: getCorsHeaders(),
          });
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
        if (depthCheck.depth > MAX_HLS_REWRITE_DEPTH) {
          try {
            await reader.cancel();
          } catch {
            // Ignorar erro ao cancelar leitura excedente
          }
          return new Response(
            `Profundidade máxima de playlist HLS (${MAX_HLS_REWRITE_DEPTH}) excedida.`,
            {
              status: 502,
              headers: getCorsHeaders(),
            }
          );
        }
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
        const isExpirable =
          targetIsExpirable ||
          hasExpirableHlsTokens(finalUrl) ||
          hasExpirableHlsTokens(text);
        const rewritten = await rewriteM3u8PlaylistAsync(text, finalUrl, signChildUrl);
        return cacheIfEligible(
          new Response(rewritten, {
            status: 200,
            headers: buildManifestResponseHeaders(upstream, isExpirable),
          })
        );
      }

      if (isInvalidHtmlManifestResponse(initialBytes, contentType, finalParsed)) {
        try {
          await reader.cancel();
        } catch {
          // Ignorar erro ao cancelar leitura HTML inválida
        }
        return new Response('Origem retornou página HTML em vez de manifesto HLS válido.', {
          status: 502,
          headers: getCorsHeaders(),
        });
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
