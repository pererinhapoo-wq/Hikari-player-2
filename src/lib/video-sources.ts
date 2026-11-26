export type SourceKind = 'mp4' | 'webm' | 'hls' | 'bunny' | 'iframe';

export type ExplicitSourceKind = 'iframe' | 'hls' | 'mp4';

export type SourceProvider =
  | 'direct'
  | 'hls'
  | 'mux'
  | 'bunny'
  | 'maximaimg'
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

export function isDirectMediaUrl(rawUrl: string): boolean {
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

export function getIframeElementProps(rawUrl: string): {
  referrerPolicy: 'no-referrer' | 'no-referrer-when-downgrade';
  allow: string;
  sandbox?: string;
} {
  const referrerPolicy = getIframeReferrerPolicy(rawUrl);
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

export function hasExpirableHlsTokens(input: string): boolean {
  if (!input) return false;
  return /(?:x-amz-expires|token=|sig=)/i.test(input);
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

export function isMaximaimgHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'maximaimg.online' || lower.endsWith('.maximaimg.online');
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

export function isVercelBlobUrl(rawUrl: string): boolean {
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

function detectDirectOrStreamKind(url: URL): 'mp4' | 'webm' | 'hls' | null {
  const path = url.pathname.toLowerCase();
  const fullQuery = url.search.toLowerCase();

  if (/\.(m3u8|m3u)($|[?#])/i.test(path) || path.includes('/hls/') || fullQuery.includes('m3u8') || fullQuery.includes('type=hls')) {
    return 'hls';
  }

  if (/\.(mp4|m4v)($|[?#])/i.test(path) || fullQuery.includes('video/mp4') || fullQuery.includes('format=mp4')) {
    return 'mp4';
  }

  if (/\.webm($|[?#])/i.test(path) || fullQuery.includes('video/webm') || fullQuery.includes('format=webm')) {
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

  const validation = validateHttpUrl(rawUrl);
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
    if (/\.m3u8$/i.test(path) || /\.m3u$/i.test(path)) {
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
  const validation = validateHttpUrl(rawUrl);
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
      ...(hasExpirableHlsTokens(normalizedUrl) ? { isExpirable: true } : {}),
    };
  }

  if (forcedKind === 'mp4') {
    const maxima = isMaximaimgHost(host);
    return {
      slot,
      label,
      rawUrl: normalizedUrl,
      resolvedUrl: normalizedUrl,
      kind: 'mp4',
      provider: maxima ? 'maximaimg' : 'direct',
      needsProxy: true,
      requiresServerResolve: false,
      formatLabel: maxima ? 'Maximaimg · MP4' : 'MP4',
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
    if (mediaKind === 'mp4') {
      return {
        slot,
        label,
        rawUrl: normalizedUrl,
        resolvedUrl: normalizedUrl,
        kind: 'mp4',
        provider: 'direct',
        needsProxy: true,
        requiresServerResolve: false,
        formatLabel: 'MP4',
      };
    }
    if (mediaKind === 'webm') {
      return {
        slot,
        label,
        rawUrl: normalizedUrl,
        resolvedUrl: normalizedUrl,
        kind: 'webm',
        provider: 'direct',
        needsProxy: true,
        requiresServerResolve: false,
        formatLabel: 'WebM',
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
        ...(hasExpirableHlsTokens(normalizedUrl) ? { isExpirable: true } : {}),
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
      sources.push({
        ...normalized,
        ...(isMirror ? { isMirror: true, needsProxy: false } : {}),
      });
    }
  }
  return sources.sort((a, b) => getSourcePriorityRank(a) - getSourcePriorityRank(b));
}

export function getNextFallbackSourceIndex(
  sources: NormalizedVideoSource[],
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
