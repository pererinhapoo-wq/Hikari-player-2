import {
  buildSignedProxyPath,
  rewriteM3u8Playlist,
  verifyProxySignature,
} from '@/lib/proxy-signing';
import { isAllowedProxyMediaUrl, safeFetchWithRedirects } from '@/lib/ssrf';
import { validateHttpUrl } from '@/lib/video-sources';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_MAXIMAIMG_REFERER = 'https://api.anivideo.net/';
const DEFAULT_COEMPREGOS_REFERER = 'https://www.coempregos.com.br/';
const EXTM3U_BYTES = [0x23, 0x45, 0x58, 0x54, 0x4d, 0x33, 0x55] as const; // "#EXTM3U"
const MAX_PEEK_BYTES = 512;

export function resolveUpstreamReferer(
  targetUrl: URL,
  refererMapJson = process.env.PLAYER_REFERER_MAP,
  maximaimgReferer = process.env.PLAYER_MAXIMAIMG_REFERER
): string {
  const hostname = targetUrl.hostname.toLowerCase();

  const rules = new Map<string, string>([
    ['maximaimg.online', maximaimgReferer?.trim() || DEFAULT_MAXIMAIMG_REFERER],
    ['mywallpaper-4k-image.net', ''],
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
    if (hostname === pattern || hostname.endsWith(`.${pattern}`)) {
      if (pattern.length > bestMatchLen) {
        bestMatchLen = pattern.length;
        bestReferer = refValue;
      }
    }
  }

  if (bestReferer !== null) {
    return bestReferer;
  }

  return `${targetUrl.origin}/`;
}

export function getUpstreamHeaders(targetUrl: URL, incomingRequest: Request): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
  };

  const referer = resolveUpstreamReferer(targetUrl);
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

export function shouldInspectForHlsManifest(contentType: string, targetUrl: URL): boolean {
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
    lowerPath.endsWith('.webm') ||
    lowerPath.endsWith('.aac')
  ) {
    return false;
  }
  return (
    lowerCt.includes('text/') ||
    lowerPath.endsWith('.m3u8') ||
    lowerPath.endsWith('.m3u')
  );
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

function buildBinaryResponseHeaders(
  upstream: Response,
  contentType: string,
  targetUrl?: URL
): Headers {
  const outHeaders = new Headers();
  outHeaders.set('Content-Type', resolveBinaryContentType(contentType, targetUrl));
  outHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
  outHeaders.set('CDN-Cache-Control', 'public, max-age=31536000, immutable');
  outHeaders.set('X-Content-Type-Options', 'nosniff');
  outHeaders.set('Access-Control-Allow-Origin', '*');
  outHeaders.set('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');

  const passthroughHeaders = ['content-length', 'content-range', 'accept-ranges'];
  for (const h of passthroughHeaders) {
    const val = upstream.headers.get(h);
    if (val) outHeaders.set(h, val);
  }

  return outHeaders;
}

function buildManifestResponseHeaders(): Headers {
  const outHeaders = new Headers();
  outHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  outHeaders.set('Cache-Control', 'public, max-age=5, stale-while-revalidate=30');
  outHeaders.set('CDN-Cache-Control', 'public, max-age=5, stale-while-revalidate=30');
  outHeaders.set('Access-Control-Allow-Origin', '*');
  return outHeaders;
}

async function handleInspectedUpstreamResponse(
  upstream: Response,
  finalUrl: string,
  contentType: string
): Promise<Response> {
  const finalParsed = new URL(finalUrl);
  if (!upstream.body) {
    const rawBytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytesStartWithExtM3u(rawBytes)) {
      const text = new TextDecoder('utf-8').decode(rawBytes);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const rewritten = rewriteM3u8Playlist(text, finalUrl, (resolved) =>
        buildSignedProxyPath(resolved, undefined, nowSeconds)
      );
      return new Response(rewritten, {
        status: 200,
        headers: buildManifestResponseHeaders(),
      });
    }

    const outHeaders = buildBinaryResponseHeaders(upstream, contentType, finalParsed);
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
    const nowSeconds = Math.floor(Date.now() / 1000);
    const rewritten = rewriteM3u8Playlist(text, finalUrl, (resolved) =>
      buildSignedProxyPath(resolved, undefined, nowSeconds)
    );
    return new Response(rewritten, {
      status: 200,
      headers: buildManifestResponseHeaders(),
    });
  }

  // Não é manifesto #EXTM3U (ex.: segmento binário ou chave servido com Content-Type: text/plain):
  // retransmitir os bytes originais intactos via stream sem decodificação UTF-8.
  const outHeaders = buildBinaryResponseHeaders(upstream, contentType, finalParsed);
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
}

export async function handleProxyStreamRequest(
  request: Request,
  deps: ProxyStreamDeps = {}
): Promise<Response> {
  const fetchWithRedirects = deps.fetchWithRedirects ?? safeFetchWithRedirects;
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
    if (!isAllowedProxyMediaUrl(targetUrl)) {
      return new Response('Extensão de destino não permitida no proxy.', { status: 403 });
    }
    const upstreamHeaders = getUpstreamHeaders(targetUrl, request);
    const { response: upstream, finalUrl } = await fetchWithRedirects(
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
    if (!isAllowedProxyMediaUrl(finalParsed)) {
      return new Response('Extensão de destino não permitida no proxy.', { status: 403 });
    }

    if (upstream.status !== 206 && shouldInspectForHlsManifest(contentType, finalParsed)) {
      return await handleInspectedUpstreamResponse(upstream, finalUrl, contentType);
    }

    const outHeaders = buildBinaryResponseHeaders(upstream, contentType, finalParsed);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Falha ao processar stream via proxy.';
    return new Response(message, { status: 502 });
  }
}
