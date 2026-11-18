import crypto from 'node:crypto';

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

export function buildSignedProxyPath(
  targetUrl: string,
  ttlSeconds = 60 * 60 * 6
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createProxySignature(targetUrl, exp);
  const params = new URLSearchParams({
    url: targetUrl,
    exp: String(exp),
    sig,
  });
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

function resolveAndSignUri(
  rawUri: string,
  baseUrl: string,
  signFn: (resolvedUrl: string) => string
): string {
  const trimmed = rawUri.trim();
  if (!trimmed || trimmed.startsWith('data:')) {
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
      // Rewrite URI="..." inside tags such as #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF
      const rewrittenTag = line.replace(/URI="([^"]+)"/gi, (_match, uriValue: string) => {
        try {
          const proxied = resolveAndSignUri(uriValue, baseUrl, signFn);
          return `URI="${proxied}"`;
        } catch {
          return `URI="${uriValue}"`;
        }
      });
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
