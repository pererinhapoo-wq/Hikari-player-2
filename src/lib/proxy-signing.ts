import crypto from 'node:crypto';
import { isR2StorageUrl } from '@/lib/video-sources';

let ephemeralDevSecret: string | null = null;

export function getSessionSecret(): string {
  const configured = process.env.PLAYER_SESSION_SECRET?.trim();
  if (configured && configured.length >= 16) {
    return configured;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'PLAYER_SESSION_SECRET não configurado (mínimo de 16 caracteres obrigatório em produção).'
    );
  }

  if (!ephemeralDevSecret) {
    ephemeralDevSecret = crypto.randomBytes(32).toString('hex');
  }
  return ephemeralDevSecret;
}

export function createProxySignature(targetUrl: string, expUnixSeconds: number): string {
  const secret = getSessionSecret();
  return crypto
    .createHmac('sha256', secret)
    .update(`proxy:${targetUrl}:${expUnixSeconds}`)
    .digest('base64url');
}

export const PROXY_EXP_BUCKET_SECONDS = 60 * 60 * 6; // Janela fixa de 6h
export const MAX_HLS_REWRITE_DEPTH = 2;

export function getStableProxyExpiry(
  nowSeconds = Math.floor(Date.now() / 1000),
  bucketSeconds = PROXY_EXP_BUCKET_SECONDS
): number {
  return (Math.floor(nowSeconds / bucketSeconds) + 2) * bucketSeconds;
}

export function createProxyDepthSignature(
  targetUrl: string,
  expUnixSeconds: number,
  depth: number
): string {
  const secret = getSessionSecret();
  return crypto
    .createHmac('sha256', secret)
    .update(`proxy-depth:${targetUrl}:${expUnixSeconds}:${depth}`)
    .digest('base64url');
}

export function createProxyRefererSignature(
  targetUrl: string,
  expUnixSeconds: number,
  referer: string
): string {
  const secret = getSessionSecret();
  return crypto
    .createHmac('sha256', secret)
    .update(`proxy-ref:${targetUrl}:${expUnixSeconds}:${referer}`)
    .digest('base64url');
}

export function createProxyExpirableSignature(
  targetUrl: string,
  expUnixSeconds: number
): string {
  const secret = getSessionSecret();
  return crypto
    .createHmac('sha256', secret)
    .update(`proxy-exp:${targetUrl}:${expUnixSeconds}:1`)
    .digest('base64url');
}

export function buildSignedProxyPath(
  targetUrl: string,
  ttlSeconds?: number,
  nowSeconds = Math.floor(Date.now() / 1000),
  depth = 0,
  referer?: string | null,
  expirable = false
): string {
  const exp =
    typeof ttlSeconds === 'number' && ttlSeconds < 0
      ? nowSeconds + ttlSeconds
      : getStableProxyExpiry(nowSeconds);
  const sig = createProxySignature(targetUrl, exp);
  const params = new URLSearchParams({
    url: targetUrl,
    exp: String(exp),
    sig,
  });
  if (Number.isInteger(depth) && depth > 0) {
    params.set('d', String(depth));
    params.set('dsig', createProxyDepthSignature(targetUrl, exp, depth));
  }
  const cleanRef = typeof referer === 'string' ? referer.trim() : '';
  if (cleanRef) {
    params.set('ref', cleanRef);
    params.set('rsig', createProxyRefererSignature(targetUrl, exp, cleanRef));
  }
  const effectiveExpirable = Boolean(expirable) || isR2StorageUrl(targetUrl);
  if (effectiveExpirable) {
    params.set('ex', '1');
    params.set('xsig', createProxyExpirableSignature(targetUrl, exp));
  }
  return `/api/proxy/stream?${params.toString()}`;
}

export function verifyProxySignature(
  targetUrl: string,
  expParam: string | null,
  sigParam: string | null
): boolean {
  if (!expParam || !sigParam) return false;
  const exp = Number(expParam);
  if (!Number.isInteger(exp)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return false;

  const expected = createProxySignature(targetUrl, exp);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(sigParam, 'utf8');
  if (expectedBuf.length !== receivedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

export function verifyProxyReferer(
  targetUrl: string,
  expParam: string | null,
  refParam: string | null,
  refSigParam: string | null,
  nowSeconds = Math.floor(Date.now() / 1000)
): { valid: boolean; referer: string | null } {
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
  const expected = createProxyRefererSignature(targetUrl, exp, refParam);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(refSigParam, 'utf8');
  if (expectedBuf.length !== receivedBuf.length) {
    return { valid: false, referer: null };
  }
  if (!crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
    return { valid: false, referer: null };
  }
  return { valid: true, referer: refParam };
}

export function verifyProxyExpirable(
  targetUrl: string,
  expParam: string | null,
  expirableParam: string | null,
  expirableSigParam: string | null,
  nowSeconds = Math.floor(Date.now() / 1000)
): { valid: boolean; expirable: boolean } {
  if (expirableParam === null) {
    return { valid: true, expirable: false };
  }
  if (expirableParam !== '1' || !expParam || !expirableSigParam) {
    return { valid: false, expirable: false };
  }
  const exp = Number(expParam);
  if (!Number.isInteger(exp) || exp < nowSeconds) {
    return { valid: false, expirable: false };
  }
  const expected = createProxyExpirableSignature(targetUrl, exp);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(expirableSigParam, 'utf8');
  if (expectedBuf.length !== receivedBuf.length) {
    return { valid: false, expirable: false };
  }
  if (!crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
    return { valid: false, expirable: false };
  }
  return { valid: true, expirable: true };
}

export function verifyProxyDepth(
  targetUrl: string,
  expParam: string | null,
  depthParam: string | null,
  depthSigParam: string | null
): { valid: boolean; depth: number; fromPlaylist: boolean } {
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

  const expected = createProxyDepthSignature(targetUrl, exp, depth);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(depthSigParam, 'utf8');
  if (expectedBuf.length !== receivedBuf.length) {
    return { valid: false, depth: 0, fromPlaylist: false };
  }
  if (!crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
    return { valid: false, depth: 0, fromPlaylist: false };
  }

  return { valid: true, depth, fromPlaylist: true };
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

function resolveAndSignUri(
  rawUri: string,
  baseUrl: string,
  signFn: (resolvedUrl: string) => string
): string {
  const trimmed = rawUri.trim();
  if (!trimmed || isPassthroughUriScheme(trimmed)) {
    return rawUri;
  }
  const absolute = new URL(trimmed, baseUrl).toString();
  return signFn(absolute);
}

export function rewriteM3u8Playlist(
  playlistContent: string,
  baseUrl: string,
  signFn: (resolvedUrl: string) => string
): string {
  const lines = playlistContent.split(/\r?\n/);
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
          const proxied = resolveAndSignUri(rawPrefetchUri, baseUrl, signFn);
          output.push(`#EXT-X-PREFETCH:${proxied}`);
        } catch {
          output.push(line);
        }
        continue;
      }

      // Rewrite URI="..." / URI='...' / URI=... inside tags such as
      // #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF, #EXT-X-SESSION-KEY, #EXT-X-PART
      const rewrittenTag = line.replace(
        /URI\s*=\s*(?:(["'])([^"']+)\1|([^,\s]+))/gi,
        (_match, quote: string | undefined, quotedUri: string | undefined, unquotedUri: string | undefined) => {
          const rawValue = quotedUri ?? unquotedUri ?? '';
          const outQuote = quote ?? '"';
          try {
            const proxied = resolveAndSignUri(rawValue, baseUrl, signFn);
            return `URI=${outQuote}${proxied}${outQuote}`;
          } catch {
            return quote ? `URI=${quote}${rawValue}${quote}` : `URI=${rawValue}`;
          }
        }
      );
      output.push(rewrittenTag);
      continue;
    }

    // Media segment or variant playlist URI line
    try {
      output.push(resolveAndSignUri(trimmed, baseUrl, signFn));
    } catch {
      output.push(line);
    }
  }

  return output.join('\n');
}

export function extractHlsVariantUrls(playlistContent: string, baseUrl: string): string[] {
  const lines = playlistContent.split(/\r?\n/);
  const urls: string[] = [];
  const seen = new Set<string>();
  let expectVariantLine = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      if (/^#EXT-X-STREAM-INF\b/i.test(trimmed)) {
        expectVariantLine = true;
      } else if (/^#(?:EXT-X-MEDIA|EXT-X-I-FRAME-STREAM-INF)\b/i.test(trimmed)) {
        const match = /URI\s*=\s*(?:(["'])([^"']+)\1|([^,\s]+))/i.exec(trimmed);
        const rawUri = (match?.[2] ?? match?.[3] ?? '').trim();
        if (rawUri && !isPassthroughUriScheme(rawUri)) {
          try {
            const abs = new URL(rawUri, baseUrl).toString();
            if (!seen.has(abs)) {
              seen.add(abs);
              urls.push(abs);
            }
          } catch {
            // Ignora URI inválida
          }
        }
      }
      continue;
    }

    if (expectVariantLine) {
      expectVariantLine = false;
      if (!isPassthroughUriScheme(trimmed)) {
        try {
          const abs = new URL(trimmed, baseUrl).toString();
          if (!seen.has(abs)) {
            seen.add(abs);
            urls.push(abs);
          }
        } catch {
          // Ignora URI inválida
        }
      }
    }
  }

  return urls;
}
