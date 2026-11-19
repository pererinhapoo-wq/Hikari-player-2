import {
  buildSignedProxyPath,
  rewriteM3u8Playlist,
  verifyProxySignature,
} from '@/lib/proxy-signing';
import { safeFetchWithRedirects } from '@/lib/ssrf';
import { isMaximaimgHost, validateHttpUrl } from '@/lib/video-sources';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const EXTM3U_BYTES = [0x23, 0x45, 0x58, 0x54, 0x4d, 0x33, 0x55] as const; // "#EXTM3U"
const MAX_PEEK_BYTES = 512;

export function getUpstreamHeaders(targetUrl: URL, incomingRequest: Request): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
  };

  if (isMaximaimgHost(targetUrl.hostname)) {
    const configuredReferer =
      process.env.PLAYER_MAXIMAIMG_REFERER?.trim() || 'https://api.anivideo.net/';
    headers['Referer'] = configuredReferer;
    try {
      headers['Origin'] = new URL(configuredReferer).origin;
    } catch {
      headers['Origin'] = 'https://api.anivideo.net';
    }
  } else {
    headers['Referer'] = `${targetUrl.origin}/`;
  }

  // Encaminhar apenas Range para seeking; nunca repassar Referer/Origin arbitrários do cliente.
  const range = incomingRequest.headers.get('range');
  if (range) {
    headers['Range'] = range;
  }

  return headers;
}

export function shouldInspectForHlsManifest(contentType: string, targetUrl: URL): boolean {
  const lowerCt = contentType.toLowerCase();
  const lowerPath = targetUrl.pathname.toLowerCase();
  return (
    lowerCt.includes('mpegurl') ||
    lowerCt.includes('m3u8') ||
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

function buildBinaryResponseHeaders(upstream: Response, contentType: string): Headers {
  const outHeaders = new Headers();
  outHeaders.set('Content-Type', contentType);
  outHeaders.set('Cache-Control', 'private, max-age=300');
  outHeaders.set('Access-Control-Allow-Origin', '*');

  const passthroughHeaders = ['content-length', 'content-range', 'accept-ranges'];
  for (const h of passthroughHeaders) {
    const val = upstream.headers.get(h);
    if (val) outHeaders.set(h, val);
  }

  return outHeaders;
}

async function handleInspectedUpstreamResponse(
  upstream: Response,
  finalUrl: string,
  contentType: string
): Promise<Response> {
  if (!upstream.body) {
    const rawBytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytesStartWithExtM3u(rawBytes)) {
      const text = new TextDecoder('utf-8').decode(rawBytes);
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

    const outHeaders = buildBinaryResponseHeaders(upstream, contentType);
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

  // Não é manifesto #EXTM3U (ex.: segmento binário ou chave servido com Content-Type: text/plain):
  // retransmitir os bytes originais intactos via stream sem decodificação UTF-8.
  const outHeaders = buildBinaryResponseHeaders(upstream, contentType);
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

    if (shouldInspectForHlsManifest(contentType, finalParsed)) {
      return await handleInspectedUpstreamResponse(upstream, finalUrl, contentType);
    }

    const outHeaders = buildBinaryResponseHeaders(upstream, contentType);
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
