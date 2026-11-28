import crypto from 'node:crypto';
import { getSessionSecret } from '@/lib/proxy-signing';

export const ADMIN_SESSION_COOKIE_NAME = 'player_admin_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 dias
const MAX_ATTEMPTS_WINDOW_MS = 10 * 60 * 1000; // 10 min
const MAX_FAILED_ATTEMPTS = 8;

interface SessionPayload {
  sub: 'admin';
  iat: number;
  exp: number;
}

const failedAttempts = new Map<string, { count: number; firstAt: number }>();

export function isAuthEnvConfigured(): {
  passwordConfigured: boolean;
  secretConfigured: boolean;
  ready: boolean;
} {
  const passwordConfigured = Boolean(process.env.PLAYER_ADMIN_PASSWORD?.trim());
  const secretLen = process.env.PLAYER_SESSION_SECRET?.trim().length ?? 0;
  const secretConfigured = secretLen >= 16;
  const isProd = process.env.NODE_ENV === 'production';

  return {
    passwordConfigured,
    secretConfigured,
    ready: passwordConfigured && (!isProd || secretConfigured),
  };
}

export function verifyAdminPassword(candidatePassword: string): boolean {
  const expectedPassword = process.env.PLAYER_ADMIN_PASSWORD;
  if (!expectedPassword || !candidatePassword) {
    return false;
  }

  const candidateDigest = crypto.createHash('sha256').update(candidatePassword, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expectedPassword, 'utf8').digest();
  return crypto.timingSafeEqual(candidateDigest, expectedDigest);
}

export function createSessionToken(nowSeconds = Math.floor(Date.now() / 1000)): string {
  const payload: SessionPayload = {
    sub: 'admin',
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', getSessionSecret())
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifySessionToken(
  token: string | undefined | null,
  nowSeconds = Math.floor(Date.now() / 1000)
): SessionPayload | null {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return null;

  let expectedSignature: string;
  try {
    expectedSignature = crypto
      .createHmac('sha256', getSessionSecret())
      .update(encodedPayload)
      .digest('base64url');
  } catch {
    return null;
  }

  const sigBuf = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as SessionPayload;
    if (
      parsed.sub !== 'admin' ||
      typeof parsed.exp !== 'number' ||
      typeof parsed.iat !== 'number' ||
      parsed.exp <= nowSeconds
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function checkLoginRateLimit(clientKey: string): { allowed: boolean; retryAfterSeconds?: number } {
  const entry = failedAttempts.get(clientKey);
  if (!entry) return { allowed: true };

  const elapsed = Date.now() - entry.firstAt;
  if (elapsed > MAX_ATTEMPTS_WINDOW_MS) {
    failedAttempts.delete(clientKey);
    return { allowed: true };
  }

  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    const retryAfterSeconds = Math.ceil((MAX_ATTEMPTS_WINDOW_MS - elapsed) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  return { allowed: true };
}

export function recordFailedLogin(clientKey: string): void {
  const now = Date.now();
  const entry = failedAttempts.get(clientKey);
  if (!entry || now - entry.firstAt > MAX_ATTEMPTS_WINDOW_MS) {
    failedAttempts.set(clientKey, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

export function clearLoginAttempts(clientKey: string): void {
  failedAttempts.delete(clientKey);
}

export function getPublicBaseUrl(): string {
  const configured = process.env.PLAYER_PUBLIC_BASE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.toString().replace(/\/+$/, '');
      }
    } catch {
      // Fallback below if malformed
    }
  }

  const appUrl = process.env.APP_URL?.trim();
  if (appUrl) {
    try {
      const url = new URL(appUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.toString().replace(/\/+$/, '');
      }
    } catch {
      // Ignore
    }
  }

  return 'http://localhost:3000';
}

export function buildPublicEpisodeUrl(episodeId: string): string {
  const base = getPublicBaseUrl();
  return `${base}/e/${encodeURIComponent(episodeId)}`;
}

export function parseCookieValue(
  cookieHeader: string | null | undefined,
  name: string
): string | null {
  if (!cookieHeader || !name) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = part.slice(0, eqIndex).trim();
    if (key !== name) continue;
    const rawValue = part.slice(eqIndex + 1).trim();
    if (!rawValue) return null;
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return null;
}

function parseNormalizedHttpOrigin(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizeVercelHostOrigin(rawHost: string | null | undefined): string | null {
  const trimmed = rawHost?.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    return parseNormalizedHttpOrigin(trimmed);
  }
  if (/[\s/\\?#]/.test(trimmed)) {
    return null;
  }
  return parseNormalizedHttpOrigin(`https://${trimmed}`);
}

export function getCanonicalAllowedOrigins(): string[] {
  const origins = new Set<string>();

  const configuredPublicOrigin = parseNormalizedHttpOrigin(process.env.PLAYER_PUBLIC_BASE_URL);
  if (configuredPublicOrigin) {
    origins.add(configuredPublicOrigin);
  }

  const configuredAppOrigin = parseNormalizedHttpOrigin(process.env.APP_URL);
  if (configuredAppOrigin) {
    origins.add(configuredAppOrigin);
  }

  const vercelEnv = process.env.VERCEL_ENV?.trim().toLowerCase();
  const hasExplicitConfiguredOrigin = origins.size > 0;

  if (vercelEnv === 'preview') {
    const previewOrigin = normalizeVercelHostOrigin(process.env.VERCEL_URL);
    if (previewOrigin) origins.add(previewOrigin);
    const branchOrigin = normalizeVercelHostOrigin(process.env.VERCEL_BRANCH_URL);
    if (branchOrigin) origins.add(branchOrigin);
  } else if (!hasExplicitConfiguredOrigin) {
    const prodVercelOrigin = normalizeVercelHostOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL);
    if (prodVercelOrigin) origins.add(prodVercelOrigin);
    const branchOrigin = normalizeVercelHostOrigin(process.env.VERCEL_BRANCH_URL);
    if (branchOrigin) origins.add(branchOrigin);
    const vercelOrigin = normalizeVercelHostOrigin(process.env.VERCEL_URL);
    if (vercelOrigin) origins.add(vercelOrigin);
  }

  if (origins.size === 0) {
    const fallbackOrigin = parseNormalizedHttpOrigin(getPublicBaseUrl());
    if (fallbackOrigin) {
      origins.add(fallbackOrigin);
    }
    if (process.env.NODE_ENV !== 'production') {
      origins.add('http://localhost:3000');
      origins.add('http://127.0.0.1:3000');
    }
  }

  return Array.from(origins);
}

function parseStrictOriginHeader(rawOrigin: string): string | null {
  const trimmed = rawOrigin.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') {
    return null;
  }
  if (/\s/.test(trimmed) || trimmed.endsWith('/')) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function parseRefererOrigin(rawReferer: string): string | null {
  const trimmed = rawReferer.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isSameOriginPostRequest(request: Request): boolean {
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite !== null) {
    if (secFetchSite.trim().toLowerCase() !== 'same-origin') {
      return false;
    }
  }

  const allowedOrigins = new Set(getCanonicalAllowedOrigins());
  if (allowedOrigins.size === 0) {
    return false;
  }

  const originHeader = request.headers.get('origin');
  if (originHeader !== null) {
    const parsedOrigin = parseStrictOriginHeader(originHeader);
    if (!parsedOrigin) {
      return false;
    }
    return allowedOrigins.has(parsedOrigin);
  }

  const refererHeader = request.headers.get('referer');
  if (!refererHeader) {
    return false;
  }

  const refererOrigin = parseRefererOrigin(refererHeader);
  if (!refererOrigin) {
    return false;
  }

  return allowedOrigins.has(refererOrigin);
}

export function verifyAdminRequest(request: Request): {
  authenticated: boolean;
  sameOrigin: boolean;
} {
  const sameOrigin = isSameOriginPostRequest(request);
  const token = parseCookieValue(request.headers.get('cookie'), ADMIN_SESSION_COOKIE_NAME);
  const authenticated = Boolean(verifySessionToken(token));
  return { authenticated, sameOrigin };
}

