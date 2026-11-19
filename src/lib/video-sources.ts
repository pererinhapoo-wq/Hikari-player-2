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
}

export interface UrlValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
}

const MAX_URL_LENGTH = 2048;

export function normalizeExplicitSourceKind(raw: unknown): ExplicitSourceKind | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'iframe' || normalized === 'hls' || normalized === 'mp4') {
    return normalized;
  }
  return null;
}

export function validateHttpUrl(raw: string): UrlValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: 'URL vazia.' };
  }
  if (trimmed.length > MAX_URL_LENGTH) {
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

export function buildIframeSrcWithFreshTime(
  rawUrl: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
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
}

export function collectEpisodeSources(episode: EpisodeUrlsInput): NormalizedVideoSource[] {
  const candidates: Array<{
    slot: 1 | 2 | 3 | 4 | 5;
    url: string | null | undefined;
    kind: ExplicitSourceKind | string | null | undefined;
  }> = [
    { slot: 1, url: episode.video_url, kind: episode.source_kind },
    { slot: 2, url: episode.video_url_2, kind: episode.source_kind_2 },
    { slot: 3, url: episode.video_url_3, kind: episode.source_kind_3 },
    { slot: 4, url: episode.video_url_4, kind: episode.source_kind_4 },
    { slot: 5, url: episode.video_url_5, kind: episode.source_kind_5 },
  ];

  const sources: NormalizedVideoSource[] = [];
  for (const item of candidates) {
    if (!item.url || !item.url.trim()) continue;
    const normalized = normalizeVideoSource(item.url, item.slot, item.kind);
    if (normalized) {
      sources.push(normalized);
    }
  }
  return sources;
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
