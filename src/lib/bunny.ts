import { safeFetchWithRedirects } from '@/lib/ssrf';
import { parseBunnyEmbedUrl, validateHttpUrl } from '@/lib/video-sources';

export interface BunnyResolutionResult {
  ok: boolean;
  hlsUrl?: string;
  embedUrl: string;
  reason?: string;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function extractBunnyHlsFromHtml(html: string, videoId: string): string | null {
  const escapedVideoId = videoId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`https:\\/\\/vz-[a-z0-9-]+\\.b-cdn\\.net\\/${escapedVideoId}\\/playlist\\.m3u8(?:\\?[^"'\\s<>\\\\]*)?`, 'i'),
    /https:\/\/vz-[a-z0-9-]+\.b-cdn\.net\/[^"'\s<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?/i,
    /["'](https:\/\/[^"'\s<>\\]+\/playlist\.m3u8(?:\?[^"'\s<>\\]*)?)["']/i,
  ];

  for (const regex of patterns) {
    const match = html.match(regex);
    const candidate = match ? (match[1] ?? match[0]) : null;
    if (candidate) {
      const cleaned = candidate.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      const check = validateHttpUrl(cleaned);
      if (check.valid && check.normalizedUrl) {
        return check.normalizedUrl;
      }
    }
  }

  return null;
}

export async function resolveBunnyStreamSource(rawUrl: string): Promise<BunnyResolutionResult> {
  const validation = validateHttpUrl(rawUrl);
  if (!validation.valid || !validation.normalizedUrl) {
    throw new Error(validation.error || 'URL Bunny inválida.');
  }

  const parsed = new URL(validation.normalizedUrl);
  const bunnyInfo = parseBunnyEmbedUrl(parsed);
  if (!bunnyInfo) {
    throw new Error('URL não corresponde ao formato player.mediadelivery.net/embed.');
  }

  try {
    const { response } = await safeFetchWithRedirects(bunnyInfo.embedUrl, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Referer: 'https://iframe.mediadelivery.net/',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeoutMs: 10000,
    });

    if (!response.ok) {
      return {
        ok: false,
        embedUrl: bunnyInfo.embedUrl,
        reason: `Bunny embed retornou status ${response.status}; usando reprodução via embed.`,
      };
    }

    const html = await response.text();
    const hlsUrl = extractBunnyHlsFromHtml(html, bunnyInfo.videoId);
    if (!hlsUrl) {
      return {
        ok: false,
        embedUrl: bunnyInfo.embedUrl,
        reason: 'Playlist HLS protegida ou indisponível; usando fallback de embed.',
      };
    }

    return {
      ok: true,
      hlsUrl,
      embedUrl: bunnyInfo.embedUrl,
    };
  } catch {
    return {
      ok: false,
      embedUrl: bunnyInfo.embedUrl,
      reason: 'Não foi possível resolver a playlist diretamente; usando fallback de embed.',
    };
  }
}
