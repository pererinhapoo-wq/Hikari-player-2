export type SourceKind = 'mp4' | 'webm' | 'hls' | 'bunny' | 'iframe';

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
  return /\.(html?|php|asp|aspx|jsp)$/i.test(path);
}

export function normalizeVideoSource(
  rawUrl: string,
  slot: 1 | 2 | 3 | 4 | 5
): NormalizedVideoSource | null {
  const validation = validateHttpUrl(rawUrl);
  if (!validation.valid || !validation.normalizedUrl) {
    return null;
  }

  const normalizedUrl = validation.normalizedUrl;
  const parsed = new URL(normalizedUrl);
  const host = parsed.hostname.toLowerCase();
  const label = `Player ${slot}`;

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
      needsProxy: false,
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
      needsProxy: false,
      requiresServerResolve: false,
      formatLabel: 'Bunny · HLS',
    };
  }

  // 3. Special source: maximaimg.online (proxied with Referer/Origin/User-Agent + M3U8 rewrite)
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

  // 4. Direct video (MP4 / WebM) & Streaming (HLS / M3U8 / M3U)
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
        needsProxy: false,
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
        needsProxy: false,
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
        needsProxy: false,
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
}

export function collectEpisodeSources(episode: EpisodeUrlsInput): NormalizedVideoSource[] {
  const candidates: Array<{ slot: 1 | 2 | 3 | 4 | 5; url: string | null | undefined }> = [
    { slot: 1, url: episode.video_url },
    { slot: 2, url: episode.video_url_2 },
    { slot: 3, url: episode.video_url_3 },
    { slot: 4, url: episode.video_url_4 },
    { slot: 5, url: episode.video_url_5 },
  ];

  const sources: NormalizedVideoSource[] = [];
  for (const item of candidates) {
    if (!item.url || !item.url.trim()) continue;
    const normalized = normalizeVideoSource(item.url, item.slot);
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
