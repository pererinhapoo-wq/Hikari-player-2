import {
  buildSignedProxyPath,
  MAX_HLS_REWRITE_DEPTH,
  rewriteM3u8Playlist,
  verifyProxyDepth,
  verifyProxyReferer,
  verifyProxySignature,
} from '@/lib/proxy-signing';
import { isAllowedProxyMediaUrl, safeFetchWithRedirects } from '@/lib/ssrf';
import {
  DIRECT_MEDIA_HOSTS,
  hasExpirableHlsTokens,
  isDirectMediaHost,
  isMaximaimgHost,
  validateHttpUrl,
} from '@/lib/video-sources';

export { DIRECT_MEDIA_HOSTS, isDirectMediaHost };
const MAX_PROXY_URL_LENGTH = 8192;

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const DEFAULT_ANITUBE_BIZ_REFERER = 'https://www.anitube.biz/';
export const LEGACY_MAXIMAIMG_REFERER = 'https://api.anivideo.net/';
const DEFAULT_COEMPREGOS_REFERER = 'https://www.coempregos.com.br/';
const EXTM3U_BYTES = [0x23, 0x45, 0x58, 0x54, 0x4d, 0x33, 0x55] as const; // "#EXTM3U"
const MAX_PEEK_BYTES = 512;

export function isMywallpaperHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  return lower === 'mywallpaper-4k-image.net' || lower.endsWith('.mywallpaper-4k-image.net');
}

export function resolveUpstreamReferer(
  targetUrl: URL,
  refererMapJson = process.env.PLAYER_REFERER_MAP,
  maximaimgReferer = process.env.PLAYER_MAXIMAIMG_REFERER
): string {
  const hostname = targetUrl.hostname.toLowerCase();

  const rules = new Map<string, string>([
    ['maximaimg.online', maximaimgReferer?.trim() || DEFAULT_ANITUBE_BIZ_REFERER],
    ['mywallpaper-4k-image.net', DEFAULT_ANITUBE_BIZ_REFERER],
    ['public.blob.vercel-storage.com', ''],
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

export function resolveUpstreamRefererCandidates(
  targetUrl: URL,
  refererMapJson = process.env.PLAYER_REFERER_MAP,
  maximaimgReferer = process.env.PLAYER_MAXIMAIMG_REFERER,
  customReferer?: string | null
): string[] {
  const candidates: string[] = [];
  const pushUnique = (value: string) => {
    if (!candidates.includes(value)) {
      candidates.push(value);
    }
  };

  if (customReferer && customReferer.trim()) {
    const check = validateHttpUrl(customReferer);
    if (check.valid && check.normalizedUrl) {
      pushUnique(check.normalizedUrl);
    }
  }

  const primary = resolveUpstreamReferer(targetUrl, refererMapJson, maximaimgReferer);
  pushUnique(primary);

  const hostname = targetUrl.hostname.toLowerCase();
  const hostOrigin = `${targetUrl.origin}/`;

  if (isMaximaimgHost(hostname)) {
    pushUnique(DEFAULT_ANITUBE_BIZ_REFERER);
    pushUnique(LEGACY_MAXIMAIMG_REFERER);
    pushUnique(hostOrigin);
    pushUnique('');
    return candidates;
  }

  if (isMywallpaperHost(hostname)) {
    pushUnique(DEFAULT_ANITUBE_BIZ_REFERER);
    pushUnique('');
    pushUnique(hostOrigin);
    return candidates;
  }

  pushUnique(hostOrigin);
  pushUnique('');
  return candidates;
}

export function getUpstreamHeaders(
  targetUrl: URL,
  incomingRequest: Request,
  customReferer?: string | null
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
  };

  let referer = resolveUpstreamReferer(targetUrl);
  if (customReferer && customReferer.trim()) {
    const check = validateHttpUrl(customReferer);
    if (check.valid && check.normalizedUrl) {
      referer = check.normalizedUrl;
    }
  }
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

export function shouldInspectForHlsManifest(
  contentType: string,
  targetUrl: URL,
  fromPlaylist = false
): boolean {
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
    lowerPath.endsWith('.m4v') ||
    lowerPath.endsWith('.webm') ||
    lowerPath.endsWith('.aac') ||
    lowerPath.endsWith('.mp3') ||
    lowerPath.endsWith('.vtt') ||
    lowerPath.endsWith('.srt') ||
    lowerPath.endsWith('.png') ||
    lowerPath.endsWith('.jpg') ||
    lowerPath.endsWith('.jpeg') ||
    lowerPath.endsWith('.gif') ||
    lowerPath.endsWith('.key')
  ) {
    return false;
  }
  if (
    lowerCt.includes('text/') ||
    lowerPath.endsWith('.m3u8') ||
    lowerPath.endsWith('.m3u')
  ) {
    return true;
  }
  return fromPlaylist;
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
  const isExpirable = Boolean(targetUrl && hasExpirableHlsTokens(targetUrl.toString()));
  const cacheControl = isExpirable
    ? 'public, max-age=30, must-revalidate'
    : 'public, max-age=31536000, immutable';
  outHeaders.set('Cache-Control', cacheControl);
  outHeaders.set('CDN-Cache-Control', cacheControl);
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

function buildManifestResponseHeaders(isExpirable = false): Headers {
  const outHeaders = new Headers();
  outHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  outHeaders.set('Cache-Control', 'public, max-age=5, stale-while-revalidate=30');
  outHeaders.set('CDN-Cache-Control', 'public, max-age=5, stale-while-revalidate=30');
  outHeaders.set('Access-Control-Allow-Origin', '*');
  if (isExpirable) {
    outHeaders.set('X-Hikari-Source-Expirable', '1');
    outHeaders.set('Access-Control-Expose-Headers', 'X-Hikari-Source-Expirable');
  }
  return outHeaders;
}

function buildProxyErrorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function looksLikeBinaryMediaPrefix(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  // MPEG-TS sync byte (0x47)
  if (bytes[0] === 0x47) return true;
  // NUL byte indicates binary payload (e.g. fMP4 / MP4 / AES key)
  for (let i = 0; i < Math.min(bytes.length, 64); i++) {
    if (bytes[i] === 0x00) return true;
  }
  return false;
}

function isInvalidHtmlManifestResponse(
  bytes: Uint8Array,
  contentType: string,
  targetUrl: URL
): boolean {
  if (looksLikeBinaryMediaPrefix(bytes)) {
    return false;
  }

  const lowerCt = contentType.toLowerCase();
  const lowerPath = targetUrl.pathname.toLowerCase();
  const isManifestTarget =
    lowerPath.endsWith('.m3u8') ||
    lowerPath.endsWith('.m3u') ||
    lowerCt.includes('mpegurl') ||
    lowerCt.includes('m3u8');

  if (lowerCt.includes('text/html') || lowerCt.includes('application/xhtml')) {
    return true;
  }

  if (!isManifestTarget) {
    return false;
  }

  const headText = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, 256))
    .trimStart()
    .toLowerCase();

  return (
    headText.startsWith('<!doctype') ||
    headText.startsWith('<html') ||
    headText.startsWith('<head') ||
    headText.startsWith('<body') ||
    headText.startsWith('<?xml')
  );
}

async function handleInspectedUpstreamResponse(
  upstream: Response,
  finalUrl: string,
  contentType: string,
  depth: number,
  sourceTargetUrl: string
): Promise<Response> {
  const finalParsed = new URL(finalUrl);
  if (!upstream.body) {
    const rawBytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytesStartWithExtM3u(rawBytes)) {
      if (depth > MAX_HLS_REWRITE_DEPTH) {
        return buildProxyErrorResponse(
          `Profundidade máxima de playlist HLS (${MAX_HLS_REWRITE_DEPTH}) excedida.`,
          502
        );
      }
      const text = new TextDecoder('utf-8').decode(rawBytes);
      const isExpirable =
        hasExpirableHlsTokens(sourceTargetUrl) ||
        hasExpirableHlsTokens(finalUrl) ||
        hasExpirableHlsTokens(text);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const nextDepth = depth + 1;
      const rewritten = rewriteM3u8Playlist(text, finalUrl, (resolved) =>
        buildSignedProxyPath(resolved, undefined, nowSeconds, nextDepth)
      );
      return new Response(rewritten, {
        status: 200,
        headers: buildManifestResponseHeaders(isExpirable),
      });
    }

    if (isInvalidHtmlManifestResponse(rawBytes, contentType, finalParsed)) {
      return buildProxyErrorResponse(
        'Origem retornou página HTML em vez de manifesto HLS válido.',
        502
      );
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
    if (depth > MAX_HLS_REWRITE_DEPTH) {
      try {
        await reader.cancel();
      } catch {
        // Ignorar erro ao cancelar leitura excedente
      }
      return buildProxyErrorResponse(
        `Profundidade máxima de playlist HLS (${MAX_HLS_REWRITE_DEPTH}) excedida.`,
        502
      );
    }
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
    const isExpirable =
      hasExpirableHlsTokens(sourceTargetUrl) ||
      hasExpirableHlsTokens(finalUrl) ||
      hasExpirableHlsTokens(text);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const nextDepth = depth + 1;
    const rewritten = rewriteM3u8Playlist(text, finalUrl, (resolved) =>
      buildSignedProxyPath(resolved, undefined, nowSeconds, nextDepth)
    );
    return new Response(rewritten, {
      status: 200,
      headers: buildManifestResponseHeaders(isExpirable),
    });
  }

  if (isInvalidHtmlManifestResponse(initialBytes, contentType, finalParsed)) {
    try {
      await reader.cancel();
    } catch {
      // Ignorar erro ao cancelar leitura HTML inválida
    }
    return buildProxyErrorResponse(
      'Origem retornou página HTML em vez de manifesto HLS válido.',
      502
    );
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

async function cancelResponseBodySafely(res: Response): Promise<void> {
  if (!res.body) return;
  try {
    await res.body.cancel();
  } catch {
    // Ignorar erro ao descartar corpo de resposta anterior
  }
}

async function fetchWith403RefererFallback(
  targetUrl: URL,
  incomingRequest: Request,
  fetchWithRedirects: typeof safeFetchWithRedirects,
  customReferer?: string | null
): Promise<{ response: Response; finalUrl: string }> {
  const baseHeaders = getUpstreamHeaders(targetUrl, incomingRequest, customReferer);
  const refererCandidates = resolveUpstreamRefererCandidates(
    targetUrl,
    undefined,
    undefined,
    customReferer
  );

  let lastResult: { response: Response; finalUrl: string } | null = null;

  for (let i = 0; i < refererCandidates.length; i++) {
    const candidateRef = refererCandidates[i];
    const headers: Record<string, string> = { ...baseHeaders };
    if (candidateRef) {
      headers['Referer'] = candidateRef;
    } else {
      delete headers['Referer'];
    }

    if (lastResult) {
      await cancelResponseBodySafely(lastResult.response);
    }

    lastResult = await fetchWithRedirects(targetUrl.toString(), {
      headers,
      timeoutMs: 30000,
    });

    if (lastResult.response.status !== 403) {
      return lastResult;
    }
  }

  return lastResult!;
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
  const depthParam = reqUrl.searchParams.get('d');
  const depthSigParam = reqUrl.searchParams.get('dsig');
  const refParam = reqUrl.searchParams.get('ref');
  const refSigParam = reqUrl.searchParams.get('rsig');

  const urlCheck = validateHttpUrl(rawTarget, MAX_PROXY_URL_LENGTH);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    return buildProxyErrorResponse('Parâmetro de URL inválido.', 400);
  }

  if (!verifyProxySignature(urlCheck.normalizedUrl, exp, sig)) {
    return buildProxyErrorResponse('Assinatura de proxy inválida ou expirada.', 403);
  }

  const depthCheck = verifyProxyDepth(
    urlCheck.normalizedUrl,
    exp,
    depthParam,
    depthSigParam
  );
  if (!depthCheck.valid) {
    return buildProxyErrorResponse('Assinatura de profundidade do proxy inválida.', 403);
  }

  const refCheck = verifyProxyReferer(
    urlCheck.normalizedUrl,
    exp,
    refParam,
    refSigParam
  );
  if (!refCheck.valid) {
    return buildProxyErrorResponse('Assinatura de Referer do proxy inválida.', 403);
  }

  try {
    const targetUrl = new URL(urlCheck.normalizedUrl);
    if (
      !depthCheck.fromPlaylist &&
      !isDirectMediaHost(targetUrl.hostname) &&
      !isAllowedProxyMediaUrl(targetUrl)
    ) {
      return buildProxyErrorResponse('Extensão de destino não permitida no proxy.', 403);
    }

    const { response: upstream, finalUrl } = await fetchWith403RefererFallback(
      targetUrl,
      request,
      fetchWithRedirects,
      refCheck.referer
    );

    if (!upstream.ok && upstream.status !== 206) {
      return buildProxyErrorResponse(
        `Origem retornou erro HTTP ${upstream.status}.`,
        upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502
      );
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const finalParsed = new URL(finalUrl);
    if (
      !depthCheck.fromPlaylist &&
      !isDirectMediaHost(finalParsed.hostname) &&
      !isAllowedProxyMediaUrl(finalParsed)
    ) {
      return buildProxyErrorResponse('Extensão de destino não permitida no proxy.', 403);
    }

    if (
      upstream.status !== 206 &&
      shouldInspectForHlsManifest(contentType, finalParsed, depthCheck.fromPlaylist)
    ) {
      return await handleInspectedUpstreamResponse(
        upstream,
        finalUrl,
        contentType,
        depthCheck.depth,
        targetUrl.toString()
      );
    }

    const outHeaders = buildBinaryResponseHeaders(upstream, contentType, finalParsed);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Falha ao processar stream via proxy.';
    return buildProxyErrorResponse(message, 502);
  }
}
