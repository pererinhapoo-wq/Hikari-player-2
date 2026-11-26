import {
  type ExplicitSourceKind,
  hasExpirableHlsTokens,
  hasR2SignedQueryParams,
  isEmbedAllowedFinalHost,
  isR2StorageHost,
  validateHttpUrl,
} from '@/lib/video-sources';

export const KNOWN_PREFIXES = ['apphd', 'appsd', 'appdub', 'appleg', 'appduble', 'appfull'] as const;
export const PLAYERRICAS_ENDPOINT = 'https://anitube22.vip/playerricas.php';
export const R2_RESOLUTION_TIMEOUT_MS = 8000;
export const R2_RESOLUTION_MAX_REDIRECTS = 3;
export const R2_RESOLUTION_MAX_BODY_BYTES = 262_144;

const TRUSTED_MEDIA_RESOLUTION_HOSTS = ['maximaimg.online', 'mywallpaper-4k-image.net'] as const;

const r2PrefixCache = new Map<string, string>();

export function isR2SignedUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const isR2Host = host.includes('r2.cloudflarestorage.com') || host.endsWith('.r2.cloudflarestorage.com');
    if (!isR2Host) return false;

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

export function cleanR2SignedUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    const paramsToDelete: string[] = [];
    for (const key of parsed.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (lower.startsWith('x-amz-') || lower.startsWith('response-')) {
        paramsToDelete.push(key);
      }
    }
    for (const k of paramsToDelete) {
      parsed.searchParams.delete(k);
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function extractFilenameFromPath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

export function extractPrefixFromPlayerricasName(nameParam: string | null): string | null {
  if (!nameParam) return null;
  const trimmed = nameParam.trim();
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx === -1) return null;
  const prefix = trimmed.slice(0, slashIdx).toLowerCase();
  return KNOWN_PREFIXES.includes(prefix as any) ? prefix : null;
}

export function extractPlayerricasIframeFromHtml(html: string): string | null {
  const iframeRegex = /<iframe\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = iframeRegex.exec(html)) !== null) {
    const rawSrc = (match[1] ?? match[2] ?? match[3] ?? '').replace(/&amp;/g, '&').trim();
    if (!rawSrc) continue;
    if (rawSrc.toLowerCase().includes('playerricas.php')) {
      return rawSrc;
    }
  }
  return null;
}

export async function confirmPlayerricasPrefixUrl(
  playerricasUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ confirmed: boolean; prefix: string | null }> {
  let prefix: string | null = null;
  try {
    const parsed = new URL(playerricasUrl);
    prefix = extractPrefixFromPlayerricasName(parsed.searchParams.get('name'));
  } catch {
    return { confirmed: false, prefix: null };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetchImpl(playerricasUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.status !== 200) {
      return { confirmed: false, prefix: null };
    }

    const text = await res.text();
    const lowerText = text.toLowerCase();
    const hasDeleted = lowerText.includes('deleted') || lowerText.includes('not found');
    const hasPlayerOrM3u = lowerText.includes('player') || lowerText.includes('extm3u');
    if (text.trim().length > 0 && !hasDeleted && hasPlayerOrM3u) {
      return { confirmed: true, prefix };
    }
  } catch {
    // Non-200, timeout, or network failure: never approve prefix
  }

  return { confirmed: false, prefix: null };
}

export async function resolvePrefixFromEpisodePage(
  episodePageUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ playerricasUrl: string | null; prefix: string | null; isConfirmed: boolean }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const res = await fetchImpl(episodePageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.status !== 200) {
      return { playerricasUrl: null, prefix: null, isConfirmed: false };
    }

    const html = await res.text();
    const iframeSrc = extractPlayerricasIframeFromHtml(html);
    if (!iframeSrc) {
      return { playerricasUrl: null, prefix: null, isConfirmed: false };
    }

    const resolvedIframeUrl = new URL(iframeSrc, episodePageUrl).toString();
    const confirmation = await confirmPlayerricasPrefixUrl(resolvedIframeUrl, fetchImpl);
    if (!confirmation.confirmed) {
      return { playerricasUrl: null, prefix: null, isConfirmed: false };
    }

    return {
      playerricasUrl: resolvedIframeUrl,
      prefix: confirmation.prefix,
      isConfirmed: true,
    };
  } catch {
    return { playerricasUrl: null, prefix: null, isConfirmed: false };
  }
}

export interface R2ResolutionResult {
  finalUrl: string;
  prefix: string | null;
  isAttempt: boolean;
  isConfirmed: boolean;
  cleanR2Url?: string;
}

export async function resolveVideoInputUrl(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<R2ResolutionResult> {
  let trimmed = rawUrl.trim();
  if (!trimmed) {
    return { finalUrl: trimmed, prefix: null, isAttempt: false, isConfirmed: true };
  }

  if (trimmed.toLowerCase().includes('<iframe')) {
    const extracted = extractPlayerricasIframeFromHtml(trimmed);
    if (extracted) {
      trimmed = extracted;
    }
  }

  // 4) Se o texto colado for a URL do playerricas.php, usar o parse direto, sem tentativa
  if (trimmed.toLowerCase().includes('playerricas.php')) {
    let prefix: string | null = null;
    let isConfirmed = !trimmed.includes('unconfirmed=1');
    try {
      const parsed = new URL(trimmed);
      if (parsed.searchParams.get('unconfirmed') === '1') {
        isConfirmed = false;
      } else {
        const nameParam = parsed.searchParams.get('name');
        prefix = extractPrefixFromPlayerricasName(nameParam);
      }
    } catch {
      // ignore
    }
    return { finalUrl: trimmed, prefix: isConfirmed ? prefix : null, isAttempt: false, isConfirmed };
  }

  // 1) Cadastro por URL assinada do R2
  if (isR2SignedUrl(trimmed)) {
    const cleanUrl = cleanR2SignedUrl(trimmed);
    let r2Host = '';
    let filename = '';
    try {
      const parsedClean = new URL(cleanUrl);
      r2Host = parsedClean.hostname.toLowerCase();
      filename = extractFilenameFromPath(parsedClean.pathname);
    } catch {
      throw new Error('URL assinada do R2 inválida.');
    }

    if (!filename) {
      throw new Error('Nome do arquivo não encontrado na URL do R2.');
    }

    const cachedPrefix = r2PrefixCache.get(r2Host);
    const candidates: string[] = [];
    if (cachedPrefix && KNOWN_PREFIXES.includes(cachedPrefix as any)) {
      candidates.push(cachedPrefix);
    }
    for (const p of KNOWN_PREFIXES) {
      if (!candidates.includes(p)) {
        candidates.push(p);
      }
    }

    let winningPrefix: string | null = null;
    let winningPlayerricasUrl = '';
    let isConfirmed = false;
    let attemptsCount = 0;

    // 1) A tentativa só aprova com HTTP 200 e corpo contendo "player" ou "EXTM3U".
    // 403, 401, 429 e timeout não aprovam nem reprovam — a tentativa é descartada e passa para o próximo prefixo.
    for (const prefix of candidates) {
      if (attemptsCount >= 6) break;
      attemptsCount++;

      const candidateName = `${prefix}/${filename}`;
      const candidatePlayerricasUrl = `https://anitube22.vip/playerricas.php?name=${encodeURIComponent(candidateName)}&url=${encodeURIComponent(cleanUrl)}`;

      const check = await confirmPlayerricasPrefixUrl(candidatePlayerricasUrl, fetchImpl);
      if (check.confirmed) {
        winningPrefix = prefix;
        winningPlayerricasUrl = candidatePlayerricasUrl;
        isConfirmed = true;
        r2PrefixCache.set(r2Host, prefix);
        break;
      }
    }

    // 2) Nunca aprovar prefixo (como "apphd") quando a resposta não for 200.
    // Sem confirmação 200, retorna apenas a URL limpa do R2 com prefix: null e isConfirmed: false.
    if (!winningPrefix || !winningPlayerricasUrl) {
      return {
        finalUrl: cleanUrl,
        prefix: null,
        isAttempt: true,
        isConfirmed: false,
        cleanR2Url: cleanUrl,
      };
    }

    return {
      finalUrl: winningPlayerricasUrl,
      prefix: winningPrefix,
      isAttempt: true,
      isConfirmed,
      cleanR2Url: cleanUrl,
    };
  }

  const check = validateHttpUrl(trimmed);
  if (!check.valid || !check.normalizedUrl) {
    throw new Error(check.error ?? 'URL inválida.');
  }

  return { finalUrl: check.normalizedUrl, prefix: null, isAttempt: false, isConfirmed: true };
}

export interface R2PrefixAttemptDiagnostic {
  prefix: string;
  candidateName: string;
  status: number | null;
  valid: boolean;
  reason: string;
}

export interface OriginalR2UrlCheck {
  checked: boolean;
  accessible: boolean | null;
  status: number | null;
  message: string | null;
}

export interface ControlledR2ResolutionResult {
  ok: boolean;
  found: boolean;
  originalUrl: string;
  isR2: boolean;
  hasAuthParams: boolean;
  originalUrlStatus: OriginalR2UrlCheck;
  matchedPrefix: string | null;
  resolvedUrl: string | null;
  detectedKind: ExplicitSourceKind | null;
  validationDetail: string | null;
  attempts: R2PrefixAttemptDiagnostic[];
  message: string;
}

export interface ControlledR2ResolutionDeps {
  fetchImpl?: typeof fetch;
  assertSafeUrl?: (rawUrl: string) => Promise<URL>;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
  checkOriginalUrl?: boolean;
}

const LOCAL_OR_INTERNAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
]);

function isPrivateOrLoopbackIpv4Literal(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isDisallowedHostLiteral(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!clean) return true;
  if (
    LOCAL_OR_INTERNAL_HOSTNAMES.has(clean) ||
    clean.endsWith('.localhost') ||
    clean.endsWith('.local') ||
    clean.endsWith('.internal')
  ) {
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(clean)) {
    return isPrivateOrLoopbackIpv4Literal(clean);
  }
  if (clean.includes(':')) {
    if (clean === '::' || clean === '::1') return true;
    if (clean.startsWith('fc') || clean.startsWith('fd')) return true;
    if (/^fe[89ab]/i.test(clean)) return true;
    if (clean.startsWith('ff')) return true;
    if (clean.startsWith('::ffff:')) {
      const v4 = clean.slice('::ffff:'.length);
      return isPrivateOrLoopbackIpv4Literal(v4);
    }
  }
  return false;
}

export function isAllowedR2ResolutionHost(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (!clean || isDisallowedHostLiteral(clean)) return false;
  if (isEmbedAllowedFinalHost(clean)) return true;
  return TRUSTED_MEDIA_RESOLUTION_HOSTS.some(
    (allowed) => clean === allowed || clean.endsWith(`.${allowed}`)
  );
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/([?&](?:x-amz-[a-z0-9-]+|response-[a-z0-9-]+|token|sig|signature|auth|hmac|hdnea|hdnts)=)[^&#\s]+/gi, '$1[redigido]')
    .slice(0, 220);
}

async function cancelBodySafely(res: Response): Promise<void> {
  try {
    if (res.body && !res.bodyUsed) {
      await res.body.cancel();
    }
  } catch {
    // Ignore cancel errors
  }
}

async function readBoundedResponseText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          const allowed = value.byteLength - (total - maxBytes);
          if (allowed > 0) {
            chunks.push(decoder.decode(value.subarray(0, allowed), { stream: true }));
          }
          await reader.cancel();
          break;
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore lock errors
    }
  }
}

async function assertSafeTargetUrl(
  rawUrl: string,
  options: { requireAllowedResolutionHost: boolean; assertSafeUrl?: (raw: string) => Promise<URL> }
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('URL inválida na tentativa de resolução.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Esquema de URL não permitido (${parsed.protocol.replace(':', '')}).`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('Credenciais na URL não são permitidas.');
  }

  if (isDisallowedHostLiteral(parsed.hostname)) {
    throw new Error(`Destino interno ou IP reservado bloqueado (${parsed.hostname}).`);
  }

  if (options.requireAllowedResolutionHost && !isAllowedR2ResolutionHost(parsed.hostname)) {
    throw new Error(`Host não permitido na allowlist de resolução (${parsed.hostname}).`);
  }

  if (options.assertSafeUrl) {
    await options.assertSafeUrl(parsed.toString());
  }

  return parsed;
}

async function fetchWithSafeManualRedirects(
  initialUrl: string,
  options: {
    fetchImpl: typeof fetch;
    assertSafeUrl?: (raw: string) => Promise<URL>;
    timeoutMs: number;
    maxRedirects: number;
    requireAllowedResolutionHost: boolean;
    headers: Record<string, string>;
  }
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    const validatedUrl = await assertSafeTargetUrl(currentUrl, {
      requireAllowedResolutionHost: options.requireAllowedResolutionHost,
      assertSafeUrl: options.assertSafeUrl,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
      response = await options.fetchImpl(validatedUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: options.headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.url) {
      await assertSafeTargetUrl(response.url, {
        requireAllowedResolutionHost: options.requireAllowedResolutionHost,
        assertSafeUrl: options.assertSafeUrl,
      });
    }

    if (response.status >= 300 && response.status < 400) {
      await cancelBodySafely(response);
      const location = response.headers.get('location');
      if (!location) {
        throw new Error('Redirecionamento sem cabeçalho Location.');
      }
      if (hop === options.maxRedirects) {
        throw new Error('Número máximo de redirecionamentos excedido.');
      }
      currentUrl = new URL(location, validatedUrl).toString();
      continue;
    }

    return {
      response,
      finalUrl: response.url || validatedUrl.toString(),
    };
  }

  throw new Error('Falha ao seguir redirecionamentos.');
}

function extractEmbeddedResourceUrls(html: string): string[] {
  const urls: string[] = [];
  const patterns = [
    /<(?:video|source|iframe)\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi,
    /(?:file|src)\s*:\s*(?:"([^"]+)"|'([^']+)')/gi,
    /(https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|webm)(?:[?#][^\s"'<>\\]*)?)/gi,
  ];

  for (const regex of patterns) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(html)) !== null) {
      const candidate = (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&').trim();
      if (candidate && !urls.includes(candidate)) {
        urls.push(candidate);
      }
    }
  }
  return urls;
}

export async function validatePlayerricasResolvedResponse(params: {
  finalUrl: string;
  status: number;
  contentType: string | null;
  bodyText: string;
  assertSafeUrl?: (raw: string) => Promise<URL>;
}): Promise<{
  valid: boolean;
  detectedKind: ExplicitSourceKind | null;
  reason: string;
}> {
  if (params.status !== 200) {
    return {
      valid: false,
      detectedKind: null,
      reason: `HTTP ${params.status}`,
    };
  }

  let parsedFinal: URL;
  try {
    parsedFinal = await assertSafeTargetUrl(params.finalUrl, {
      requireAllowedResolutionHost: true,
      assertSafeUrl: params.assertSafeUrl,
    });
  } catch (err) {
    return {
      valid: false,
      detectedKind: null,
      reason: err instanceof Error ? err.message : 'Destino final não permitido.',
    };
  }

  const mime = (params.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const body = params.bodyText;
  const trimmed = body.trim();

  if (mime.startsWith('video/')) {
    return {
      valid: true,
      detectedKind: 'mp4',
      reason: `Stream de vídeo direto validado (${mime}).`,
    };
  }

  if (!trimmed) {
    return {
      valid: false,
      detectedKind: null,
      reason: 'HTTP 200 com resposta vazia.',
    };
  }

  const lower = trimmed.toLowerCase();

  if (
    lower.includes('why have i been blocked') ||
    lower.includes('attention required! | cloudflare') ||
    lower.includes('cf-challenge') ||
    lower.includes('just a moment...') ||
    lower.includes('enable javascript and cookies to continue')
  ) {
    return {
      valid: false,
      detectedKind: null,
      reason: 'HTTP 200 bloqueado por proteção anti-bot/Cloudflare.',
    };
  }

  if (
    /\b(deleted|file was deleted|not found|404 not found|video unavailable|no longer available|arquivo removido|v[ií]deo indispon[ií]vel|removido|expired|expirado)\b/i.test(
      lower
    )
  ) {
    return {
      valid: false,
      detectedKind: null,
      reason: 'HTTP 200 indica vídeo removido, expirado ou não encontrado.',
    };
  }

  const looksHtml =
    mime === 'text/html' ||
    mime === 'application/xhtml+xml' ||
    /^<(?:!doctype|html|head|body|div|script|iframe|video)\b/i.test(trimmed);

  // Caso 1: Playlist HLS válida (#EXTM3U com diretivas HLS reais)
  if (!looksHtml && /^#EXTM3U\b/i.test(trimmed)) {
    const hasHlsTags =
      /#EXT-X-TARGETDURATION:|#EXT-X-STREAM-INF:|#EXTINF:/i.test(trimmed) ||
      /\.(?:ts|m4s|m3u8|webp|mp4)(?:[?#\s]|$)/im.test(trimmed);
    if (!hasHlsTags) {
      return {
        valid: false,
        detectedKind: null,
        reason: 'HTTP 200 com cabeçalho #EXTM3U sem segmentos ou variantes válidas.',
      };
    }
    return {
      valid: true,
      detectedKind: 'hls',
      reason: 'Playlist HLS (#EXTM3U) validada.',
    };
  }

  // Caso 2: Página do playerricas.php / embed HTML precisa evidência concreta de player + mídia utilizável
  const embeddedUrls = extractEmbeddedResourceUrls(trimmed);
  for (const rawEmbedded of embeddedUrls) {
    if (/^(?:javascript|data|vbscript|file):/i.test(rawEmbedded)) {
      return {
        valid: false,
        detectedKind: null,
        reason: `Player retornou URL com esquema inseguro (${rawEmbedded.split(':')[0]}:).`,
      };
    }
    if (/^https?:\/\//i.test(rawEmbedded)) {
      try {
        await assertSafeTargetUrl(rawEmbedded, {
          requireAllowedResolutionHost: false,
          assertSafeUrl: params.assertSafeUrl,
        });
      } catch (err) {
        return {
          valid: false,
          detectedKind: null,
          reason:
            err instanceof Error
              ? `Mídia embutida inválida: ${err.message}`
              : 'Mídia embutida com host não permitido.',
        };
      }
    }
  }

  const hasVideoOrSourceTag =
    /<(?:video|source)\b[^>]*\bsrc\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(trimmed);
  const hasPlayableMediaRef = embeddedUrls.some((item) =>
    /\.(?:m3u8|mp4|webm|php)(?:[?#]|$)/i.test(item)
  );
  const hasPlayerSetup =
    /(?:jwplayer\s*\(|new\s+plyr\b|videojs\s*\(|new\s+hls\b|clappr\.player|dplayer|artplayer|player\.setup\s*\()/i.test(
      trimmed
    );
  const hasIframePlayer =
    /<iframe\b[^>]*\bsrc\s*=\s*(?:"https?:\/\/|'https?:\/\/)/i.test(trimmed) &&
    embeddedUrls.some((u) => /^https?:\/\//i.test(u));

  const validPlayerEvidence =
    hasVideoOrSourceTag ||
    hasIframePlayer ||
    (hasPlayerSetup &&
      (hasPlayableMediaRef || /(?:sources?\s*:|file\s*:|application\/x-mpegurl|video\/mp4)/i.test(trimmed))) ||
    (hasPlayableMediaRef && /(?:player|jwplayer|plyr|videojs|<video|<source|sources?\s*:|file\s*:)/i.test(trimmed));

  if (!validPlayerEvidence) {
    return {
      valid: false,
      detectedKind: null,
      reason: 'HTTP 200 sem player ou mídia reproduzível confirmada.',
    };
  }

  const isPhpOrHtmlEmbed =
    parsedFinal.pathname.toLowerCase().endsWith('.php') || looksHtml || mime === 'text/html';

  return {
    valid: true,
    detectedKind: isPhpOrHtmlEmbed ? 'iframe' : 'mp4',
    reason: 'Conteúdo do player validado com referência de mídia utilizável.',
  };
}

async function probeOriginalSignedR2Url(
  originalUrl: string,
  options: {
    fetchImpl: typeof fetch;
    assertSafeUrl?: (raw: string) => Promise<URL>;
    timeoutMs: number;
    maxRedirects: number;
  }
): Promise<OriginalR2UrlCheck> {
  try {
    const { response } = await fetchWithSafeManualRedirects(originalUrl, {
      fetchImpl: options.fetchImpl,
      assertSafeUrl: options.assertSafeUrl,
      timeoutMs: Math.min(options.timeoutMs, 6000),
      maxRedirects: options.maxRedirects,
      requireAllowedResolutionHost: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Range: 'bytes=0-0',
      },
    });
    await cancelBodySafely(response);
    const accessible = response.status === 200 || response.status === 206;
    return {
      checked: true,
      accessible,
      status: response.status,
      message: accessible
        ? `URL original ainda responde HTTP ${response.status} com os parâmetros atuais intactos.`
        : `URL original retornou HTTP ${response.status} (parâmetros originais preservados).`,
    };
  } catch (err) {
    return {
      checked: true,
      accessible: false,
      status: null,
      message: `Não foi possível validar a URL original (${sanitizeDiagnosticText(
        err instanceof Error ? err.message : 'erro de rede'
      )}). URL original preservada.`,
    };
  }
}

export async function attemptControlledR2Resolution(
  rawUrl: string,
  deps: ControlledR2ResolutionDeps = {}
): Promise<ControlledR2ResolutionResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? R2_RESOLUTION_TIMEOUT_MS;
  const maxRedirects = deps.maxRedirects ?? R2_RESOLUTION_MAX_REDIRECTS;
  const maxBodyBytes = deps.maxBodyBytes ?? R2_RESOLUTION_MAX_BODY_BYTES;
  const trimmed = rawUrl.trim();

  const emptyOriginalCheck: OriginalR2UrlCheck = {
    checked: false,
    accessible: null,
    status: null,
    message: null,
  };

  if (!trimmed) {
    return {
      ok: false,
      found: false,
      originalUrl: trimmed,
      isR2: false,
      hasAuthParams: false,
      originalUrlStatus: emptyOriginalCheck,
      matchedPrefix: null,
      resolvedUrl: null,
      detectedKind: null,
      validationDetail: null,
      attempts: [],
      message: 'Informe uma URL do Cloudflare R2 para tentar resolver.',
    };
  }

  let parsedInput: URL;
  try {
    parsedInput = await assertSafeTargetUrl(trimmed, {
      requireAllowedResolutionHost: false,
      assertSafeUrl: deps.assertSafeUrl,
    });
  } catch (err) {
    return {
      ok: false,
      found: false,
      originalUrl: trimmed,
      isR2: false,
      hasAuthParams: false,
      originalUrlStatus: emptyOriginalCheck,
      matchedPrefix: null,
      resolvedUrl: null,
      detectedKind: null,
      validationDetail: null,
      attempts: [],
      message: sanitizeDiagnosticText(
        err instanceof Error ? err.message : 'URL inválida ou bloqueada por segurança.'
      ),
    };
  }

  if (!isR2StorageHost(parsedInput.hostname)) {
    return {
      ok: false,
      found: false,
      originalUrl: trimmed,
      isR2: false,
      hasAuthParams: false,
      originalUrlStatus: emptyOriginalCheck,
      matchedPrefix: null,
      resolvedUrl: null,
      detectedKind: null,
      validationDetail: null,
      attempts: [],
      message: 'A resolução via playerricas.php aplica-se apenas a URLs *.r2.cloudflarestorage.com.',
    };
  }

  const hasAuthParams = hasR2SignedQueryParams(trimmed) || hasExpirableHlsTokens(trimmed);
  const filename = extractFilenameFromPath(parsedInput.pathname);
  if (!filename) {
    return {
      ok: false,
      found: false,
      originalUrl: trimmed,
      isR2: true,
      hasAuthParams,
      originalUrlStatus: emptyOriginalCheck,
      matchedPrefix: null,
      resolvedUrl: null,
      detectedKind: null,
      validationDetail: null,
      attempts: [],
      message: 'Não foi possível identificar o nome do arquivo no caminho da URL R2.',
    };
  }

  const originalUrlStatus =
    hasAuthParams && deps.checkOriginalUrl !== false
      ? await probeOriginalSignedR2Url(trimmed, {
          fetchImpl,
          assertSafeUrl: deps.assertSafeUrl,
          timeoutMs,
          maxRedirects,
        })
      : emptyOriginalCheck;

  // Constrói apenas o parâmetro url= limpo para consulta externa, mantendo originalUrl intocada
  const lookupBaseUrl = cleanR2SignedUrl(trimmed);
  const attempts: R2PrefixAttemptDiagnostic[] = [];

  for (const prefix of KNOWN_PREFIXES) {
    if (attempts.length >= KNOWN_PREFIXES.length) break;
    const candidateName = `${prefix}/${filename}`;
    const candidatePlayerricasUrl = `${PLAYERRICAS_ENDPOINT}?name=${encodeURIComponent(
      candidateName
    )}&url=${encodeURIComponent(lookupBaseUrl)}`;

    try {
      const { response, finalUrl } = await fetchWithSafeManualRedirects(candidatePlayerricasUrl, {
        fetchImpl,
        assertSafeUrl: deps.assertSafeUrl,
        timeoutMs,
        maxRedirects,
        requireAllowedResolutionHost: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/html,application/xhtml+xml,application/vnd.apple.mpegurl,*/*;q=0.8',
        },
      });

      if (response.status !== 200) {
        await cancelBodySafely(response);
        attempts.push({
          prefix,
          candidateName,
          status: response.status,
          valid: false,
          reason: `HTTP ${response.status}`,
        });
        continue;
      }

      const contentType = response.headers.get('content-type');
      const bodyText = await readBoundedResponseText(response, maxBodyBytes);
      const validation = await validatePlayerricasResolvedResponse({
        finalUrl,
        status: response.status,
        contentType,
        bodyText,
        assertSafeUrl: deps.assertSafeUrl,
      });

      attempts.push({
        prefix,
        candidateName,
        status: response.status,
        valid: validation.valid,
        reason: sanitizeDiagnosticText(validation.reason),
      });

      if (validation.valid && validation.detectedKind) {
        const finalHttpCheck = validateHttpUrl(finalUrl);
        if (!finalHttpCheck.valid || !finalHttpCheck.normalizedUrl) {
          continue;
        }
        return {
          ok: true,
          found: true,
          originalUrl: trimmed,
          isR2: true,
          hasAuthParams,
          originalUrlStatus,
          matchedPrefix: prefix,
          resolvedUrl: finalHttpCheck.normalizedUrl,
          detectedKind: validation.detectedKind,
          validationDetail: sanitizeDiagnosticText(validation.reason),
          attempts,
          message: `Fonte válida encontrada via prefixo "${prefix}" (${validation.detectedKind}). Revise e confirme antes de aplicar.`,
        };
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      attempts.push({
        prefix,
        candidateName,
        status: null,
        valid: false,
        reason: isTimeout
          ? `Timeout após ${timeoutMs}ms`
          : sanitizeDiagnosticText(err instanceof Error ? err.message : 'Falha de rede.'),
      });
    }
  }

  return {
    ok: true,
    found: false,
    originalUrl: trimmed,
    isR2: true,
    hasAuthParams,
    originalUrlStatus,
    matchedPrefix: null,
    resolvedUrl: null,
    detectedKind: null,
    validationDetail: null,
    attempts,
    message:
      'Nenhuma fonte válida encontrada em playerricas.php nos 6 prefixos conhecidos. A URL original foi preservada.',
  };
}

export function applyResolvedR2Candidate(
  current: { video_url: string; source_kind: ExplicitSourceKind | '' },
  resolution: ControlledR2ResolutionResult | null,
  confirmed: boolean
): { applied: boolean; video_url: string; source_kind: ExplicitSourceKind | '' } {
  if (!confirmed || !resolution || !resolution.ok || !resolution.found || !resolution.resolvedUrl) {
    return {
      applied: false,
      video_url: current.video_url,
      source_kind: current.source_kind,
    };
  }
  return {
    applied: true,
    video_url: resolution.resolvedUrl,
    source_kind: resolution.detectedKind ?? current.source_kind,
  };
}

