import { assertSafeExternalUrl, safeFetchWithRedirects } from '@/lib/ssrf';
import {
  DEFAULT_ANITUBE_BIZ_REFERER,
  DEFAULT_COEMPREGOS_REFERER,
  LEGACY_MAXIMAIMG_REFERER,
  resolveUpstreamRefererCandidates,
} from '@/lib/stream-proxy';
import type {
  SiteImportAttemptDiagnostic,
  SiteImportCandidateDiagnostic,
  SiteImportCandidateType,
} from '@/lib/types';
import {
  hasExpirableHlsTokens,
  validateHttpUrl,
} from '@/lib/video-sources';

export const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

export const ALLOWED_SITE_IMPORT_HOSTS = [
  'anitube.biz',
  'anitube22.vip',
  'allappinc.com',
] as const;

const ANITUBE_TARGET_HOSTS = ['anitube.biz', 'anitube22.vip'] as const;

export interface ExtractedSiteCandidate {
  url: string;
  type: SiteImportCandidateType;
}

export interface SiteImportSuccess {
  ok: true;
  pageUrl: string;
  selected: {
    url: string;
    kind: 'hls' | 'mp4';
    forceProxy: true;
    hostReferer: string;
    candidateType: SiteImportCandidateType;
    isExpirable: boolean;
    expirableReason: string | null;
  };
  extractedTitle: string | null;
  extractedPoster: string | null;
  candidates: SiteImportCandidateDiagnostic[];
}

export interface SiteImportFailure {
  ok: false;
  error: string;
  candidates: SiteImportCandidateDiagnostic[];
}

export type SiteImportResult = SiteImportSuccess | SiteImportFailure;

export interface SiteImportDeps {
  fetchWithRedirects?: typeof safeFetchWithRedirects;
  assertSafeUrl?: typeof assertSafeExternalUrl;
  nowSeconds?: () => number;
}

export function isAllowedSiteImportHost(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (!clean) return false;
  return ALLOWED_SITE_IMPORT_HOSTS.some(
    (allowed) => clean === allowed || clean.endsWith(`.${allowed}`)
  );
}

export function isAllappincHost(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase().replace(/\.+$/, '');
  return clean === 'allappinc.com' || clean.endsWith('.allappinc.com');
}

export function isAnitubeHost(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase().replace(/\.+$/, '');
  return ANITUBE_TARGET_HOSTS.some(
    (allowed) => clean === allowed || clean.endsWith(`.${allowed}`)
  );
}

function applyRot13(input: string): string {
  return input.replace(/[a-zA-Z]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= 97 ? 97 : 65;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

export function decodeAllappincViewParam(rawView: string): string | null {
  const trimmed = rawView.trim();
  if (!trimmed) return null;

  const hex = applyRot13(trimmed);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  } catch {
    return null;
  }

  const check = validateHttpUrl(decoded);
  if (!check.valid || !check.normalizedUrl) {
    return null;
  }

  return check.normalizedUrl;
}

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\\\//g, '/');
}

function parseHtmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(tag)) !== null) {
    const key = match[1].toLowerCase();
    const val = decodeHtmlEntities((match[2] ?? match[3] ?? match[4] ?? '').trim());
    attrs[key] = val;
  }
  return attrs;
}

export function extractAllappincRedirectTarget(html: string, baseUrl: string): string | null {
  const tryResolve = (rawTarget: string | null | undefined): URL | null => {
    if (!rawTarget) return null;
    const cleaned = decodeHtmlEntities(rawTarget).trim();
    if (!cleaned) return null;
    try {
      const resolved = new URL(cleaned, baseUrl);
      const check = validateHttpUrl(resolved.toString());
      if (!check.valid || !check.normalizedUrl) return null;
      return new URL(check.normalizedUrl);
    } catch {
      return null;
    }
  };

  // 1) Meta refresh
  const metaRegex = /<meta\b[^>]*>/gi;
  let metaMatch: RegExpExecArray | null;
  while ((metaMatch = metaRegex.exec(html)) !== null) {
    const attrs = parseHtmlAttributes(metaMatch[0]);
    if ((attrs['http-equiv'] ?? '').toLowerCase() !== 'refresh') continue;
    const content = attrs.content ?? '';
    const urlMatch = /\burl\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))/i.exec(content);
    const rawTarget = urlMatch?.[1] ?? urlMatch?.[2] ?? urlMatch?.[3];
    const resolved = tryResolve(rawTarget);
    if (resolved) {
      return resolved.toString();
    }
  }

  // 2) JS location redirects pointing to anitube or allowed host
  const jsLocationRegex =
    /(?:window\.location(?:\.href)?|location\.href|location\.replace|location\.assign)\s*(?:=|\()\s*["']([^"']+)["']/gi;
  let jsMatch: RegExpExecArray | null;
  while ((jsMatch = jsLocationRegex.exec(html)) !== null) {
    const resolved = tryResolve(jsMatch[1]);
    if (resolved && isAllowedSiteImportHost(resolved.hostname)) {
      return resolved.toString();
    }
  }

  // 3) Anchor links pointing to anitube (prefer non-root episode paths over bare '/')
  const anchorRegex = /<a\b[^>]*>/gi;
  let anchorMatch: RegExpExecArray | null;
  let fallbackAnitubeLink: string | null = null;
  let fallbackAllappincViewLink: string | null = null;

  while ((anchorMatch = anchorRegex.exec(html)) !== null) {
    const attrs = parseHtmlAttributes(anchorMatch[0]);
    const resolved = tryResolve(attrs.href);
    if (!resolved) continue;

    if (isAnitubeHost(resolved.hostname)) {
      if (resolved.pathname !== '/' && resolved.pathname !== '') {
        return resolved.toString();
      }
      if (!fallbackAnitubeLink) {
        fallbackAnitubeLink = resolved.toString();
      }
    } else if (
      isAllappincHost(resolved.hostname) &&
      resolved.searchParams.has('view') &&
      !fallbackAllappincViewLink
    ) {
      fallbackAllappincViewLink = resolved.toString();
    }
  }

  if (fallbackAnitubeLink) {
    return fallbackAnitubeLink;
  }
  if (fallbackAllappincViewLink) {
    return fallbackAllappincViewLink;
  }

  // 4) Raw anitube URL anywhere in HTML/scripts
  const rawAnitubeRegex =
    /https?:\/\/(?:[a-z0-9-]+\.)?(?:anitube\.biz|anitube22\.vip)\/[^\s"'<>`\\)]+/gi;
  const rawMatch = rawAnitubeRegex.exec(decodeHtmlEntities(html));
  if (rawMatch?.[0]) {
    const resolved = tryResolve(rawMatch[0]);
    if (resolved) {
      return resolved.toString();
    }
  }

  return null;
}

export function assemblePlayerricasUrl(
  rawSrc: string,
  baseUrl: string,
  attrs: Record<string, string> = {},
  nowSeconds = Math.floor(Date.now() / 1000)
): string | null {
  try {
    const parsed = new URL(decodeHtmlEntities(rawSrc.trim()), baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    const nameVal = parsed.searchParams.get('name') ?? attrs['data-name'] ?? '';
    const imgVal = parsed.searchParams.get('img') ?? attrs['data-img'] ?? '';
    const paisVal = parsed.searchParams.get('pais') ?? attrs['data-pais'] ?? '';
    const timeVal = parsed.searchParams.get('time') ?? attrs['data-time'] ?? String(nowSeconds);
    const urlVal = parsed.searchParams.get('url') ?? attrs['data-url'] ?? '';

    const rebuilt = new URL(`${parsed.origin}${parsed.pathname}`);
    rebuilt.searchParams.set('name', nameVal);
    rebuilt.searchParams.set('img', imgVal);
    rebuilt.searchParams.set('pais', paisVal);
    rebuilt.searchParams.set('time', timeVal);
    rebuilt.searchParams.set('url', urlVal);

    for (const [key, value] of parsed.searchParams.entries()) {
      if (!['name', 'img', 'pais', 'time', 'url'].includes(key)) {
        rebuilt.searchParams.append(key, value);
      }
    }

    return rebuilt.toString();
  } catch {
    return null;
  }
}

export function extractPageMetadata(
  html: string,
  baseUrl: string
): { title: string | null; poster: string | null } {
  let title: string | null = null;
  let poster: string | null = null;

  const metaRegex = /<meta\b[^>]*>/gi;
  let metaMatch: RegExpExecArray | null;
  while ((metaMatch = metaRegex.exec(html)) !== null) {
    const attrs = parseHtmlAttributes(metaMatch[0]);
    const prop = (attrs.property ?? attrs.name ?? '').toLowerCase();
    const content = attrs.content?.trim() ?? '';
    if (!content) continue;
    if (!title && (prop === 'og:title' || prop === 'twitter:title')) {
      title = content;
    }
    if (!poster && (prop === 'og:image' || prop === 'twitter:image')) {
      try {
        const resolvedPoster = new URL(content, baseUrl).toString();
        const check = validateHttpUrl(resolvedPoster);
        if (check.valid && check.normalizedUrl) {
          poster = check.normalizedUrl;
        }
      } catch {
        // Ignora imagem inválida
      }
    }
  }

  if (!title) {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (titleMatch?.[1]) {
      const cleaned = decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
      if (cleaned) title = cleaned;
    }
  }

  return { title, poster };
}

function collectRegexMediaMatches(
  html: string,
  baseUrl: string
): { m3u8Urls: string[]; mp4Urls: string[] } {
  const m3u8Urls: string[] = [];
  const mp4Urls: string[] = [];
  const seenM3u8 = new Set<string>();
  const seenMp4 = new Set<string>();

  const normalizedHtml = decodeHtmlEntities(html);

  // 1) URLs absolutas ou protocol-relative
  const absRegex = /(?:https?:)?\/\/[^\s"'<>`\\]+/gi;
  // 2) Caminhos em atributos ou strings JS/JSON
  const quotedPathRegex = /["'](\/[^"'\s<>`]+(?:\.m3u8|\.mp4)(?:\?[^"'\s<>`]*)?)["']/gi;

  const tryPushCandidate = (raw: string) => {
    const cleaned = raw.replace(/[),;]+$/, '').trim();
    if (!cleaned) return;
    let parsed: URL;
    try {
      parsed = new URL(cleaned, baseUrl);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

    const normalized = parsed.toString();
    const lowerPath = parsed.pathname.toLowerCase();

    if (lowerPath.endsWith('/index.m3u8') || lowerPath.endsWith('.m3u8')) {
      if (!seenM3u8.has(normalized)) {
        seenM3u8.add(normalized);
        m3u8Urls.push(normalized);
      }
      return;
    }

    if (lowerPath.endsWith('.mp4')) {
      if (!seenMp4.has(normalized)) {
        seenMp4.add(normalized);
        mp4Urls.push(normalized);
      }
    }
  };

  let match: RegExpExecArray | null;
  while ((match = absRegex.exec(normalizedHtml)) !== null) {
    tryPushCandidate(match[0]);
  }
  while ((match = quotedPathRegex.exec(normalizedHtml)) !== null) {
    if (match[1]) tryPushCandidate(match[1]);
  }

  return { m3u8Urls, mp4Urls };
}

export function extractSiteImportCandidates(
  html: string,
  baseUrl: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): ExtractedSiteCandidate[] {
  const playerricasUrls: string[] = [];
  const seenPlayerricas = new Set<string>();

  const iframeRegex = /<iframe\b[^>]*>/gi;
  let iframeMatch: RegExpExecArray | null;
  while ((iframeMatch = iframeRegex.exec(html)) !== null) {
    const attrs = parseHtmlAttributes(iframeMatch[0]);
    const rawSrc = attrs.src ?? attrs['data-src'] ?? '';
    if (!rawSrc || !/playerricas\.php/i.test(rawSrc)) {
      continue;
    }
    const assembled = assemblePlayerricasUrl(rawSrc, baseUrl, attrs, nowSeconds);
    if (assembled && !seenPlayerricas.has(assembled)) {
      seenPlayerricas.add(assembled);
      playerricasUrls.push(assembled);
    }
  }

  const { m3u8Urls, mp4Urls } = collectRegexMediaMatches(html, baseUrl);

  const ordered: ExtractedSiteCandidate[] = [];
  const seenAll = new Set<string>();

  for (const url of playerricasUrls) {
    if (!seenAll.has(url)) {
      seenAll.add(url);
      ordered.push({ url, type: 'playerricas' });
    }
  }
  for (const url of m3u8Urls) {
    if (!seenAll.has(url)) {
      seenAll.add(url);
      ordered.push({ url, type: 'm3u8' });
    }
  }
  for (const url of mp4Urls) {
    if (!seenAll.has(url)) {
      seenAll.add(url);
      ordered.push({ url, type: 'mp4' });
    }
  }

  return ordered;
}

export function isVideoContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime.startsWith('video/');
}

export function isPlaylistContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime.includes('mpegurl') || mime.includes('m3u8');
}

function isHtmlContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}

function looksLikeHtmlBody(text: string): boolean {
  const head = text.replace(/^\uFEFF/, '').trimStart().toLowerCase();
  return (
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<body') ||
    head.startsWith('<?xml')
  );
}

function looksLikeHlsManifestBody(text: string): boolean {
  return text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
}

function resolveCandidateRefererList(candidateUrl: URL, pageOrigin: string): string[] {
  const list = [...resolveUpstreamRefererCandidates(candidateUrl)];
  const insertBeforeEmpty = (ref: string) => {
    if (list.includes(ref)) return;
    const emptyIdx = list.indexOf('');
    if (emptyIdx >= 0) {
      list.splice(emptyIdx, 0, ref);
    } else {
      list.push(ref);
    }
  };

  insertBeforeEmpty(DEFAULT_ANITUBE_BIZ_REFERER);
  insertBeforeEmpty(LEGACY_MAXIMAIMG_REFERER);
  insertBeforeEmpty(DEFAULT_COEMPREGOS_REFERER);

  if (pageOrigin) {
    try {
      const originUrl = new URL(pageOrigin);
      if (isAnitubeHost(originUrl.hostname) || isAllowedSiteImportHost(candidateUrl.hostname)) {
        insertBeforeEmpty(`${originUrl.origin}/`);
      }
    } catch {
      // Ignora pageOrigin inválido
    }
  }

  return list;
}

async function readBoundedText(response: Response, maxBytes = 262_144): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      const remaining = maxBytes - total;
      const slice = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;
    }
  }
  try {
    await reader.cancel();
  } catch {
    // Ignorar erro ao fechar stream
  }
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    merged.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

async function cancelBodySafely(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Ignorar erro ao descartar corpo
  }
}

function buildExpirableSummary(
  url: string,
  manifestText: string | null
): { isExpirable: boolean; expirableReason: string | null } {
  const matched: string[] = [];
  const combined = `${url}\n${manifestText ?? ''}`;
  if (/x-amz-expires/i.test(combined)) {
    matched.push('X-Amz-Expires');
  }
  if (/token=/i.test(combined)) {
    matched.push('token=');
  }
  if (/sig=/i.test(combined)) {
    matched.push('sig=');
  }

  if (matched.length === 0) {
    return { isExpirable: false, expirableReason: null };
  }

  return {
    isExpirable: true,
    expirableReason: `Fonte expirável (${matched.join(', ')}): pode parar de reproduzir após o vencimento do link.`,
  };
}

async function resolveInitialTargetUrl(
  parsedInput: URL,
  assertSafeUrl: typeof assertSafeExternalUrl
): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
  let current = parsedInput;
  const visited = new Set<string>([current.toString()]);

  for (let hop = 0; hop < 2; hop++) {
    const viewParam = current.searchParams.get('view');
    if (!viewParam) {
      break;
    }
    const decoded = decodeAllappincViewParam(viewParam);
    if (!decoded) {
      break;
    }

    let decodedParsed: URL;
    try {
      decodedParsed = await assertSafeUrl(decoded);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'URL decodificada bloqueada por segurança.',
      };
    }

    if (!isAllowedSiteImportHost(decodedParsed.hostname)) {
      return {
        ok: false,
        error: `Domínio de destino não permitido (${decodedParsed.hostname}).`,
      };
    }

    if (visited.has(decodedParsed.toString())) {
      break;
    }
    visited.add(decodedParsed.toString());
    current = decodedParsed;
  }

  return { ok: true, url: current };
}

async function fetchPageWithHeaderFallback(
  url: URL,
  fetchWithRedirects: typeof safeFetchWithRedirects
): Promise<{ response: Response; finalUrl: string }> {
  const refererChoices = Array.from(
    new Set([`${url.origin}/`, DEFAULT_ANITUBE_BIZ_REFERER, DEFAULT_COEMPREGOS_REFERER, ''])
  );
  let lastResult: { response: Response; finalUrl: string } | null = null;

  for (const ref of refererChoices) {
    if (lastResult) {
      await cancelBodySafely(lastResult.response);
    }
    const headers: Record<string, string> = {
      'User-Agent': ANDROID_CHROME_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
    if (ref) {
      headers['Referer'] = ref;
    }
    lastResult = await fetchWithRedirects(url.toString(), {
      headers,
      timeoutMs: 15_000,
    });
    if (lastResult.response.status !== 403) {
      return lastResult;
    }
  }

  return lastResult!;
}

function formatAttemptList(attempts: readonly SiteImportAttemptDiagnostic[]): string {
  return attempts
    .map(
      (a) =>
        `${a.referer ?? 'sem Referer'} -> ${
          a.status !== null ? `HTTP ${a.status}` : a.error ?? 'erro'
        }`
    )
    .join(', ');
}

export async function importSourceFromEpisodePage(
  rawPageUrl: string,
  deps: SiteImportDeps = {}
): Promise<SiteImportResult> {
  const fetchWithRedirects = deps.fetchWithRedirects ?? safeFetchWithRedirects;
  const assertSafeUrl = deps.assertSafeUrl ?? assertSafeExternalUrl;
  const nowSeconds = deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000);

  const urlCheck = validateHttpUrl(rawPageUrl);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    return {
      ok: false,
      error: urlCheck.error ?? 'URL da página inválida.',
      candidates: [],
    };
  }

  let parsedPageUrl: URL;
  try {
    parsedPageUrl = await assertSafeUrl(urlCheck.normalizedUrl);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'URL da página bloqueada por segurança.',
      candidates: [],
    };
  }

  if (!isAllowedSiteImportHost(parsedPageUrl.hostname)) {
    return {
      ok: false,
      error:
        'Domínio não permitido. Informe uma URL de anitube.biz, anitube22.vip ou allappinc.com.',
      candidates: [],
    };
  }

  const initialResolution = await resolveInitialTargetUrl(parsedPageUrl, assertSafeUrl);
  if (!initialResolution.ok) {
    return {
      ok: false,
      error: initialResolution.error,
      candidates: [],
    };
  }

  let currentPageUrl = initialResolution.url;
  let pageHtml = '';
  let pageFinalUrl = currentPageUrl.toString();
  let pageFinalParsed = currentPageUrl;
  const visitedPageUrls = new Set<string>([currentPageUrl.toString()]);

  for (let pageHop = 0; pageHop < 4; pageHop++) {
    try {
      const { response: pageRes, finalUrl } = await fetchPageWithHeaderFallback(
        currentPageUrl,
        fetchWithRedirects
      );

      pageFinalUrl = finalUrl;
      pageFinalParsed = new URL(finalUrl);
      if (!isAllowedSiteImportHost(pageFinalParsed.hostname)) {
        await cancelBodySafely(pageRes);
        return {
          ok: false,
          error: `Redirecionamento para domínio não permitido (${pageFinalParsed.hostname}).`,
          candidates: [],
        };
      }

      if (pageRes.status !== 200) {
        await cancelBodySafely(pageRes);
        return {
          ok: false,
          error: `Falha ao carregar a página do episódio (HTTP ${pageRes.status}).`,
          candidates: [],
        };
      }

      pageHtml = await readBoundedText(pageRes, 512_000);
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error
            ? `Erro ao buscar página do episódio: ${err.message}`
            : 'Erro de rede ao buscar página do episódio.',
        candidates: [],
      };
    }

    if (isAllappincHost(pageFinalParsed.hostname)) {
      const redirectedViewResolved = await resolveInitialTargetUrl(
        pageFinalParsed,
        assertSafeUrl
      );
      if (!redirectedViewResolved.ok) {
        return {
          ok: false,
          error: redirectedViewResolved.error,
          candidates: [],
        };
      }
      if (
        redirectedViewResolved.url.toString() !== pageFinalParsed.toString() &&
        !visitedPageUrls.has(redirectedViewResolved.url.toString())
      ) {
        visitedPageUrls.add(redirectedViewResolved.url.toString());
        currentPageUrl = redirectedViewResolved.url;
        continue;
      }

      const nextTargetRaw = extractAllappincRedirectTarget(pageHtml, pageFinalUrl);
      if (nextTargetRaw) {
        let nextParsed: URL;
        try {
          nextParsed = await assertSafeUrl(nextTargetRaw);
        } catch (err) {
          return {
            ok: false,
            error:
              err instanceof Error
                ? err.message
                : 'URL de redirecionamento bloqueada por segurança.',
            candidates: [],
          };
        }

        if (!isAllowedSiteImportHost(nextParsed.hostname)) {
          return {
            ok: false,
            error: `Redirecionamento para domínio não permitido (${nextParsed.hostname}).`,
            candidates: [],
          };
        }

        const hopResolved = await resolveInitialTargetUrl(nextParsed, assertSafeUrl);
        if (!hopResolved.ok) {
          return {
            ok: false,
            error: hopResolved.error,
            candidates: [],
          };
        }

        if (!visitedPageUrls.has(hopResolved.url.toString())) {
          visitedPageUrls.add(hopResolved.url.toString());
          currentPageUrl = hopResolved.url;
          continue;
        }
      }
    }

    break;
  }

  const metadata = extractPageMetadata(pageHtml, pageFinalUrl);
  const initialCandidates = extractSiteImportCandidates(pageHtml, pageFinalUrl, nowSeconds);

  if (initialCandidates.length === 0) {
    return {
      ok: false,
      error:
        'Nenhum candidato encontrado na página (iframe playerricas.php, /index.m3u8 ou .mp4).',
      candidates: [],
    };
  }

  const playerricasQueue = initialCandidates.filter((c) => c.type === 'playerricas');
  const m3u8Queue = initialCandidates.filter((c) => c.type === 'm3u8');
  const mp4Queue = initialCandidates.filter((c) => c.type === 'mp4');
  const seenQueuedUrls = new Set<string>(initialCandidates.map((c) => c.url));
  const diagnostics: SiteImportCandidateDiagnostic[] = [];

  const nextCandidate = (): ExtractedSiteCandidate | undefined => {
    if (playerricasQueue.length > 0) return playerricasQueue.shift();
    if (m3u8Queue.length > 0) return m3u8Queue.shift();
    if (mp4Queue.length > 0) return mp4Queue.shift();
    return undefined;
  };

  let candidate: ExtractedSiteCandidate | undefined;
  while ((candidate = nextCandidate()) !== undefined) {
    let candidateParsed: URL;
    try {
      candidateParsed = await assertSafeUrl(candidate.url);
    } catch (err) {
      diagnostics.push({
        url: candidate.url,
        type: candidate.type,
        status: null,
        contentType: null,
        refererUsed: null,
        passed: false,
        reason: err instanceof Error ? err.message : 'URL de candidato bloqueada.',
      });
      continue;
    }

    const referersToTry = resolveCandidateRefererList(candidateParsed, pageFinalParsed.origin);
    const attempts: SiteImportAttemptDiagnostic[] = [];
    let lastStatus: number | null = null;
    let lastContentType: string | null = null;
    let lastRefererUsed: string | null = referersToTry[0] || null;
    let lastError: string | null = null;
    let accepted = false;

    for (const ref of referersToTry) {
      lastRefererUsed = ref || null;
      const headers: Record<string, string> = {
        'User-Agent': ANDROID_CHROME_UA,
        Accept: '*/*',
      };
      if (ref) {
        headers['Referer'] = ref;
      }

      try {
        const { response: candRes, finalUrl: candFinalUrl } = await fetchWithRedirects(
          candidate.url,
          {
            headers,
            timeoutMs: 12_000,
          }
        );

        lastStatus = candRes.status;
        lastContentType = candRes.headers.get('content-type');
        attempts.push({
          referer: ref || null,
          status: candRes.status,
          contentType: lastContentType,
        });

        // 403 nunca barra a importação — tenta o próximo referer
        if (candRes.status === 403) {
          await cancelBodySafely(candRes);
          continue;
        }

        // Só 404 (e outros erros definitivos) ou 200 com HTML encerram o candidato
        if (candRes.status === 404) {
          await cancelBodySafely(candRes);
          lastError = 'HTTP 404 descartado.';
          break;
        }

        if (candRes.status !== 200) {
          await cancelBodySafely(candRes);
          lastError = `HTTP ${candRes.status} descartado.`;
          continue;
        }

        // HTTP 200: checar se é vídeo, playlist ou HTML
        const isVideo = isVideoContentType(lastContentType);
        const isPlaylist = isPlaylistContentType(lastContentType);
        const isDeclaredHtml = isHtmlContentType(lastContentType);

        if (isDeclaredHtml) {
          if (candidate.type === 'playerricas') {
            const innerHtml = await readBoundedText(candRes, 262_144);
            const nested = collectRegexMediaMatches(innerHtml, candFinalUrl);
            for (const url of nested.m3u8Urls) {
              if (!seenQueuedUrls.has(url)) {
                seenQueuedUrls.add(url);
                m3u8Queue.push({ url, type: 'm3u8' });
              }
            }
            for (const url of nested.mp4Urls) {
              if (!seenQueuedUrls.has(url)) {
                seenQueuedUrls.add(url);
                mp4Queue.push({ url, type: 'mp4' });
              }
            }
          } else {
            await cancelBodySafely(candRes);
          }
          lastError = 'HTTP 200 com HTML em vez de vídeo ou playlist válida.';
          break;
        }

        if (isVideo || isPlaylist) {
          let manifestBody: string | null = null;
          if (isPlaylist) {
            manifestBody = await readBoundedText(candRes, 131_072);
            if (looksLikeHtmlBody(manifestBody)) {
              lastError = 'HTTP 200 com HTML em vez de vídeo ou playlist válida.';
              break;
            }
          } else {
            await cancelBodySafely(candRes);
          }

          accepted = true;
          diagnostics.push({
            url: candidate.url,
            type: candidate.type,
            status: 200,
            contentType: lastContentType,
            refererUsed: lastRefererUsed,
            passed: true,
            reason: `HTTP 200 (${lastContentType ?? 'mídia válida'})`,
            attempts,
          });

          const isHls =
            isPlaylist ||
            candidate.type === 'm3u8' ||
            new URL(candFinalUrl).pathname.toLowerCase().endsWith('.m3u8');
          const kind: 'hls' | 'mp4' = isHls ? 'hls' : 'mp4';
          const expirable = buildExpirableSummary(candidate.url, manifestBody);

          return {
            ok: true,
            pageUrl: pageFinalUrl,
            selected: {
              url: candidate.url,
              kind,
              forceProxy: true,
              hostReferer: lastRefererUsed ?? '',
              candidateType: candidate.type,
              isExpirable: expirable.isExpirable,
              expirableReason: expirable.expirableReason,
            },
            extractedTitle: metadata.title,
            extractedPoster: metadata.poster,
            candidates: diagnostics,
          };
        }

        // Content-Type ambíguo (ex.: text/plain, application/octet-stream ou ausente)
        const inspectedBody = await readBoundedText(candRes, 131_072);
        if (looksLikeHtmlBody(inspectedBody)) {
          if (candidate.type === 'playerricas') {
            const nested = collectRegexMediaMatches(inspectedBody, candFinalUrl);
            for (const url of nested.m3u8Urls) {
              if (!seenQueuedUrls.has(url)) {
                seenQueuedUrls.add(url);
                m3u8Queue.push({ url, type: 'm3u8' });
              }
            }
            for (const url of nested.mp4Urls) {
              if (!seenQueuedUrls.has(url)) {
                seenQueuedUrls.add(url);
                mp4Queue.push({ url, type: 'mp4' });
              }
            }
          }
          lastError = 'HTTP 200 com HTML em vez de vídeo ou playlist válida.';
          break;
        }

        if (looksLikeHlsManifestBody(inspectedBody)) {
          accepted = true;
          diagnostics.push({
            url: candidate.url,
            type: candidate.type,
            status: 200,
            contentType: lastContentType,
            refererUsed: lastRefererUsed,
            passed: true,
            reason: `HTTP 200 (${lastContentType ?? 'playlist HLS'})`,
            attempts,
          });

          const expirable = buildExpirableSummary(candidate.url, inspectedBody);
          return {
            ok: true,
            pageUrl: pageFinalUrl,
            selected: {
              url: candidate.url,
              kind: 'hls',
              forceProxy: true,
              hostReferer: lastRefererUsed ?? '',
              candidateType: candidate.type,
              isExpirable: expirable.isExpirable,
              expirableReason: expirable.expirableReason,
            },
            extractedTitle: metadata.title,
            extractedPoster: metadata.poster,
            candidates: diagnostics,
          };
        }

        if (
          candidate.type === 'mp4' &&
          (lastContentType?.toLowerCase().includes('application/octet-stream') || !lastContentType) &&
          inspectedBody.length > 0
        ) {
          accepted = true;
          diagnostics.push({
            url: candidate.url,
            type: candidate.type,
            status: 200,
            contentType: lastContentType,
            refererUsed: lastRefererUsed,
            passed: true,
            reason: `HTTP 200 (${lastContentType ?? 'mp4 binário'})`,
            attempts,
          });

          const expirable = buildExpirableSummary(candidate.url, null);
          return {
            ok: true,
            pageUrl: pageFinalUrl,
            selected: {
              url: candidate.url,
              kind: 'mp4',
              forceProxy: true,
              hostReferer: lastRefererUsed ?? '',
              candidateType: candidate.type,
              isExpirable: expirable.isExpirable,
              expirableReason: expirable.expirableReason,
            },
            extractedTitle: metadata.title,
            extractedPoster: metadata.poster,
            candidates: diagnostics,
          };
        }

        lastError = `HTTP 200 com Content-Type inválido (${lastContentType ?? 'ausente'})`;
        break;
      } catch (err) {
        const errMessage =
          err instanceof Error ? err.message : 'Falha de rede ao validar candidato.';
        attempts.push({
          referer: ref || null,
          status: null,
          contentType: null,
          error: errMessage,
        });
        lastError = errMessage;
        break;
      }
    }

    if (!accepted) {
      const allReferers403 =
        attempts.length > 0 && attempts.every((attempt) => attempt.status === 403);
      const attemptText = attempts.length > 0 ? formatAttemptList(attempts) : '';
      diagnostics.push({
        url: candidate.url,
        type: candidate.type,
        status: lastStatus,
        contentType: lastContentType,
        refererUsed: lastRefererUsed,
        passed: false,
        reason: allReferers403
          ? `host exige referer desconhecido (${attemptText})`
          : lastError ??
            (lastStatus !== null ? `HTTP ${lastStatus} rejeitado.` : 'Falha ao validar candidato.'),
        ...(attempts.length > 0 ? { attempts } : {}),
      });
    }
  }

  const allCandidatesAll403 =
    diagnostics.length > 0 &&
    diagnostics.every(
      (item) => (item.attempts?.length ?? 0) > 0 && item.attempts!.every((a) => a.status === 403)
    );
  const hasAnyAll403 = diagnostics.some(
    (item) => (item.attempts?.length ?? 0) > 0 && item.attempts!.every((a) => a.status === 403)
  );

  if (allCandidatesAll403) {
    const attemptDetails = diagnostics
      .map(
        (item, idx) =>
          `#${idx + 1} [${item.type}] ${formatAttemptList(item.attempts ?? [])}`
      )
      .join('; ');
    return {
      ok: false,
      error: `host exige referer desconhecido. Status de cada tentativa: ${attemptDetails}`,
      candidates: diagnostics,
    };
  }

  if (hasAnyAll403) {
    const attemptDetails = diagnostics
      .map(
        (item, idx) =>
          `#${idx + 1} [${item.type}] ${formatAttemptList(item.attempts ?? [])}`
      )
      .join('; ');
    return {
      ok: false,
      error: `Nenhum candidato retornou HTTP 200 válido (host exige referer desconhecido nos bloqueados com 403). Status de cada tentativa: ${attemptDetails}`,
      candidates: diagnostics,
    };
  }

  const summary = diagnostics
    .map((item, idx) => {
      const base = `#${idx + 1} [${item.type}] ${
        item.status !== null ? `HTTP ${item.status}` : 'erro'
      }${item.contentType ? ` (${item.contentType})` : ''}`;
      if (item.attempts && item.attempts.length > 1) {
        return `${base} [${formatAttemptList(item.attempts)}]`;
      }
      return base;
    })
    .join('; ');

  return {
    ok: false,
    error: `Nenhum candidato retornou HTTP 200 com vídeo ou playlist válida. Status obtidos: ${summary}`,
    candidates: diagnostics,
  };
}
