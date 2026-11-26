import {
  buildSignedProxyPath,
  MAX_HLS_REWRITE_DEPTH,
  rewriteM3u8Playlist,
  verifyProxyDepth,
  verifyProxyExpirable,
  verifyProxyReferer,
  verifyProxySignature,
} from '@/lib/proxy-signing';
import { isAllowedProxyMediaUrl, safeFetchWithRedirects } from '@/lib/ssrf';
import {
  DIRECT_MEDIA_HOSTS,
  extractExpirableTokenRemainingSeconds,
  hasExpirableHlsTokens,
  isDirectMediaHost,
  isMaximaimgHost,
  isR2StorageHost,
  isR2StorageUrl,
  validateHttpUrl,
} from '@/lib/video-sources';

export { DIRECT_MEDIA_HOSTS, isDirectMediaHost };
const MAX_PROXY_URL_LENGTH = 8192;

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const DEFAULT_ANITUBE_BIZ_REFERER = 'https://www.anitube.biz/';
export const LEGACY_MAXIMAIMG_REFERER = 'https://api.anivideo.net/';
export const DEFAULT_COEMPREGOS_REFERER = 'https://www.coempregos.com.br/';
export const LEARNED_REFERER_TTL_SECONDS = 15 * 60; // 15 minutos
const MAX_LEARNED_REFERER_ENTRIES = 256;
const EXTM3U_BYTES = [0x23, 0x45, 0x58, 0x54, 0x4d, 0x33, 0x55] as const; // "#EXTM3U"
const MAX_PEEK_BYTES = 512;

export interface LearnedRefererStore {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string, ttlSeconds: number): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

interface LearnedRefererEntry {
  referer: string;
  expiresAtMs: number;
}

const learnedRefererMemory = new Map<string, LearnedRefererEntry>();

export function clearLearnedRefererCache(): void {
  learnedRefererMemory.clear();
}

function resolveRefererCacheEnvScope(): string {
  const vercelEnv = process.env.VERCEL_ENV?.trim().toLowerCase();
  if (vercelEnv) {
    if (vercelEnv === 'preview') {
      const vercelUrl = process.env.VERCEL_URL?.trim().toLowerCase();
      return vercelUrl ? `preview:${vercelUrl}` : 'preview';
    }
    return vercelEnv;
  }
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  return nodeEnv || 'default';
}

function buildLearnedRefererKey(envScope: string, hostname: string): string {
  return `${envScope}|${hostname}`;
}

function normalizeStoredReferer(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw === '') return '';
  const check = validateHttpUrl(raw);
  if (check.valid && check.normalizedUrl) {
    return check.normalizedUrl;
  }
  return null;
}

function createMemoryLearnedRefererStore(nowMs: () => number): LearnedRefererStore {
  return {
    get(key: string): string | null {
      const entry = learnedRefererMemory.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs <= nowMs()) {
        learnedRefererMemory.delete(key);
        return null;
      }
      const normalized = normalizeStoredReferer(entry.referer);
      if (normalized === null) {
        learnedRefererMemory.delete(key);
        return null;
      }
      return normalized;
    },
    set(key: string, value: string, ttlSeconds: number): void {
      const normalized = normalizeStoredReferer(value);
      if (normalized === null || ttlSeconds <= 0) return;
      if (!learnedRefererMemory.has(key) && learnedRefererMemory.size >= MAX_LEARNED_REFERER_ENTRIES) {
        const oldestKey = learnedRefererMemory.keys().next().value;
        if (oldestKey !== undefined) {
          learnedRefererMemory.delete(oldestKey);
        }
      }
      learnedRefererMemory.set(key, {
        referer: normalized,
        expiresAtMs: nowMs() + ttlSeconds * 1000,
      });
    },
    delete(key: string): void {
      learnedRefererMemory.delete(key);
    },
  };
}

export function isMywallpaperHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  return lower === 'mywallpaper-4k-image.net' || lower.endsWith('.mywallpaper-4k-image.net');
}

export function isCdnSubdomainHost(hostname: string): boolean {
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

function resolveUpstreamRefererMatch(
  targetUrl: URL,
  refererMapJson = process.env.PLAYER_REFERER_MAP,
  maximaimgReferer = process.env.PLAYER_MAXIMAIMG_REFERER
): { primary: string; matchedRule: boolean } {
  const hostname = targetUrl.hostname.toLowerCase().replace(/\.+$/, '');

  const rules = new Map<string, string>([
    ['maximaimg.online', maximaimgReferer?.trim() || DEFAULT_ANITUBE_BIZ_REFERER],
    ['mywallpaper-4k-image.net', DEFAULT_ANITUBE_BIZ_REFERER],
    ['public.blob.vercel-storage.com', ''],
    ['anitube22.vip', DEFAULT_COEMPREGOS_REFERER],
    ['anitube.biz', DEFAULT_COEMPREGOS_REFERER],
    ['anitube.zip', DEFAULT_COEMPREGOS_REFERER],
    ['anitube.ninja', DEFAULT_COEMPREGOS_REFERER],
    ['hinatasoul.com', DEFAULT_COEMPREGOS_REFERER],
  ]);

  const rawMap = refererMapJson?.trim();
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
          const check = validateHttpUrl(trimmedRef);
          if (check.valid && check.normalizedUrl) {
            rules.set(pattern, check.normalizedUrl);
          }
        }
      }
    } catch {
      // Ignora JSON inválido e mantém mapa padrão
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
    return { primary: bestReferer, matchedRule: true };
  }

  if (isCdnSubdomainHost(hostname)) {
    return { primary: DEFAULT_ANITUBE_BIZ_REFERER, matchedRule: false };
  }

  return { primary: `${targetUrl.origin}/`, matchedRule: false };
}

export function resolveUpstreamReferer(
  targetUrl: URL,
  refererMapJson = process.env.PLAYER_REFERER_MAP,
  maximaimgReferer = process.env.PLAYER_MAXIMAIMG_REFERER
): string {
  return resolveUpstreamRefererMatch(targetUrl, refererMapJson, maximaimgReferer).primary;
}

export function resolveUpstreamRefererCandidates(
  targetUrl: URL,
  refererMapJson = process.env.PLAYER_REFERER_MAP,
  maximaimgReferer = process.env.PLAYER_MAXIMAIMG_REFERER,
  customReferer?: string | null,
  learnedReferer?: string | null
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

  const hostname = targetUrl.hostname.toLowerCase().replace(/\.+$/, '');
  const hostOrigin = `${targetUrl.origin}/`;

  if (!isMaximaimgHost(hostname) && learnedReferer !== undefined && learnedReferer !== null) {
    const normalizedLearned = normalizeStoredReferer(learnedReferer);
    if (normalizedLearned !== null) {
      pushUnique(normalizedLearned);
    }
  }

  const { primary, matchedRule } = resolveUpstreamRefererMatch(
    targetUrl,
    refererMapJson,
    maximaimgReferer
  );
  pushUnique(primary);

  if (isMaximaimgHost(hostname)) {
    pushUnique(DEFAULT_ANITUBE_BIZ_REFERER);
    pushUnique(LEGACY_MAXIMAIMG_REFERER);
    pushUnique(hostOrigin);
    pushUnique('');
    return candidates;
  }

  if (isMywallpaperHost(hostname)) {
    pushUnique(DEFAULT_ANITUBE_BIZ_REFERER);
    pushUnique(LEGACY_MAXIMAIMG_REFERER);
    pushUnique(DEFAULT_COEMPREGOS_REFERER);
    pushUnique('');
    pushUnique(hostOrigin);
    return candidates;
  }

  if (isCdnSubdomainHost(hostname) || matchedRule) {
    pushUnique(DEFAULT_ANITUBE_BIZ_REFERER);
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
  customReferer?: string | null
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
  };

  let referer = resolveUpstreamReferer(targetUrl);
  if (customReferer && customReferer.trim()) {
    const check = validateHttpUrl(customReferer);
    if (check.valid && check.normalizedUrl) {
      referer = check.normalizedUrl;
    }
  }
  if (referer) {
    headers['Referer'] = referer;
  }

  // Encaminhar apenas Range para seeking; nunca enviar Origin nem repassar Referer/Origin do cliente.
  const range = incomingRequest.headers.get('range');
  if (range) {
    headers['Range'] = range;
  }

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

export function bytesStartWithExtM3u(bytes: Uint8Array): boolean {
  let offset = 0;

  // Ignorar UTF-8 BOM opcional
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    offset = 3;
  }

  // Ignorar espaços em branco ASCII iniciais
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

function hasEnoughBytesToDecide(prefix: Uint8Array): boolean {
  let offset = 0;
  if (
    prefix.length >= 3 &&
    prefix[0] === 0xef &&
    prefix[1] === 0xbb &&
    prefix[2] === 0xbf
  ) {
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

function resolveBinaryContentType(contentType: string, targetUrl?: URL): string {
  const lowerCt = contentType.toLowerCase();
  if (targetUrl && targetUrl.pathname.toLowerCase().endsWith('.webp')) {
    if (!lowerCt || lowerCt.startsWith('image/') || lowerCt === 'application/octet-stream') {
      return 'video/mp2t';
    }
  }
  return contentType || 'application/octet-stream';
}

const MAX_EXPIRABLE_BINARY_CACHE_SECONDS = 30;
const EXPIRABLE_SAFETY_MARGIN_SECONDS = 5;

function safeDetectExpirable(
  input: string,
  detector: (value: string) => boolean = hasExpirableHlsTokens
): boolean {
  if (!input) return false;
  try {
    return Boolean(detector(input));
  } catch {
    // Falha na detecção de tokens não interrompe reprodução e assume política conservadora
    return true;
  }
}

interface OriginCacheDirectives {
  hasNoStore: boolean;
  hasNoCache: boolean;
  hasPrivate: boolean;
  effectiveMaxAge: number | null;
}

function parseOriginCacheDirectives(upstream: Response): OriginCacheDirectives {
  const cc = upstream.headers.get('cache-control') || '';
  if (!cc.trim()) {
    return { hasNoStore: false, hasNoCache: false, hasPrivate: false, effectiveMaxAge: null };
  }
  const hasNoStore = /\bno-store\b/i.test(cc);
  const hasNoCache = /\bno-cache\b/i.test(cc);
  const hasPrivate = /\bprivate\b/i.test(cc);

  const ageCandidates: number[] = [];
  const sMaxMatch = /\bs-maxage=(\d+)/i.exec(cc);
  if (sMaxMatch) {
    const val = Number(sMaxMatch[1]);
    if (Number.isFinite(val)) ageCandidates.push(val);
  }
  const maxAgeMatch = /\bmax-age=(\d+)/i.exec(cc);
  if (maxAgeMatch) {
    const val = Number(maxAgeMatch[1]);
    if (Number.isFinite(val)) ageCandidates.push(val);
  }

  return {
    hasNoStore,
    hasNoCache,
    hasPrivate,
    effectiveMaxAge: ageCandidates.length > 0 ? Math.min(...ageCandidates) : null,
  };
}

function buildBinaryResponseHeaders(
  upstream: Response,
  contentType: string,
  targetUrl?: URL,
  inheritedExpirable = false,
  nowSeconds = Math.floor(Date.now() / 1000),
  sourceTargetUrl?: string,
  detectExpirable: (input: string) => boolean = hasExpirableHlsTokens
): Headers {
  const outHeaders = new Headers();
  outHeaders.set('Content-Type', resolveBinaryContentType(contentType, targetUrl));
  const isR2Target =
    isR2StorageUrl(sourceTargetUrl ?? '') ||
    Boolean(targetUrl && isR2StorageHost(targetUrl.hostname));
  const isExpirable =
    inheritedExpirable ||
    isR2Target ||
    Boolean(sourceTargetUrl && safeDetectExpirable(sourceTargetUrl, detectExpirable)) ||
    Boolean(targetUrl && safeDetectExpirable(targetUrl.toString(), detectExpirable));
  const origin = parseOriginCacheDirectives(upstream);

  let cacheControl: string;
  let cdnCacheControl: string;

  if (isExpirable) {
    cdnCacheControl = 'no-store';
    if (
      origin.hasNoStore ||
      origin.hasNoCache ||
      origin.effectiveMaxAge === 0 ||
      (origin.hasPrivate && origin.effectiveMaxAge === null)
    ) {
      cacheControl = 'no-store';
    } else {
      const candidateRemaining =
        (targetUrl
          ? extractExpirableTokenRemainingSeconds(targetUrl.toString(), nowSeconds)
          : null) ??
        (sourceTargetUrl
          ? extractExpirableTokenRemainingSeconds(sourceTargetUrl, nowSeconds)
          : null);

      if (candidateRemaining === null) {
        cacheControl = 'no-store';
      } else {
        const capped = Math.min(
          MAX_EXPIRABLE_BINARY_CACHE_SECONDS,
          Math.floor(candidateRemaining) - EXPIRABLE_SAFETY_MARGIN_SECONDS,
          origin.effectiveMaxAge ?? MAX_EXPIRABLE_BINARY_CACHE_SECONDS
        );
        cacheControl =
          capped > 0 ? `private, max-age=${capped}, must-revalidate` : 'no-store';
      }
    }
  } else if (origin.hasNoStore) {
    cacheControl = 'no-store';
    cdnCacheControl = 'no-store';
  } else if (origin.hasPrivate) {
    const capped = origin.effectiveMaxAge !== null ? Math.min(300, origin.effectiveMaxAge) : 0;
    cacheControl = capped > 0 ? `private, max-age=${capped}, must-revalidate` : 'private, no-store';
    cdnCacheControl = 'no-store';
  } else if (origin.hasNoCache || origin.effectiveMaxAge === 0) {
    cacheControl = 'no-cache, must-revalidate';
    cdnCacheControl = 'no-cache, must-revalidate';
  } else if (origin.effectiveMaxAge !== null && origin.effectiveMaxAge < 31536000) {
    cacheControl = `public, max-age=${origin.effectiveMaxAge}`;
    cdnCacheControl = `public, max-age=${origin.effectiveMaxAge}`;
  } else {
    cacheControl = 'public, max-age=31536000, immutable';
    cdnCacheControl = 'public, max-age=31536000, immutable';
  }

  outHeaders.set('Cache-Control', cacheControl);
  outHeaders.set('CDN-Cache-Control', cdnCacheControl);
  outHeaders.set('X-Content-Type-Options', 'nosniff');
  outHeaders.set('Access-Control-Allow-Origin', '*');
  if (isExpirable) {
    outHeaders.set('X-Hikari-Source-Expirable', '1');
    outHeaders.set(
      'Access-Control-Expose-Headers',
      'Accept-Ranges, Content-Length, Content-Range, X-Hikari-Source-Expirable'
    );
  } else {
    outHeaders.set('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');
  }

  const passthroughHeaders = ['content-length', 'content-range', 'accept-ranges'];
  for (const h of passthroughHeaders) {
    const val = upstream.headers.get(h);
    if (val) outHeaders.set(h, val);
  }

  return outHeaders;
}

function buildManifestResponseHeaders(upstream: Response, isExpirable = false): Headers {
  const outHeaders = new Headers();
  outHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  const origin = parseOriginCacheDirectives(upstream);

  let cacheControl = 'public, max-age=5, stale-while-revalidate=30';
  let cdnCacheControl = 'public, max-age=5, stale-while-revalidate=30';

  if (isExpirable) {
    cacheControl = 'no-store';
    cdnCacheControl = 'no-store';
  } else if (origin.hasNoStore) {
    cacheControl = 'no-store';
    cdnCacheControl = 'no-store';
  } else if (origin.hasPrivate) {
    cacheControl = 'private, no-cache';
    cdnCacheControl = 'no-store';
  } else if (origin.hasNoCache || origin.effectiveMaxAge === 0) {
    cacheControl = 'no-cache, must-revalidate';
    cdnCacheControl = 'no-cache, must-revalidate';
  } else if (origin.effectiveMaxAge !== null && origin.effectiveMaxAge < 5) {
    cacheControl = `public, max-age=${origin.effectiveMaxAge}`;
    cdnCacheControl = `public, max-age=${origin.effectiveMaxAge}`;
  }

  outHeaders.set('Cache-Control', cacheControl);
  outHeaders.set('CDN-Cache-Control', cdnCacheControl);
  outHeaders.set('Access-Control-Allow-Origin', '*');
  if (isExpirable) {
    outHeaders.set('X-Hikari-Source-Expirable', '1');
    outHeaders.set('Access-Control-Expose-Headers', 'X-Hikari-Source-Expirable');
  }
  return outHeaders;
}

function buildProxyErrorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function looksLikeBinaryMediaPrefix(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  // MPEG-TS sync byte (0x47)
  if (bytes[0] === 0x47) return true;
  // NUL byte indicates binary payload (e.g. fMP4 / MP4 / AES key)
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

async function handleInspectedUpstreamResponse(
  upstream: Response,
  finalUrl: string,
  contentType: string,
  depth: number,
  sourceTargetUrl: string,
  propagatedReferer?: string | null,
  inheritedExpirable = false,
  nowSeconds = Math.floor(Date.now() / 1000),
  detectExpirable: (input: string) => boolean = hasExpirableHlsTokens
): Promise<Response> {
  const finalParsed = new URL(finalUrl);
  const rewriteManifestResponse = (text: string): Response => {
    const baseExpirable =
      inheritedExpirable ||
      isR2StorageUrl(sourceTargetUrl) ||
      isR2StorageUrl(finalUrl) ||
      safeDetectExpirable(sourceTargetUrl, detectExpirable) ||
      safeDetectExpirable(finalUrl, detectExpirable) ||
      safeDetectExpirable(text, detectExpirable);
    let childTokenDetected = false;
    const signNowSeconds = Math.floor(Date.now() / 1000);
    const nextDepth = depth + 1;
    const rewritten = rewriteM3u8Playlist(text, finalUrl, (resolved) => {
      const childExpirable = baseExpirable || safeDetectExpirable(resolved, detectExpirable);
      if (childExpirable) {
        childTokenDetected = true;
      }
      return buildSignedProxyPath(
        resolved,
        undefined,
        signNowSeconds,
        nextDepth,
        propagatedReferer,
        childExpirable
      );
    });
    const isExpirable = baseExpirable || childTokenDetected;
    return new Response(rewritten, {
      status: 200,
      headers: buildManifestResponseHeaders(upstream, isExpirable),
    });
  };

  if (!upstream.body) {
    const rawBytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytesStartWithExtM3u(rawBytes)) {
      if (depth > MAX_HLS_REWRITE_DEPTH) {
        return buildProxyErrorResponse(
          `Profundidade máxima de playlist HLS (${MAX_HLS_REWRITE_DEPTH}) excedida.`,
          502
        );
      }
      const text = new TextDecoder('utf-8').decode(rawBytes);
      return rewriteManifestResponse(text);
    }

    if (isInvalidHtmlManifestResponse(rawBytes, contentType, finalParsed)) {
      return buildProxyErrorResponse(
        'Origem retornou página HTML em vez de manifesto HLS válido.',
        502
      );
    }

    const outHeaders = buildBinaryResponseHeaders(
      upstream,
      contentType,
      finalParsed,
      inheritedExpirable,
      nowSeconds,
      sourceTargetUrl,
      detectExpirable
    );
    return new Response(rawBytes, {
      status: upstream.status,
      headers: outHeaders,
    });
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
      const mergedPrefix = concatChunks(bufferedChunks);
      if (hasEnoughBytesToDecide(mergedPrefix)) {
        break;
      }
    }
  }

  const initialBytes = concatChunks(bufferedChunks);
  if (bytesStartWithExtM3u(initialBytes)) {
    if (depth > MAX_HLS_REWRITE_DEPTH) {
      try {
        await reader.cancel();
      } catch {
        // Ignorar erro ao cancelar leitura excedente
      }
      return buildProxyErrorResponse(
        `Profundidade máxima de playlist HLS (${MAX_HLS_REWRITE_DEPTH}) excedida.`,
        502
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
    const fullBytes = concatChunks(bufferedChunks);
    const text = new TextDecoder('utf-8').decode(fullBytes);
    return rewriteManifestResponse(text);
  }

  if (isInvalidHtmlManifestResponse(initialBytes, contentType, finalParsed)) {
    try {
      await reader.cancel();
    } catch {
      // Ignorar erro ao cancelar leitura HTML inválida
    }
    return buildProxyErrorResponse(
      'Origem retornou página HTML em vez de manifesto HLS válido.',
      502
    );
  }

  // Não é manifesto #EXTM3U (ex.: segmento binário ou chave servido com Content-Type: text/plain):
  // retransmitir os bytes originais intactos via stream sem decodificação UTF-8.
  const outHeaders = buildBinaryResponseHeaders(
    upstream,
    contentType,
    finalParsed,
    inheritedExpirable,
    nowSeconds,
    sourceTargetUrl,
    detectExpirable
  );
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
        // Ignorar erro de cancelamento do stream
      }
    },
  });

  return new Response(passthroughStream, {
    status: upstream.status,
    headers: outHeaders,
  });
}

export interface ProxyStreamDeps {
  fetchWithRedirects?: typeof safeFetchWithRedirects;
  learnedRefererStore?: LearnedRefererStore | null;
  nowMs?: () => number;
  nowSeconds?: () => number;
  detectExpirableTokens?: (input: string) => boolean;
}

async function cancelResponseBodySafely(res: Response): Promise<void> {
  if (!res.body) return;
  try {
    await res.body.cancel();
  } catch {
    // Ignorar erro ao descartar corpo de resposta anterior
  }
}

async function fetchWith403RefererFallback(
  targetUrl: URL,
  incomingRequest: Request,
  fetchWithRedirects: typeof safeFetchWithRedirects,
  customReferer?: string | null,
  learnedStore?: LearnedRefererStore | null
): Promise<{
  response: Response;
  finalUrl: string;
  winningReferer: string;
  usedFallback: boolean;
}> {
  const baseHeaders = getUpstreamHeaders(targetUrl, incomingRequest, customReferer);
  const hostname = targetUrl.hostname.toLowerCase().replace(/\.+$/, '');
  const allowLearnedCache = !isMaximaimgHost(hostname) && Boolean(learnedStore);
  const cacheKey = buildLearnedRefererKey(resolveRefererCacheEnvScope(), hostname);

  let learnedReferer: string | null = null;
  if (allowLearnedCache && learnedStore) {
    try {
      const rawLearned = await learnedStore.get(cacheKey);
      if (rawLearned !== null && rawLearned !== undefined) {
        const normalized = normalizeStoredReferer(rawLearned);
        if (normalized !== null) {
          learnedReferer = normalized;
        } else {
          await learnedStore.delete(cacheKey);
        }
      }
    } catch {
      // Fail-open: erro no cache temporário nunca interrompe reprodução
      learnedReferer = null;
    }
  }

  const { primary } = resolveUpstreamRefererMatch(targetUrl);
  const refererCandidates = resolveUpstreamRefererCandidates(
    targetUrl,
    undefined,
    undefined,
    customReferer,
    allowLearnedCache ? learnedReferer : null
  );

  let lastResult: { response: Response; finalUrl: string } | null = null;

  for (let i = 0; i < refererCandidates.length; i++) {
    const candidateRef = refererCandidates[i];
    const headers: Record<string, string> = { ...baseHeaders };
    if (candidateRef) {
      headers['Referer'] = candidateRef;
    } else {
      delete headers['Referer'];
    }

    if (lastResult) {
      await cancelResponseBodySafely(lastResult.response);
    }

    lastResult = await fetchWithRedirects(targetUrl.toString(), {
      method: incomingRequest.method,
      headers,
      timeoutMs: 30000,
    });

    if (lastResult.response.status !== 403) {
      const usedFallback =
        (!customReferer && candidateRef !== primary) ||
        (Boolean(customReferer) && i > 0);

      if (
        allowLearnedCache &&
        learnedStore &&
        (lastResult.response.ok || lastResult.response.status === 206)
      ) {
        try {
          if (
            candidateRef !== primary &&
            candidateRef !== learnedReferer &&
            (!customReferer || i > 0)
          ) {
            const validToStore = normalizeStoredReferer(candidateRef);
            if (validToStore !== null) {
              await learnedStore.set(cacheKey, validToStore, LEARNED_REFERER_TTL_SECONDS);
            }
          } else if (candidateRef === primary && learnedReferer !== null && !customReferer) {
            await learnedStore.delete(cacheKey);
          }
        } catch {
          // Fail-open ao atualizar ou invalidar cache temporário
        }
      }

      return {
        ...lastResult,
        winningReferer: candidateRef,
        usedFallback,
      };
    }
  }

  if (allowLearnedCache && learnedStore && learnedReferer !== null) {
    try {
      await learnedStore.delete(cacheKey);
    } catch {
      // Fail-open ao invalidar cache após 403 em todos os candidatos
    }
  }

  return {
    ...lastResult!,
    winningReferer: refererCandidates[refererCandidates.length - 1] ?? '',
    usedFallback: refererCandidates.length > 1,
  };
}

export async function handleProxyStreamRequest(
  request: Request,
  deps: ProxyStreamDeps = {}
): Promise<Response> {
  const fetchWithRedirects = deps.fetchWithRedirects ?? safeFetchWithRedirects;
  const nowSecondsFn =
    deps.nowSeconds ??
    (deps.nowMs ? () => Math.floor(deps.nowMs!() / 1000) : () => Math.floor(Date.now() / 1000));
  const nowSeconds = nowSecondsFn();
  const nowMs = deps.nowMs ?? (() => nowSecondsFn() * 1000);
  const detectExpirable = deps.detectExpirableTokens ?? hasExpirableHlsTokens;
  const learnedStore =
    deps.learnedRefererStore !== undefined
      ? deps.learnedRefererStore
      : createMemoryLearnedRefererStore(nowMs);
  const reqUrl = new URL(request.url);
  const rawTarget = reqUrl.searchParams.get('url') ?? '';
  const exp = reqUrl.searchParams.get('exp');
  const sig = reqUrl.searchParams.get('sig');
  const depthParam = reqUrl.searchParams.get('d');
  const depthSigParam = reqUrl.searchParams.get('dsig');
  const refParam = reqUrl.searchParams.get('ref');
  const refSigParam = reqUrl.searchParams.get('rsig');
  const expirableParam = reqUrl.searchParams.get('ex');
  const expirableSigParam = reqUrl.searchParams.get('xsig');

  const urlCheck = validateHttpUrl(rawTarget, MAX_PROXY_URL_LENGTH);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    return buildProxyErrorResponse('Parâmetro de URL inválido.', 400);
  }

  if (!verifyProxySignature(urlCheck.normalizedUrl, exp, sig)) {
    return buildProxyErrorResponse('Assinatura de proxy inválida ou expirada.', 403);
  }

  const depthCheck = verifyProxyDepth(
    urlCheck.normalizedUrl,
    exp,
    depthParam,
    depthSigParam
  );
  if (!depthCheck.valid) {
    return buildProxyErrorResponse('Assinatura de profundidade do proxy inválida.', 403);
  }

  const refCheck = verifyProxyReferer(
    urlCheck.normalizedUrl,
    exp,
    refParam,
    refSigParam
  );
  if (!refCheck.valid) {
    return buildProxyErrorResponse('Assinatura de Referer do proxy inválida.', 403);
  }

  const expirableCheck = verifyProxyExpirable(
    urlCheck.normalizedUrl,
    exp,
    expirableParam,
    expirableSigParam
  );
  if (!expirableCheck.valid) {
    return buildProxyErrorResponse('Assinatura de expiração do proxy inválida.', 403);
  }

  try {
    const targetUrl = new URL(urlCheck.normalizedUrl);
    if (
      !depthCheck.fromPlaylist &&
      !isDirectMediaHost(targetUrl.hostname) &&
      !isAllowedProxyMediaUrl(targetUrl)
    ) {
      return buildProxyErrorResponse('Extensão de destino não permitida no proxy.', 403);
    }

    const {
      response: upstream,
      finalUrl,
      winningReferer,
      usedFallback,
    } = await fetchWith403RefererFallback(
      targetUrl,
      request,
      fetchWithRedirects,
      refCheck.referer,
      learnedStore
    );

    if (!upstream.ok && upstream.status !== 206) {
      return buildProxyErrorResponse(
        `Origem retornou erro HTTP ${upstream.status}.`,
        upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502
      );
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const finalParsed = new URL(finalUrl);
    if (
      !depthCheck.fromPlaylist &&
      !isDirectMediaHost(finalParsed.hostname) &&
      !isAllowedProxyMediaUrl(finalParsed)
    ) {
      return buildProxyErrorResponse('Extensão de destino não permitida no proxy.', 403);
    }

    const propagatedReferer =
      winningReferer && (usedFallback || Boolean(refCheck.referer))
        ? winningReferer
        : null;

    if (
      upstream.status !== 206 &&
      shouldInspectForHlsManifest(contentType, finalParsed, depthCheck.fromPlaylist)
    ) {
      return await handleInspectedUpstreamResponse(
        upstream,
        finalUrl,
        contentType,
        depthCheck.depth,
        targetUrl.toString(),
        propagatedReferer,
        expirableCheck.expirable,
        nowSeconds,
        detectExpirable
      );
    }

    const outHeaders = buildBinaryResponseHeaders(
      upstream,
      contentType,
      finalParsed,
      expirableCheck.expirable,
      nowSeconds,
      targetUrl.toString(),
      detectExpirable
    );
    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Falha ao processar stream via proxy.';
    return buildProxyErrorResponse(message, 502);
  }
}
