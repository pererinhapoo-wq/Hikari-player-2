import { assertSafeExternalUrl, safeFetchWithRedirects } from '@/lib/ssrf';
import { resolveUpstreamRefererCandidates } from '@/lib/stream-proxy';
import type {
  SiteImportCandidateDiagnostic,
  SiteImportCandidateType,
} from '@/lib/types';
import {
  hasExpirableHlsTokens,
  isExpirableHlsSourceUrl,
  validateHttpUrl,
} from '@/lib/video-sources';

export const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

export const ALLOWED_SITE_IMPORT_HOSTS = ['anitube.biz', 'anitube22.vip'] as const;

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
  nowSeconds?: () => number;
}

export function isAllowedSiteImportHost(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (!clean) return false;
  return ALLOWED_SITE_IMPORT_HOSTS.some(
    (allowed) => clean === allowed || clean.endsWith(`.${allowed}`)
  );
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

    if (lowerPath.endsWith('/index.m3u8')) {
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

function resolveCandidateRefererList(candidateUrl: URL, pageOrigin: string): string[] {
  const list = resolveUpstreamRefererCandidates(candidateUrl);
  const originSlash = `${pageOrigin}/`;
  const hostname = candidateUrl.hostname.toLowerCase();
  if (isAllowedSiteImportHost(hostname) && !list.includes(originSlash)) {
    const result = [...list];
    const emptyIdx = result.indexOf('');
    if (emptyIdx >= 0) {
      result.splice(emptyIdx, 0, originSlash);
    } else {
      result.push(originSlash);
    }
    return result;
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

export async function importSourceFromEpisodePage(
  rawPageUrl: string,
  deps: SiteImportDeps = {}
): Promise<SiteImportResult> {
  const fetchWithRedirects = deps.fetchWithRedirects ?? safeFetchWithRedirects;
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
    parsedPageUrl = await assertSafeExternalUrl(urlCheck.normalizedUrl);
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
      error: 'Domínio não permitido. Informe uma URL de anitube.biz ou anitube22.vip.',
      candidates: [],
    };
  }

  let pageHtml = '';
  let pageFinalUrl = parsedPageUrl.toString();
  try {
    const pageReferer = `${parsedPageUrl.origin}/`;
    const { response: pageRes, finalUrl } = await fetchWithRedirects(parsedPageUrl.toString(), {
      headers: {
        'User-Agent': ANDROID_CHROME_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: pageReferer,
      },
      timeoutMs: 15_000,
    });

    pageFinalUrl = finalUrl;
    const finalParsed = new URL(finalUrl);
    if (!isAllowedSiteImportHost(finalParsed.hostname)) {
      await cancelBodySafely(pageRes);
      return {
        ok: false,
        error: `Redirecionamento para domínio não permitido (${finalParsed.hostname}).`,
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
      candidateParsed = await assertSafeExternalUrl(candidate.url);
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

    const referersToTry = resolveCandidateRefererList(candidateParsed, parsedPageUrl.origin);
    let lastStatus: number | null = null;
    let lastContentType: string | null = null;
    let lastRefererUsed: string | null = referersToTry[0] || null;
    let lastError: string | null = null;
    let accepted = false;
    let manifestBody: string | null = null;

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

        if (candRes.status === 403) {
          await cancelBodySafely(candRes);
          continue;
        }

        if (candRes.status === 404 || candRes.status !== 200) {
          await cancelBodySafely(candRes);
          lastError = `HTTP ${candRes.status} descartado.`;
          break;
        }

        // HTTP 200: aceitar somente Content-Type de vídeo ou playlist
        const isVideo = isVideoContentType(lastContentType);
        const isPlaylist = isPlaylistContentType(lastContentType);

        if (isVideo || isPlaylist) {
          if (isPlaylist) {
            manifestBody = await readBoundedText(candRes, 131_072);
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

        // HTTP 200 mas Content-Type não é vídeo nem playlist (ex.: text/html do playerricas.php)
        if (
          candidate.type === 'playerricas' &&
          (lastContentType?.toLowerCase().includes('text/html') ||
            lastContentType?.toLowerCase().includes('application/xhtml') ||
            !lastContentType)
        ) {
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

        lastError = `HTTP 200 com Content-Type inválido (${lastContentType ?? 'ausente'})`;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'Falha de rede ao validar candidato.';
        break;
      }
    }

    if (!accepted) {
      diagnostics.push({
        url: candidate.url,
        type: candidate.type,
        status: lastStatus,
        contentType: lastContentType,
        refererUsed: lastRefererUsed,
        passed: false,
        reason:
          lastError ??
          (lastStatus !== null ? `HTTP ${lastStatus} rejeitado.` : 'Falha ao validar candidato.'),
      });
    }
  }

  const summary = diagnostics
    .map(
      (item, idx) =>
        `#${idx + 1} [${item.type}] ${item.status !== null ? `HTTP ${item.status}` : 'erro'}${
          item.contentType ? ` (${item.contentType})` : ''
        }`
    )
    .join('; ');

  return {
    ok: false,
    error: `Nenhum candidato retornou HTTP 200 com vídeo ou playlist válida. Status obtidos: ${summary}`,
    candidates: diagnostics,
  };
}
