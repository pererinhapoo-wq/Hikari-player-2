import type {
  InternalPlayableSource,
  PlayableSource,
  PublicPlayableSource,
} from '@/lib/types';

export type SourceKind = 'mp4' | 'webm' | 'hls' | 'bunny' | 'iframe';

export type ExplicitSourceKind = 'iframe' | 'hls' | 'mp4';

export type SourceProvider =
  | 'direct'
  | 'hls'
  | 'mux'
  | 'bunny'
  | 'maximaimg'
  | 'googlevideo'
  | 'iframe';

export interface NormalizedVideoSource {
  slot: 1 | 2 | 3 | 4 | 5;
  label: string;
  rawUrl: string;
  resolvedUrl: string;
  fallbackIframeUrl?: string;
  kind: SourceKind;
  provider: SourceProvider;
  needsProxy: boolean;
  requiresServerResolve: boolean;
  formatLabel: string;
  isMirror?: boolean;
  isExpirable?: boolean;
}

export interface UrlValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
}

const MAX_URL_LENGTH = 2048;
export const MAX_VIDEO_SOURCE_URL_LENGTH = 8192;

export const EMBED_PROXIED_HOSTS = [
  'allappinc.com',
  'anitube.biz',
  'anitube.zip',
  'anitube.ninja',
] as const;
export const EMBED_ALLOWED_FINAL_HOSTS = [
  'allappinc.com',
  'api.anivideo.net',
  'cdn-sv01.maximaimg.online',
  'cdn-s01.mywallpaper-4k-image.net',
  'anitube.biz',
  'anitube22.vip',
  'anitube.zip',
  'anitube.ninja',
  'hinatasoul.com',
  'animesdigital.org',
] as const;
export const EMBED_DIRECT_HOSTS = [
  'animesdigital.org',
  'filevideo1.com',
  'anitube22.vip',
  'hinatasoul.com',
] as const;
export const EMBED_NO_REFERRER_HOSTS = ['filevideo1.com'] as const;
export const DIRECT_MEDIA_HOSTS = ['public.blob.vercel-storage.com'] as const;

export const DIRECT_IFRAME_ALLOW = 'autoplay; fullscreen; encrypted-media';
export const DIRECT_IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-presentation allow-popups';
export const PROXIED_EMBED_SANDBOX = 'allow-scripts allow-forms allow-presentation';

function matchesHostList(hostname: string, allowlist: readonly string[]): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  if (!lower) return false;
  return allowlist.some((allowed) => lower === allowed || lower.endsWith(`.${allowed}`));
}

export function isEmbedProxiedHost(hostname: string): boolean {
  return matchesHostList(hostname, EMBED_PROXIED_HOSTS);
}

export function isEmbedAllowedFinalHost(hostname: string): boolean {
  return matchesHostList(hostname, EMBED_ALLOWED_FINAL_HOSTS);
}

export function isEmbedDirectHost(hostname: string): boolean {
  return matchesHostList(hostname, EMBED_DIRECT_HOSTS);
}

export function isEmbedNoReferrerHost(hostname: string): boolean {
  return matchesHostList(hostname, EMBED_NO_REFERRER_HOSTS);
}

export function isDirectMediaHost(hostname: string): boolean {
  return matchesHostList(hostname, DIRECT_MEDIA_HOSTS);
}

export function isDirectMediaUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return isDirectMediaHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function getIframeReferrerPolicy(
  rawUrl: string
): 'no-referrer' | 'no-referrer-when-downgrade' {
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    if (parsed.pathname === '/api/embed' && parsed.searchParams.has('u')) {
      const inner = parsed.searchParams.get('u');
      if (inner) {
        const innerParsed = new URL(inner);
        if (isEmbedNoReferrerHost(innerParsed.hostname)) {
          return 'no-referrer';
        }
      }
    }
    if (isEmbedNoReferrerHost(parsed.hostname)) {
      return 'no-referrer';
    }
  } catch {
    // Mantém política padrão quando a URL não puder ser analisada
  }
  return 'no-referrer-when-downgrade';
}

export function isProxiedEmbedRouteUrl(rawUrl: string, currentOrigin?: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;

  const isRelativePath = trimmed.startsWith('/') && !trimmed.startsWith('//');
  try {
    const parsed = new URL(trimmed, 'http://localhost');
    const normalizedPath = parsed.pathname.replace(/\/+$/, '');
    if (normalizedPath !== '/api/embed') {
      return false;
    }
    if (isRelativePath) {
      return true;
    }
    if (currentOrigin) {
      return parsed.origin.toLowerCase() === currentOrigin.toLowerCase();
    }
    return false;
  } catch {
    return false;
  }
}

export function classifyEmbedHost(rawUrl: string): 'direct' | 'proxied' | 'other' {
  try {
    const parsed = new URL(rawUrl);
    if (isEmbedDirectHost(parsed.hostname)) return 'direct';
    if (isEmbedProxiedHost(parsed.hostname)) return 'proxied';
    return 'other';
  } catch {
    return 'other';
  }
}

export function buildIframePlayUrl(rawUrl: string): string {
  const hostType = classifyEmbedHost(rawUrl);
  if (hostType === 'proxied') {
    return `/api/embed?u=${encodeURIComponent(rawUrl)}`;
  }
  return rawUrl;
}

export function getIframeElementProps(
  rawUrl: string,
  currentOrigin?: string
): {
  referrerPolicy: 'no-referrer' | 'no-referrer-when-downgrade';
  allow: string;
  sandbox?: string;
} {
  const referrerPolicy = getIframeReferrerPolicy(rawUrl);
  if (isProxiedEmbedRouteUrl(rawUrl, currentOrigin)) {
    return {
      referrerPolicy,
      allow: 'autoplay; fullscreen; picture-in-picture; encrypted-media',
      sandbox: PROXIED_EMBED_SANDBOX,
    };
  }
  const isDirectHost = classifyEmbedHost(rawUrl) === 'direct';
  if (isDirectHost) {
    return {
      referrerPolicy,
      allow: DIRECT_IFRAME_ALLOW,
      sandbox: DIRECT_IFRAME_SANDBOX,
    };
  }
  return {
    referrerPolicy,
    allow: 'autoplay; fullscreen; picture-in-picture; encrypted-media',
  };
}

export function isPlayerricasSource(rawUrl: string): boolean {
  return rawUrl.toLowerCase().includes('playerricas');
}

export function normalizeExplicitSourceKind(raw: unknown): ExplicitSourceKind | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'iframe' || normalized === 'hls' || normalized === 'mp4') {
    return normalized;
  }
  return null;
}

const NAMED_EXPIRABLE_PARAM_RE =
  /(?:^|[?&#,;,\s"'/~])(expires|expire|exp|token|sig|lsig|signature|hash|auth|hmac|hdnea|hdnts|policy|key-pair-id|x-amz-expires|x-amz-date|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-expires|x-goog-date|x-goog-signature|x-goog-credential|bcdn_token)=[^\s"'<>&#,;]+/gi;

const SHORT_QUERY_EXPIRABLE_PARAM_RE = /[?&](e|t)=[^&#\s"'<>]+/gi;

const PATH_NAMED_EXPIRY_RE = /\/(?:expires|exp)\/\d{9,13}(?:\/|[?#]|$)/i;

const PATH_NAMED_TOKEN_RE =
  /\/(?:token|sig|signature|hmac|hash|auth)\/(?![^/\s"'?#]*\.(?:m3u8?|ts|m4s|mp4|m4v|webm|webp|key|aac|mp3|vtt|srt|png|jpg|jpeg)(?:[/?#]|$))[A-Za-z0-9._~-]{6,}(?:\/|[?#]|$)/i;

const PATH_PAIRED_TOKEN_TS_RE =
  /\/(?:[A-Za-z0-9_-]{16,}\/(?:1[5-9]\d{8}|2\d{9})|(?:1[5-9]\d{8}|2\d{9})\/[A-Za-z0-9_-]{16,})(?:\/|[?#]|$)/;

const EMBEDDED_JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

export function hasExpirableHlsTokens(input: string): boolean {
  if (!input) return false;
  try {
    NAMED_EXPIRABLE_PARAM_RE.lastIndex = 0;
    if (NAMED_EXPIRABLE_PARAM_RE.test(input)) return true;

    SHORT_QUERY_EXPIRABLE_PARAM_RE.lastIndex = 0;
    if (SHORT_QUERY_EXPIRABLE_PARAM_RE.test(input)) return true;

    if (
      PATH_NAMED_EXPIRY_RE.test(input) ||
      PATH_NAMED_TOKEN_RE.test(input) ||
      PATH_PAIRED_TOKEN_TS_RE.test(input) ||
      EMBEDDED_JWT_RE.test(input)
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export function describeExpirableHlsTokens(input: string): string[] {
  if (!input) return [];
  const matches: string[] = [];
  const pushUnique = (label: string) => {
    if (!matches.includes(label)) {
      matches.push(label);
    }
  };

  try {
    NAMED_EXPIRABLE_PARAM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NAMED_EXPIRABLE_PARAM_RE.exec(input)) !== null) {
      const lower = (m[1] ?? '').toLowerCase();
      if (lower === 'x-amz-expires') {
        pushUnique('X-Amz-Expires');
      } else if (lower) {
        pushUnique(`${lower}=`);
      }
    }

    SHORT_QUERY_EXPIRABLE_PARAM_RE.lastIndex = 0;
    while ((m = SHORT_QUERY_EXPIRABLE_PARAM_RE.exec(input)) !== null) {
      const lower = (m[1] ?? '').toLowerCase();
      if (lower) {
        pushUnique(`${lower}=`);
      }
    }

    if (
      PATH_NAMED_EXPIRY_RE.test(input) ||
      PATH_NAMED_TOKEN_RE.test(input) ||
      PATH_PAIRED_TOKEN_TS_RE.test(input)
    ) {
      pushUnique('assinatura no caminho');
    }

    if (EMBEDDED_JWT_RE.test(input)) {
      pushUnique('jwt');
    }
  } catch {
    return matches;
  }

  return matches;
}

function parseUnixEpochSeconds(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{9,13}$/.test(trimmed)) return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num <= 0) return null;
  return trimmed.length >= 12 ? Math.floor(num / 1000) : num;
}

function parseAmzIsoDateSeconds(raw: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const min = Number(m[5]);
  const sec = Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) {
    return null;
  }
  const ms = Date.UTC(year, month - 1, day, hour, min, sec);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function extractExpirableTokenRemainingSeconds(
  rawUrl: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): number | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    const expiries: number[] = [];
    const paramsLower = new Map<string, string>();

    for (const [k, v] of parsed.searchParams.entries()) {
      paramsLower.set(k.toLowerCase(), v);
    }

    for (const key of ['expire', 'expires', 'exp', 'e', 'x-goog-expires']) {
      const val = paramsLower.get(key);
      if (val) {
        const ts = parseUnixEpochSeconds(val);
        if (ts !== null) {
          expiries.push(ts - nowSeconds);
        }
      }
    }

    for (const nestedKey of ['hdnea', 'hdnts']) {
      const nestedVal = paramsLower.get(nestedKey);
      if (nestedVal) {
        const m = /(?:^|[~&])(?:exp|expires)=(\d{9,13})(?:$|[~&])/i.exec(nestedVal);
        if (m) {
          const ts = parseUnixEpochSeconds(m[1]);
          if (ts !== null) {
            expiries.push(ts - nowSeconds);
          }
        }
      }
    }

    const amzDate = paramsLower.get('x-amz-date');
    const amzExpires = paramsLower.get('x-amz-expires');
    if (amzDate && amzExpires && /^\d+$/.test(amzExpires.trim())) {
      const signedAt = parseAmzIsoDateSeconds(amzDate);
      const ttl = Number(amzExpires.trim());
      if (signedAt !== null && Number.isFinite(ttl) && ttl >= 0) {
        expiries.push(signedAt + ttl - nowSeconds);
      }
    }

    const pathNestedExp = /(?:^|[~/])(?:exp|expires)[=/](\d{9,13})(?:$|[~/?#])/i.exec(
      parsed.pathname
    );
    if (pathNestedExp) {
      const ts = parseUnixEpochSeconds(pathNestedExp[1]);
      if (ts !== null) {
        expiries.push(ts - nowSeconds);
      }
    }

    const pathPaired = /\/(?:1[5-9]\d{8}|2\d{9})(?:\/|$)/.exec(parsed.pathname);
    if (pathPaired && PATH_PAIRED_TOKEN_TS_RE.test(parsed.pathname)) {
      const tsMatch = /(1[5-9]\d{8}|2\d{9})/.exec(pathPaired[0]);
      if (tsMatch) {
        const ts = parseUnixEpochSeconds(tsMatch[1]);
        if (ts !== null) {
          expiries.push(ts - nowSeconds);
        }
      }
    }

    if (expiries.length === 0) return null;
    return Math.min(...expiries);
  } catch {
    return null;
  }
}

export function isExpirableHlsSourceUrl(
  rawUrl: string,
  explicitKind?: ExplicitSourceKind | string | null
): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed || !hasExpirableHlsTokens(trimmed)) {
    return false;
  }
  const kind = detectSourceKind(trimmed, explicitKind);
  if (kind === 'hls') {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return /\.(m3u8|m3u)$/i.test(parsed.pathname);
  } catch {
    return /\.(m3u8|m3u)(?:[?#]|$)/i.test(trimmed);
  }
}

export function validateHttpUrl(
  raw: string,
  maxLength = MAX_URL_LENGTH
): UrlValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: 'URL vazia.' };
  }
  if (trimmed.length > maxLength) {
    return { valid: false, error: 'URL excede o limite máximo de caracteres.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'URL inválida. Informe uma URL completa com http:// ou https://.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'Apenas URLs HTTP e HTTPS são permitidas.' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Credenciais embutidas na URL não são permitidas.' };
  }

  if (!parsed.hostname) {
    return { valid: false, error: 'Hostname inválido na URL.' };
  }

  return { valid: true, normalizedUrl: parsed.toString() };
}

export function validateVideoSourceUrl(raw: string): UrlValidationResult {
  return validateHttpUrl(raw, MAX_VIDEO_SOURCE_URL_LENGTH);
}

export function isMaximaimgHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'maximaimg.online' || lower.endsWith('.maximaimg.online');
}

export function isGoogleVideoHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  if (!lower) return false;
  return lower === 'googlevideo.com' || lower.endsWith('.googlevideo.com');
}

export function isGoogleVideoPlaybackUrl(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }
  if (!isGoogleVideoHost(url.hostname)) {
    return false;
  }
  const path = url.pathname.toLowerCase();
  return path === '/videoplayback' || path.startsWith('/videoplayback/');
}

export function isGoogleVideoUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    return isGoogleVideoPlaybackUrl(parsed);
  } catch {
    return false;
  }
}

export interface GoogleVideoSourceInspection {
  isGoogleVideo: boolean;
  hasSignedParams: boolean;
  hasExpireParam: boolean;
  badgeLabel: string | null;
  warningMessage: string | null;
}

export function inspectGoogleVideoSourceUrl(rawUrl: string): GoogleVideoSourceInspection {
  const trimmed = rawUrl.trim();
  if (!trimmed || !isGoogleVideoUrl(trimmed)) {
    return {
      isGoogleVideo: false,
      hasSignedParams: false,
      hasExpireParam: false,
      badgeLabel: null,
      warningMessage: null,
    };
  }

  let hasSignedParams = false;
  let hasExpireParam = false;
  try {
    const parsed = new URL(trimmed);
    for (const key of parsed.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (lower === 'expire') hasExpireParam = true;
      if (lower === 'sig' || lower === 'lsig' || lower === 'signature') {
        hasSignedParams = true;
      }
    }
  } catch {
    // Ignore parse edge cases
  }

  return {
    isGoogleVideo: true,
    hasSignedParams,
    hasExpireParam,
    badgeLabel: 'Google Video · temporário',
    warningMessage:
      'URL temporária do Google Video (/videoplayback): contém assinatura/expiração temporária e pode parar de reproduzir após o vencimento.',
  };
}

export function isVercelBlobHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  if (!lower) return false;
  return (
    isDirectMediaHost(lower) ||
    (lower.endsWith('.blob.vercel-storage.com') &&
      lower.length > '.blob.vercel-storage.com'.length)
  );
}

export function isVercelBlobUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return isVercelBlobHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function isR2StorageHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  if (!lower) return false;
  return lower === 'r2.cloudflarestorage.com' || lower.endsWith('.r2.cloudflarestorage.com');
}

export function isR2StorageUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return isR2StorageHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function hasR2SignedQueryParams(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (!isR2StorageHost(parsed.hostname)) {
      return false;
    }
    for (const key of parsed.searchParams.keys()) {
      if (key.toLowerCase().startsWith('x-amz-')) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export interface R2SourceInspection {
  isR2: boolean;
  hasAmzSignature: boolean;
  hasOtherAuthParams: boolean;
  status: 'none' | 'r2_signed' | 'r2_unsigned';
  badgeLabel: string | null;
  warningMessage: string | null;
}

export function inspectR2SourceUrl(rawUrl: string): R2SourceInspection {
  const trimmed = rawUrl.trim();
  if (!trimmed || !isR2StorageUrl(trimmed)) {
    return {
      isR2: false,
      hasAmzSignature: false,
      hasOtherAuthParams: false,
      status: 'none',
      badgeLabel: null,
      warningMessage: null,
    };
  }

  const hasAmzSignature = hasR2SignedQueryParams(trimmed);
  const hasOtherAuthParams = !hasAmzSignature && hasExpirableHlsTokens(trimmed);

  if (hasAmzSignature) {
    return {
      isR2: true,
      hasAmzSignature: true,
      hasOtherAuthParams: false,
      status: 'r2_signed',
      badgeLabel: 'R2 · assinatura temporária',
      warningMessage:
        'URL do Cloudflare R2 com assinatura X-Amz-* potencialmente temporária: o link pode expirar após algumas horas. Recomenda-se salvar uma cópia ("Guardar cópia") enquanto o link ainda estiver válido.',
    };
  }

  return {
    isR2: true,
    hasAmzSignature: false,
    hasOtherAuthParams,
    status: 'r2_unsigned',
    badgeLabel: 'R2 · sem assinatura na URL',
    warningMessage:
      'Endereço de armazenamento Cloudflare R2 sem parâmetros de assinatura (X-Amz-*) identificados na URL. Isso não comprova que o link seja permanente ou que esteja acessível. Se foi obtido pelo 1DM e possui validade temporária, recomenda-se usar "Guardar cópia" enquanto o link ainda estiver válido.',
  };
}

export function deriveKindFromExtension(rawUrl: string): ExplicitSourceKind {
  const trimmed = rawUrl.trim();
  if (!trimmed) return 'mp4';

  try {
    const parsed = new URL(trimmed, 'http://localhost');
    const path = parsed.pathname.toLowerCase();
    if (/\.(m3u8|m3u)$/i.test(path)) {
      return 'hls';
    }
    if (/\.(mp4|m4v|webm)$/i.test(path)) {
      return 'mp4';
    }
  } catch {
    const lower = trimmed.toLowerCase();
    if (/\.(m3u8|m3u)(?:[?#]|$)/i.test(lower)) {
      return 'hls';
    }
    if (/\.(mp4|m4v|webm)(?:[?#]|$)/i.test(lower)) {
      return 'mp4';
    }
  }

  return 'mp4';
}

export function parseMuxPlaybackUrl(url: URL): { playbackId: string; hlsUrl: string; embedUrl: string } | null {
  const host = url.hostname.toLowerCase();
  if (host === 'player.mux.com') {
    const segments = url.pathname.split('/').filter(Boolean);
    const candidate = segments[0];
    if (!candidate || !/^[A-Za-z0-9_-]{8,128}$/.test(candidate)) {
      return null;
    }
    const streamUrl = new URL(`https://stream.mux.com/${candidate}.m3u8`);
    const token = url.searchParams.get('token');
    if (token) {
      streamUrl.searchParams.set('token', token);
    }
    return {
      playbackId: candidate,
      hlsUrl: streamUrl.toString(),
      embedUrl: url.toString(),
    };
  }

  if (host === 'stream.mux.com') {
    const match = url.pathname.match(/^\/([A-Za-z0-9_-]{8,128})\.m3u8$/i);
    if (!match) return null;
    return {
      playbackId: match[1],
      hlsUrl: url.toString(),
      embedUrl: `https://player.mux.com/${match[1]}`,
    };
  }

  return null;
}

export function parseBunnyEmbedUrl(
  url: URL
): { libraryId: string; videoId: string; embedUrl: string } | null {
  const host = url.hostname.toLowerCase();
  if (host !== 'player.mediadelivery.net' && host !== 'iframe.mediadelivery.net') {
    return null;
  }

  const match = url.pathname.match(/^\/(?:embed|play)\/([0-9]+)\/([0-9a-fA-F-]{8,64})\/?$/);
  if (!match) {
    return null;
  }

  const libraryId = match[1];
  const videoId = match[2];
  const embed = new URL(`https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}`);
  for (const [k, v] of url.searchParams.entries()) {
    embed.searchParams.set(k, v);
  }

  return {
    libraryId,
    videoId,
    embedUrl: embed.toString(),
  };
}

function getQueryParamCaseInsensitive(url: URL, name: string): string | null {
  const target = name.toLowerCase();
  for (const [k, v] of url.searchParams.entries()) {
    if (k.toLowerCase() === target) {
      return v;
    }
  }
  return null;
}

function detectDirectOrStreamKind(url: URL): 'mp4' | 'webm' | 'hls' | null {
  const path = url.pathname.toLowerCase();
  const fullQuery = url.search.toLowerCase();
  const mimeParam = (getQueryParamCaseInsensitive(url, 'mime') ?? '').trim().toLowerCase();

  if (/\.(m3u8|m3u)($|[?#])/i.test(path) || path.includes('/hls/') || fullQuery.includes('m3u8') || fullQuery.includes('type=hls')) {
    return 'hls';
  }

  if (
    /\.(mp4|m4v)($|[?#])/i.test(path) ||
    mimeParam === 'video/mp4' ||
    fullQuery.includes('video/mp4') ||
    fullQuery.includes('video%2fmp4') ||
    fullQuery.includes('format=mp4') ||
    (isGoogleVideoPlaybackUrl(url) &&
      !mimeParam.startsWith('audio/') &&
      mimeParam !== 'video/webm')
  ) {
    return 'mp4';
  }

  if (
    /\.webm($|[?#])/i.test(path) ||
    mimeParam === 'video/webm' ||
    fullQuery.includes('video/webm') ||
    fullQuery.includes('video%2fwebm') ||
    fullQuery.includes('format=webm')
  ) {
    return 'webm';
  }

  return null;
}

function isLikelyHtmlPage(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  return (
    path.includes('playerricas.php') ||
    /\.(html?|php|asp|aspx|jsp)$/i.test(path)
  );
}

export function detectSourceKind(
  rawUrl: string,
  explicitKind?: ExplicitSourceKind | string | null
): ExplicitSourceKind {
  const explicit = normalizeExplicitSourceKind(explicitKind);
  if (explicit) {
    return explicit;
  }

  const validation = validateHttpUrl(rawUrl, MAX_VIDEO_SOURCE_URL_LENGTH);
  const candidate = validation.normalizedUrl ?? rawUrl.trim();
  if (!candidate) {
    return 'iframe';
  }

  if (candidate.toLowerCase().includes('playerricas.php')) {
    return 'iframe';
  }

  try {
    const parsed = new URL(candidate);
    const path = parsed.pathname.toLowerCase();

    if (isLikelyHtmlPage(parsed)) {
      return 'iframe';
    }
    if (/\.m3u8$/i.test(path) || /\.m3u$/i.test(path) || path.includes('/index.m3u8') || path.includes('/index.m3u')) {
      return 'hls';
    }
    if (/\.(mp4|m4v|webm)$/i.test(path)) {
      return 'mp4';
    }

    if (parseMuxPlaybackUrl(parsed) || parseBunnyEmbedUrl(parsed)) {
      return 'hls';
    }

    const mediaKind = detectDirectOrStreamKind(parsed);
    if (mediaKind === 'hls') return 'hls';
    if (mediaKind === 'mp4' || mediaKind === 'webm') return 'mp4';
  } catch {
    const lower = candidate.toLowerCase();
    if (lower.includes('playerricas.php') || /\.php(?:[?#]|$)/i.test(lower)) {
      return 'iframe';
    }
    if (/\.m3u8(?:[?#]|$)/i.test(lower)) {
      return 'hls';
    }
    if (/\.(mp4|webm)(?:[?#]|$)/i.test(lower)) {
      return 'mp4';
    }
  }

  return 'iframe';
}

const HASH_PARAM_NAMES = new Set(['cv', 'cv2', 'cv3', 'cv4']);

export function hasUrlHashParams(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;

  if (trimmed.startsWith('/api/embed?')) {
    try {
      const wrapper = new URL(trimmed, 'http://localhost');
      const inner = wrapper.searchParams.get('u');
      if (inner) {
        return hasUrlHashParams(inner);
      }
    } catch {
      // Segue para tentativa de parse direto/regex
    }
  }

  try {
    const parsed = new URL(trimmed);
    for (const key of parsed.searchParams.keys()) {
      if (HASH_PARAM_NAMES.has(key.toLowerCase())) {
        return true;
      }
    }
    return false;
  } catch {
    return /(?:^|[?&])(?:cv|cv2|cv3|cv4)(?:=|&|$)/i.test(trimmed);
  }
}

export function buildIframeSrcWithFreshTime(
  rawUrl: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  if (hasUrlHashParams(rawUrl)) {
    return rawUrl;
  }

  if (rawUrl.startsWith('/api/embed?')) {
    try {
      const wrapper = new URL(rawUrl, 'http://localhost');
      const inner = wrapper.searchParams.get('u');
      if (inner && /[?&]time=/i.test(inner)) {
        const refreshedInner = inner.replace(/([?&]time=)[^&#]*/i, `$1${nowSeconds}`);
        return `/api/embed?u=${encodeURIComponent(refreshedInner)}`;
      }
      return rawUrl;
    } catch {
      return rawUrl;
    }
  }

  try {
    const parsed = new URL(rawUrl);
    if (!parsed.searchParams.has('time')) {
      return rawUrl;
    }
    return rawUrl.replace(/([?&]time=)[^&#]*/i, `$1${nowSeconds}`);
  } catch {
    if (!/[?&]time=/i.test(rawUrl)) {
      return rawUrl;
    }
    return rawUrl.replace(/([?&]time=)[^&#]*/i, `$1${nowSeconds}`);
  }
}

export function normalizeVideoSource(
  rawUrl: string,
  slot: 1 | 2 | 3 | 4 | 5,
  explicitKind?: ExplicitSourceKind | string | null
): NormalizedVideoSource | null {
  const validation = validateHttpUrl(rawUrl, MAX_VIDEO_SOURCE_URL_LENGTH);
  if (!validation.valid || !validation.normalizedUrl) {
    return null;
  }

  const normalizedUrl = validation.normalizedUrl;
  const parsed = new URL(normalizedUrl);
  const host = parsed.hostname.toLowerCase();
  const label = `Player ${slot}`;
  const forcedKind = normalizeExplicitSourceKind(explicitKind);
  const blobMirror = isDirectMediaHost(host) || isVercelBlobHost(host);

  // 0a. Fontes espelho / mídia direta no Vercel Blob -> vídeo direto nativo, sem proxy (/api/proxy/stream) e sem hls.js
  if (blobMirror) {
    const directKind: SourceKind = /\.webm($|[?#])/i.test(parsed.pathname) ? 'webm' : 'mp4';
    return {
      slot,
      label,
      rawUrl: normalizedUrl,
      resolvedUrl: normalizedUrl,
      kind: directKind,
      provider: 'direct',
      needsProxy: false,
      requiresServerResolve: false,
      formatLabel: directKind === 'webm' ? 'WebM · Espelho' : 'MP4 · Espelho',
      isMirror: true,
    };
  }

  // 0. Override explícito ou página de player (playerricas.php / .php / .html) -> iframe direto (sem proxy)
  if (forcedKind === 'iframe' || (!forcedKind && isLikelyHtmlPage(parsed))) {
    return {
      slot,
      label,
      rawUrl: normalizedUrl,
      resolvedUrl: normalizedUrl,
      fallbackIframeUrl: normalizedUrl,
      kind: 'iframe',
      provider: 'iframe',
      needsProxy: false,
      requiresServerResolve: false,
      formatLabel: 'Iframe · Player',
    };
  }

  if (forcedKind === 'hls') {
    const maxima = isMaximaimgHost(host);
    const googleVideo = isGoogleVideoPlaybackUrl(parsed);
    return {
      slot,
      label,
      rawUrl: normalizedUrl,
      resolvedUrl: normalizedUrl,
      kind: 'hls',
      provider: maxima ? 'maximaimg' : 'hls',
      needsProxy: true,
      requiresServerResolve: false,
      formatLabel: maxima ? 'Maximaimg · HLS' : 'HLS',
      ...(hasExpirableHlsTokens(normalizedUrl) || isR2StorageHost(host) || googleVideo
        ? { isExpirable: true }
        : {}),
    };
  }

  if (forcedKind === 'mp4') {
    const maxima = isMaximaimgHost(host);
    const googleVideo = isGoogleVideoPlaybackUrl(parsed);
    const expirable =
      isR2StorageHost(host) ||
      googleVideo ||
      hasExpirableHlsTokens(normalizedUrl);
    return {
      slot,
      label,
      rawUrl: normalizedUrl,
      resolvedUrl: normalizedUrl,
      kind: 'mp4',
      provider: maxima ? 'maximaimg' : googleVideo ? 'googlevideo' : 'direct',
      needsProxy: true,
      requiresServerResolve: false,
      formatLabel: maxima
        ? 'Maximaimg · MP4'
        : googleVideo
          ? 'Google Video · MP4'
          : 'MP4',
      ...(expirable ? { isExpirable: true } : {}),
    };
  }

  // 1. Mux (player.mux.com -> stream.mux.com/*.m3u8)
  const mux = parseMuxPlaybackUrl(parsed);
  if (mux) {
    return {
      slot,
      label,
      rawUrl: normalizedUrl,
      resolvedUrl: mux.hlsUrl,
      fallbackIframeUrl: mux.embedUrl,
      kind: 'hls',
      provider: 'mux',
      needsProxy: true,
      requiresServerResolve: false,
      formatLabel: 'Mux · HLS',
    };
  }

  // 2. Bunny Stream (player.mediadelivery.net/embed -> server-side HLS resolver with iframe fallback)
  const bunny = parseBunnyEmbedUrl(parsed);
  if (bunny) {
    return {
      slot,
      label,
      rawUrl: normalizedUrl,
      resolvedUrl: bunny.embedUrl,
      fallbackIframeUrl: bunny.embedUrl,
      kind: 'bunny',
      provider: 'bunny',
      needsProxy: false,
      requiresServerResolve: true,
      formatLabel: 'Bunny Stream',
    };
  }

  // Bunny CDN direct HLS playlist
  if (host.endsWith('.b-cdn.net') && /\.m3u8$/i.test(parsed.pathname)) {
    return {
      slot,
      label,
      rawUrl: normalizedUrl,
      resolvedUrl: normalizedUrl,
      kind: 'hls',
      provider: 'bunny',
      needsProxy: true,
      requiresServerResolve: false,
      formatLabel: 'Bunny · HLS',
    };
  }

  // 3. Special source: maximaimg.online (proxied with Referer + User-Agent + M3U8 rewrite)
  if (isMaximaimgHost(host)) {
    const directKind = detectDirectOrStreamKind(parsed);
    const kind: SourceKind = isLikelyHtmlPage(parsed)
      ? 'iframe'
      : directKind ?? 'hls';

    return {
      slot,
      label,
      rawUrl: normalizedUrl,
      resolvedUrl: normalizedUrl,
      kind,
      provider: 'maximaimg',
      needsProxy: kind !== 'iframe',
      requiresServerResolve: false,
      formatLabel: kind === 'iframe' ? 'Maximaimg · Embed' : `Maximaimg · ${kind.toUpperCase()}`,
      ...(kind === 'hls' && hasExpirableHlsTokens(normalizedUrl) ? { isExpirable: true } : {}),
    };
  }

  // 3b. Embed proxied hosts (e.g. allappinc.com) -> iframe routed via /api/embed unless direct media extension
  if (
    isEmbedProxiedHost(host) &&
    !/\.(m3u8|m3u|mp4|m4v|webm)$/i.test(parsed.pathname)
  ) {
    return {
      slot,
      label,
      rawUrl: normalizedUrl,
      resolvedUrl: normalizedUrl,
      fallbackIframeUrl: normalizedUrl,
      kind: 'iframe',
      provider: 'iframe',
      needsProxy: false,
      requiresServerResolve: false,
      formatLabel: 'Iframe · Embed Proxy',
    };
  }

  // 4. Direct video (MP4 / WebM) & Streaming (HLS / M3U8 / M3U) -> proxy ativo por padrão
  if (!isLikelyHtmlPage(parsed)) {
    const mediaKind = detectDirectOrStreamKind(parsed);
    const isR2 = isR2StorageHost(host);
    const isGoogleVideo = isGoogleVideoPlaybackUrl(parsed);
    const hasTokens = hasExpirableHlsTokens(normalizedUrl);
    const expirable = isR2 || isGoogleVideo || hasTokens;
    if (mediaKind === 'mp4') {
      return {
        slot,
        label,
        rawUrl: normalizedUrl,
        resolvedUrl: normalizedUrl,
        kind: 'mp4',
        provider: isGoogleVideo ? 'googlevideo' : 'direct',
        needsProxy: true,
        requiresServerResolve: false,
        formatLabel: isGoogleVideo ? 'Google Video · MP4' : 'MP4',
        ...(expirable ? { isExpirable: true } : {}),
      };
    }
    if (mediaKind === 'webm') {
      return {
        slot,
        label,
        rawUrl: normalizedUrl,
        resolvedUrl: normalizedUrl,
        kind: 'webm',
        provider: isGoogleVideo ? 'googlevideo' : 'direct',
        needsProxy: true,
        requiresServerResolve: false,
        formatLabel: isGoogleVideo ? 'Google Video · WebM' : 'WebM',
        ...(expirable ? { isExpirable: true } : {}),
      };
    }
    if (mediaKind === 'hls') {
      return {
        slot,
        label,
        rawUrl: normalizedUrl,
        resolvedUrl: normalizedUrl,
        kind: 'hls',
        provider: 'hls',
        needsProxy: true,
        requiresServerResolve: false,
        formatLabel: 'HLS',
        ...(expirable ? { isExpirable: true } : {}),
      };
    }
  }

  // 5. Compatible iframe embed fallback (never treat generic HTML pages as MP4)
  return {
    slot,
    label,
    rawUrl: normalizedUrl,
    resolvedUrl: normalizedUrl,
    fallbackIframeUrl: normalizedUrl,
    kind: 'iframe',
    provider: 'iframe',
    needsProxy: false,
    requiresServerResolve: false,
    formatLabel: 'Embed',
  };
}

export interface EpisodeUrlsInput {
  video_url: string;
  video_url_2?: string | null;
  video_url_3?: string | null;
  video_url_4?: string | null;
  video_url_5?: string | null;
  source_kind?: ExplicitSourceKind | string | null;
  source_kind_2?: ExplicitSourceKind | string | null;
  source_kind_3?: ExplicitSourceKind | string | null;
  source_kind_4?: ExplicitSourceKind | string | null;
  source_kind_5?: ExplicitSourceKind | string | null;
  is_mirror?: boolean | null;
  is_mirror_2?: boolean | null;
  is_mirror_3?: boolean | null;
  is_mirror_4?: boolean | null;
  is_mirror_5?: boolean | null;
}

function getSourcePriorityRank(src: NormalizedVideoSource): number {
  if (src.isMirror || isVercelBlobUrl(src.resolvedUrl)) return -1;
  if (src.kind !== 'iframe') return 0;
  if (isPlayerricasSource(src.resolvedUrl) || classifyEmbedHost(src.resolvedUrl) === 'direct') {
    return 0;
  }
  if (classifyEmbedHost(src.resolvedUrl) === 'proxied') {
    return 1;
  }
  return 0;
}

export function collectEpisodeSources(episode: EpisodeUrlsInput): NormalizedVideoSource[] {
  const candidates: Array<{
    slot: 1 | 2 | 3 | 4 | 5;
    url: string | null | undefined;
    kind: ExplicitSourceKind | string | null | undefined;
    isMirror: boolean;
  }> = [
    { slot: 1, url: episode.video_url, kind: episode.source_kind, isMirror: Boolean(episode.is_mirror) },
    { slot: 2, url: episode.video_url_2, kind: episode.source_kind_2, isMirror: Boolean(episode.is_mirror_2) },
    { slot: 3, url: episode.video_url_3, kind: episode.source_kind_3, isMirror: Boolean(episode.is_mirror_3) },
    { slot: 4, url: episode.video_url_4, kind: episode.source_kind_4, isMirror: Boolean(episode.is_mirror_4) },
    { slot: 5, url: episode.video_url_5, kind: episode.source_kind_5, isMirror: Boolean(episode.is_mirror_5) },
  ];

  const sources: NormalizedVideoSource[] = [];
  for (const item of candidates) {
    if (!item.url || !item.url.trim()) continue;
    const normalized = normalizeVideoSource(item.url, item.slot, item.kind);
    if (normalized) {
      const isMirror = Boolean(
        normalized.isMirror ||
          item.isMirror ||
          isDirectMediaUrl(normalized.resolvedUrl) ||
          isVercelBlobUrl(normalized.resolvedUrl)
      );
      sources.push(
        isMirror
          ? {
              ...normalized,
              isMirror: true,
              needsProxy: false,
            }
          : normalized
      );
    }
  }
  return sources.sort((a, b) => getSourcePriorityRank(a) - getSourcePriorityRank(b));
}

export interface EpisodeMirrorInfo {
  hasMirror: boolean;
  slot: 1 | 2 | 3 | 4 | 5 | null;
  url: string | null;
  kind: ExplicitSourceKind | null;
  isVercelBlob: boolean;
}

export function getEpisodeMirrorInfo(
  episode: Pick<
    EpisodeUrlsInput,
    | 'video_url'
    | 'video_url_2'
    | 'video_url_3'
    | 'video_url_4'
    | 'video_url_5'
    | 'source_kind'
    | 'source_kind_2'
    | 'source_kind_3'
    | 'source_kind_4'
    | 'source_kind_5'
    | 'is_mirror'
    | 'is_mirror_2'
    | 'is_mirror_3'
    | 'is_mirror_4'
    | 'is_mirror_5'
  >
): EpisodeMirrorInfo {
  const slots: Array<{
    slot: 1 | 2 | 3 | 4 | 5;
    url: string | null | undefined;
    explicitKind: ExplicitSourceKind | string | null | undefined;
    isMirrorFlag: boolean | null | undefined;
  }> = [
    {
      slot: 1,
      url: episode.video_url,
      explicitKind: episode.source_kind,
      isMirrorFlag: episode.is_mirror,
    },
    {
      slot: 2,
      url: episode.video_url_2,
      explicitKind: episode.source_kind_2,
      isMirrorFlag: episode.is_mirror_2,
    },
    {
      slot: 3,
      url: episode.video_url_3,
      explicitKind: episode.source_kind_3,
      isMirrorFlag: episode.is_mirror_3,
    },
    {
      slot: 4,
      url: episode.video_url_4,
      explicitKind: episode.source_kind_4,
      isMirrorFlag: episode.is_mirror_4,
    },
    {
      slot: 5,
      url: episode.video_url_5,
      explicitKind: episode.source_kind_5,
      isMirrorFlag: episode.is_mirror_5,
    },
  ];

  for (const item of slots) {
    const trimmed = item.url?.trim() ?? '';
    if (!trimmed) continue;
    const urlCheck = validateHttpUrl(trimmed, MAX_VIDEO_SOURCE_URL_LENGTH);
    if (!urlCheck.valid || !urlCheck.normalizedUrl) continue;
    if (isVercelBlobUrl(urlCheck.normalizedUrl)) {
      return {
        hasMirror: true,
        slot: item.slot,
        url: urlCheck.normalizedUrl,
        kind:
          normalizeExplicitSourceKind(item.explicitKind) ??
          deriveKindFromExtension(urlCheck.normalizedUrl),
        isVercelBlob: true,
      };
    }
  }

  for (const item of slots) {
    const trimmed = item.url?.trim() ?? '';
    if (!trimmed) continue;
    const urlCheck = validateHttpUrl(trimmed, MAX_VIDEO_SOURCE_URL_LENGTH);
    if (!urlCheck.valid || !urlCheck.normalizedUrl) continue;
    if (item.isMirrorFlag === true && !isR2StorageUrl(urlCheck.normalizedUrl)) {
      const detected = detectSourceKind(urlCheck.normalizedUrl, item.explicitKind);
      return {
        hasMirror: true,
        slot: item.slot,
        url: urlCheck.normalizedUrl,
        kind:
          normalizeExplicitSourceKind(item.explicitKind) ??
          (detected === 'hls' || detected === 'mp4' || detected === 'iframe' ? detected : 'mp4'),
        isVercelBlob: false,
      };
    }
  }

  return {
    hasMirror: false,
    slot: null,
    url: null,
    kind: null,
    isVercelBlob: false,
  };
}

export function sanitizePlayableSourceForPublic(
  source: InternalPlayableSource | PlayableSource
): PublicPlayableSource {
  if (source.needsProxy) {
    return {
      slot: source.slot,
      label: source.label,
      kind: source.kind,
      provider: source.provider,
      needsProxy: true,
      requiresServerResolve: source.requiresServerResolve,
      formatLabel: source.formatLabel,
      playUrl: source.playUrl,
      ...(source.isMirror !== undefined ? { isMirror: source.isMirror } : {}),
      ...(source.isExpirable !== undefined ? { isExpirable: source.isExpirable } : {}),
    };
  }

  return {
    slot: source.slot,
    label: source.label,
    rawUrl: source.rawUrl ?? source.playUrl,
    resolvedUrl: source.resolvedUrl ?? source.playUrl,
    ...(source.fallbackIframeUrl !== undefined
      ? { fallbackIframeUrl: source.fallbackIframeUrl }
      : {}),
    kind: source.kind,
    provider: source.provider,
    needsProxy: false,
    requiresServerResolve: source.requiresServerResolve,
    formatLabel: source.formatLabel,
    playUrl: source.playUrl,
    ...(source.isMirror !== undefined ? { isMirror: source.isMirror } : {}),
    ...(source.isExpirable !== undefined ? { isExpirable: source.isExpirable } : {}),
  };
}

export function getNextFallbackSourceIndex(
  sources: ReadonlyArray<Pick<NormalizedVideoSource, 'slot'>>,
  currentIndex: number,
  failedSlots: ReadonlySet<number>
): number | null {
  for (let offset = 1; offset < sources.length; offset++) {
    const idx = (currentIndex + offset) % sources.length;
    if (!failedSlots.has(sources[idx].slot)) {
      return idx;
    }
  }
  return null;
}
