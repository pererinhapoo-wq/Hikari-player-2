import { createFileRoute } from '@tanstack/react-router';
import {
  buildSignedProxyPath,
  rewriteM3u8Playlist,
  verifyProxySignature,
} from '@/lib/proxy-signing';
import { safeFetchWithRedirects } from '@/lib/ssrf';
import { isMaximaimgHost, validateHttpUrl } from '@/lib/video-sources';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function getUpstreamHeaders(targetUrl: URL, incomingRequest: Request): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
  };

  if (isMaximaimgHost(targetUrl.hostname)) {
    const configuredReferer =
      process.env.PLAYER_MAXIMAIMG_REFERER?.trim() || 'https://maximaimg.online/';
    headers['Referer'] = configuredReferer;
    try {
      headers['Origin'] = new URL(configuredReferer).origin;
    } catch {
      headers['Origin'] = 'https://maximaimg.online';
    }
  } else {
    headers['Referer'] = `${targetUrl.origin}/`;
  }

  const range = incomingRequest.headers.get('range');
  if (range) {
    headers['Range'] = range;
  }

  return headers;
}

function isM3u8Response(contentType: string, targetUrl: URL, firstChunk: string): boolean {
  const lowerCt = contentType.toLowerCase();
  const lowerPath = targetUrl.pathname.toLowerCase();
  if (
    lowerCt.includes('mpegurl') ||
    lowerCt.includes('m3u8') ||
    lowerPath.endsWith('.m3u8') ||
    lowerPath.endsWith('.m3u')
  ) {
    return true;
  }
  return firstChunk.trimStart().startsWith('#EXTM3U');
}

export const Route = createFileRoute('/api/proxy/stream')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const reqUrl = new URL(request.url);
        const rawTarget = reqUrl.searchParams.get('url') ?? '';
        const exp = reqUrl.searchParams.get('exp');
        const sig = reqUrl.searchParams.get('sig');

        const urlCheck = validateHttpUrl(rawTarget);
        if (!urlCheck.valid || !urlCheck.normalizedUrl) {
          return new Response('Parâmetro de URL inválido.', { status: 400 });
        }

        if (!verifyProxySignature(urlCheck.normalizedUrl, exp, sig)) {
          return new Response('Assinatura de proxy inválida ou expirada.', { status: 403 });
        }

        try {
          const targetUrl = new URL(urlCheck.normalizedUrl);
          const upstreamHeaders = getUpstreamHeaders(targetUrl, request);
          const { response: upstream, finalUrl } = await safeFetchWithRedirects(
            targetUrl.toString(),
            { headers: upstreamHeaders, timeoutMs: 20000 }
          );

          if (!upstream.ok && upstream.status !== 206) {
            return new Response(`Origem retornou erro HTTP ${upstream.status}.`, {
              status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
            });
          }

          const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
          const finalParsed = new URL(finalUrl);
          const maybePlaylist =
            contentType.toLowerCase().includes('mpegurl') ||
            contentType.toLowerCase().includes('text/') ||
            finalParsed.pathname.toLowerCase().endsWith('.m3u8') ||
            finalParsed.pathname.toLowerCase().endsWith('.m3u');

          if (maybePlaylist) {
            const text = await upstream.text();
            if (isM3u8Response(contentType, finalParsed, text)) {
              const rewritten = rewriteM3u8Playlist(text, finalUrl, (resolved) =>
                buildSignedProxyPath(resolved)
              );
              return new Response(rewritten, {
                status: 200,
                headers: {
                  'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
                  'Cache-Control': 'no-store',
                  'Access-Control-Allow-Origin': '*',
                },
              });
            }
            return new Response(text, {
              status: upstream.status,
              headers: {
                'Content-Type': contentType,
                'Cache-Control': 'no-store',
              },
            });
          }

          const outHeaders = new Headers();
          outHeaders.set('Content-Type', contentType);
          outHeaders.set('Cache-Control', 'private, max-age=300');
          outHeaders.set('Access-Control-Allow-Origin', '*');

          const passthroughHeaders = ['content-length', 'content-range', 'accept-ranges'];
          for (const h of passthroughHeaders) {
            const val = upstream.headers.get(h);
            if (val) outHeaders.set(h, val);
          }

          return new Response(upstream.body, {
            status: upstream.status,
            headers: outHeaders,
          });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Falha ao processar stream via proxy.';
          return new Response(message, { status: 502 });
        }
      },
    },
  },
});
