import {
  CLOUDFLARE_SERVER_BLOCK_MESSAGE,
  formatEmbedAttemptSequence,
  isCloudflareBlockedBody,
  resolveEmbedProxy,
} from '@/lib/embed-proxy';
import { safeFetchWithRedirects } from '@/lib/ssrf';
import {
  BROWSER_UA,
  resolveUpstreamReferer,
  resolveUpstreamRefererCandidates,
} from '@/lib/stream-proxy';
import type {
  EmbedAuthStrategy,
  EmbedHostDiagnostic,
  EmbedRedirectHopDiagnostic,
  SourceAttemptDiagnostic,
  SourceTestReport,
  SourceTestVerdict,
} from '@/lib/types';
import { extractHlsVariantUrls } from '@/lib/proxy-signing';
import {
  classifyEmbedHost,
  describeExpirableHlsTokens,
  detectSourceKind,
  type ExplicitSourceKind,
  hasExpirableHlsTokens,
  inspectR2SourceUrl,
  isR2StorageUrl,
  isVercelBlobUrl,
  validateHttpUrl,
} from '@/lib/video-sources';
import { resolveVideoInputUrl } from '@/lib/r2-resolver';

export const MIN_MIRROR_SIZE_RATIO = 0.9;

export interface SourceTestInput {
  slot: 1 | 2 | 3 | 4 | 5;
  label?: string;
  url: string;
  kind?: ExplicitSourceKind | '' | null;
  sourceReferer?: string | null;
  isMirror?: boolean;
  originalContentLength?: number | null;
  originalUrl?: string | null;
}

export interface SourceDiagnosticsDeps {
  fetchWithRedirects?: typeof safeFetchWithRedirects;
  embedFetchImpl?: typeof fetch;
  embedAssertSafeUrl?: (rawUrl: string) => Promise<URL>;
}

interface InternalAttemptResult {
  diagnostic: SourceAttemptDiagnostic;
  cspHeader: string | null;
  xFrameOptions: string | null;
  cloudflareBlocked: boolean;
  finalUrl: string | null;
  manifestText: string | null;
}

function extractFrameAncestorsDirective(cspHeader: string | null): string | null {
  if (!cspHeader) return null;
  for (const part of cspHeader.split(';')) {
    const trimmed = part.trim();
    if (/^frame-ancestors\b/i.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

async function read200InspectionSafely(
  response: Response,
  contentType: string | null
): Promise<{ firstLine: string | null; manifestText: string | null }> {
  if (response.status !== 200) {
    return { firstLine: null, manifestText: null };
  }

  const lowerCt = (contentType ?? '').toLowerCase();
  const isLikelyBinary =
    lowerCt.startsWith('video/') ||
    lowerCt.startsWith('audio/') ||
    lowerCt.startsWith('image/') ||
    lowerCt === 'application/octet-stream';

  try {
    let bytes: Uint8Array;
    const MAX_BYTES = 65_536;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      try {
        await reader.cancel();
      } catch {
        // Ignora erro de cancelamento
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      const buf = new Uint8Array(await response.arrayBuffer());
      bytes = buf.slice(0, MAX_BYTES);
    }

    if (bytes.byteLength === 0) {
      return { firstLine: null, manifestText: null };
    }

    // Se contém NUL byte ou sync MPEG-TS sem #EXTM3U, trata como binário
    if (isLikelyBinary && bytes[0] !== 0x23) {
      return {
        firstLine: `(binário: ${contentType || 'application/octet-stream'})`,
        manifestText: null,
      };
    }

    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (decoded.includes('\u0000')) {
      return {
        firstLine: `(binário: ${contentType || 'application/octet-stream'})`,
        manifestText: null,
      };
    }

    const firstLine = decoded
      .split(/\r?\n/)
      .map((line) => line.replace(/^\uFEFF/, '').trim())
      .find((line) => line.length > 0);

    const normalizedTrimmed = decoded.replace(/^\uFEFF/, '').trimStart();
    const manifestText = normalizedTrimmed.startsWith('#EXTM3U') ? decoded : null;

    if (!firstLine) return { firstLine: null, manifestText };
    return {
      firstLine: firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine,
      manifestText,
    };
  } catch {
    return { firstLine: null, manifestText: null };
  }
}

async function readTextSnippetSafely(
  response: Response,
  contentType: string | null,
  maxBytes = 32_768
): Promise<string | null> {
  const lowerCt = (contentType ?? '').toLowerCase();
  const isLikelyBinary =
    lowerCt.startsWith('video/') ||
    lowerCt.startsWith('audio/') ||
    lowerCt.startsWith('image/') ||
    lowerCt === 'application/octet-stream';

  if (isLikelyBinary) {
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // ignore
      }
    }
    return null;
  }

  try {
    let bytes: Uint8Array;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      try {
        await reader.cancel();
      } catch {
        // Ignora erro de cancelamento
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      const buf = new Uint8Array(await response.arrayBuffer());
      bytes = buf.slice(0, maxBytes);
    }

    if (bytes.byteLength === 0) return null;
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function parseHeaderContentLength(response: Response): number | null {
  const contentRange = response.headers.get('content-range');
  if (contentRange) {
    const match = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(contentRange.trim());
    if (match) {
      const total = Number(match[1]);
      if (Number.isFinite(total) && total >= 0) {
        return total;
      }
    }
  }
  const rawLength = response.headers.get('content-length');
  if (rawLength && /^\d+$/.test(rawLength.trim())) {
    const parsed = Number(rawLength.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

async function runSingleAttempt(
  url: string,
  headers: Record<string, string>,
  sentReferer: string | null,
  fetchWithRedirects: typeof safeFetchWithRedirects
): Promise<InternalAttemptResult> {
  try {
    const { response, finalUrl } = await fetchWithRedirects(url, {
      headers,
      timeoutMs: 12000,
    });
    const acao = response.headers.get('access-control-allow-origin');
    const contentType = response.headers.get('content-type');
    const contentLength = parseHeaderContentLength(response);
    const cspHeader = response.headers.get('content-security-policy');
    const xFrameOptions = response.headers.get('x-frame-options');
    let firstLine: string | null = null;
    let manifestText: string | null = null;
    let cloudflareBlocked = false;

    if (response.status === 200) {
      const inspected = await read200InspectionSafely(response, contentType);
      firstLine = inspected.firstLine;
      manifestText = inspected.manifestText;
    } else {
      const errSnippet = await readTextSnippetSafely(response, contentType);
      if (errSnippet && isCloudflareBlockedBody(errSnippet)) {
        cloudflareBlocked = true;
      }
    }
    return {
      diagnostic: {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        accessControlAllowOrigin: acao,
        hasAcao: Boolean(acao && acao.trim().length > 0),
        firstLine,
        contentType,
        contentLength,
        sentReferer,
        error: null,
      },
      cspHeader,
      xFrameOptions,
      cloudflareBlocked,
      finalUrl,
      manifestText,
    };
  } catch (err) {
    return {
      diagnostic: {
        status: null,
        ok: false,
        accessControlAllowOrigin: null,
        hasAcao: false,
        firstLine: null,
        contentType: null,
        contentLength: null,
        sentReferer,
        error: err instanceof Error ? err.message : 'Falha de rede ao consultar origem.',
      },
      cspHeader: null,
      xFrameOptions: null,
      cloudflareBlocked: false,
      finalUrl: null,
      manifestText: null,
    };
  }
}

function isVideoContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime.startsWith('video/');
}

function isHtmlContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isMirrorSizeBelowThreshold(
  mirrorContentLength: number | null | undefined,
  originalContentLength: number | null | undefined
): boolean {
  if (
    typeof originalContentLength !== 'number' ||
    !Number.isFinite(originalContentLength) ||
    originalContentLength <= 0
  ) {
    return false;
  }
  if (
    typeof mirrorContentLength !== 'number' ||
    !Number.isFinite(mirrorContentLength) ||
    mirrorContentLength < 0
  ) {
    return true;
  }
  return mirrorContentLength < originalContentLength * MIN_MIRROR_SIZE_RATIO;
}

function applyMirrorIntegrityCheck(
  report: SourceTestReport,
  originalContentLength: number | null | undefined
): SourceTestReport {
  if (report.verdict === 'bloqueado') {
    return report;
  }
  if (
    typeof originalContentLength !== 'number' ||
    !Number.isFinite(originalContentLength) ||
    originalContentLength <= 0
  ) {
    return report;
  }

  const mirrorSize =
    report.withHeaders.contentLength ?? report.noHeaders.contentLength ?? null;
  if (!isMirrorSizeBelowThreshold(mirrorSize, originalContentLength)) {
    return report;
  }

  const reason =
    mirrorSize === null
      ? `Espelho reprovado: não informou content-length para validar mínimo de 90% de ${formatMegabytes(originalContentLength)} originais.`
      : `Espelho incompleto: ${formatMegabytes(mirrorSize)} vs ${formatMegabytes(originalContentLength)} originais (abaixo de 90%).`;

  return {
    ...report,
    verdict: 'bloqueado',
    verdictLabel: 'bloqueado',
    verdictReason: reason,
  };
}

async function probeOriginalContentLength(
  rawUrl: string,
  fetchWithRedirects: typeof safeFetchWithRedirects
): Promise<number | null> {
  let effective = rawUrl.trim();
  if (!effective) return null;
  try {
    const resolved = await resolveVideoInputUrl(effective);
    effective = resolved.finalUrl;
  } catch {
    // Segue com URL informada se resolução falhar
  }
  const urlCheck = validateHttpUrl(effective);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    return null;
  }
  try {
    const parsed = new URL(urlCheck.normalizedUrl);
    const headers: Record<string, string> = {
      'User-Agent': BROWSER_UA,
      Accept: '*/*',
      Range: 'bytes=0-0',
    };
    const referer = resolveUpstreamReferer(parsed);
    if (referer && !parsed.hostname.toLowerCase().endsWith('.r2.cloudflarestorage.com')) {
      headers['Referer'] = referer;
    }
    const { response } = await fetchWithRedirects(parsed.toString(), {
      headers,
      timeoutMs: 12000,
    });
    const length = response.ok ? parseHeaderContentLength(response) : null;
    try {
      await response.body?.cancel();
    } catch {
      // Ignora erro ao descartar corpo da sonda
    }
    return length;
  } catch {
    return null;
  }
}

export function classifySourceDiagnostic(
  detectedKind: ExplicitSourceKind,
  noHeaders: SourceAttemptDiagnostic,
  withHeaders: SourceAttemptDiagnostic,
  targetOrigin: string,
  embedDiagnostic?: EmbedHostDiagnostic,
  cloudflareServerBlocked = false
): {
  verdict: SourceTestVerdict;
  verdictLabel: 'direto ok' | 'proxy necessário' | 'bloqueado';
  verdictReason: string;
} {
  if (detectedKind === 'iframe') {
    if (embedDiagnostic?.hostCategory === 'proxied') {
      const directStatusText =
        embedDiagnostic.directStatus !== null ? `HTTP ${embedDiagnostic.directStatus}` : 'erro';
      const faText = embedDiagnostic.hasFrameAncestors
        ? `frame-ancestors presente (${embedDiagnostic.frameAncestorsValue})`
        : 'frame-ancestors ausente';
      const attemptSequence = formatEmbedAttemptSequence(embedDiagnostic.redirectChain);
      if (embedDiagnostic.embedProxyOk) {
        const strategyText =
          embedDiagnostic.successfulStrategy === 'chrome_ua_no_referer'
            ? 'UA Chrome sem Referer (fallback após 403)'
            : 'UA Chrome + Referer';
        return {
          verdict: 'proxy_necessario',
          verdictLabel: 'proxy necessário',
          verdictReason: `Host exige /api/embed (fetch direto: ${directStatusText}; ${faText}; /api/embed: HTTP ${embedDiagnostic.embedProxyStatus} via ${strategyText}; tentativas: ${attemptSequence}).`,
        };
      }
      if (
        cloudflareServerBlocked ||
        embedDiagnostic.embedProxyError === CLOUDFLARE_SERVER_BLOCK_MESSAGE
      ) {
        return {
          verdict: 'bloqueado',
          verdictLabel: 'bloqueado',
          verdictReason: CLOUDFLARE_SERVER_BLOCK_MESSAGE,
        };
      }
      const errorDetail =
        embedDiagnostic.embedProxyError ?? `HTTP ${embedDiagnostic.embedProxyStatus ?? 'erro'}`;
      const includesSequence =
        embedDiagnostic.redirectChain.length > 0 && errorDetail.includes(attemptSequence);
      const sequenceSuffix =
        embedDiagnostic.redirectChain.length > 0 && !includesSequence
          ? `; tentativas: ${attemptSequence}`
          : '';
      return {
        verdict: 'bloqueado',
        verdictLabel: 'bloqueado',
        verdictReason: `Host exige /api/embed, mas /api/embed falhou (${errorDetail}${sequenceSuffix}). Fetch direto: ${directStatusText}; ${faText}.`,
      };
    }

    if (withHeaders.ok || noHeaders.ok) {
      return {
        verdict: 'direto_ok',
        verdictLabel: 'direto ok',
        verdictReason:
          embedDiagnostic?.hostCategory === 'direct'
            ? 'Host em EMBED_DIRECT_HOSTS reproduz em iframe direto (sem /api/embed) e respondeu 2xx.'
            : 'Fonte iframe não depende de CORS/proxy e respondeu 2xx.',
      };
    }
    if (cloudflareServerBlocked) {
      return {
        verdict: 'direto_ok',
        verdictLabel: 'direto ok',
        verdictReason: CLOUDFLARE_SERVER_BLOCK_MESSAGE,
      };
    }
    return {
      verdict: 'bloqueado',
      verdictLabel: 'bloqueado',
      verdictReason: `Página do player respondeu HTTP ${withHeaders.status ?? noHeaders.status ?? 'erro'}.`,
    };
  }

  const withHeadersIsHtml = withHeaders.status === 200 && isHtmlContentType(withHeaders.contentType);
  const noHeadersIsHtml = noHeaders.status === 200 && isHtmlContentType(noHeaders.contentType);
  if (withHeadersIsHtml || (!withHeaders.ok && noHeadersIsHtml)) {
    return {
      verdict: 'bloqueado',
      verdictLabel: 'bloqueado',
      verdictReason:
        'Origem respondeu HTTP 200 com Content-Type text/html em vez de vídeo ou stream válido.',
    };
  }

  if (noHeaders.status === 200 && isVideoContentType(noHeaders.contentType)) {
    return {
      verdict: 'direto_ok',
      verdictLabel: 'direto ok',
      verdictReason:
        'Origem respondeu HTTP 200 com Content-Type de vídeo; reprodução direta compatível com <video>.',
    };
  }

  if (withHeaders.ok) {
    const requiredProviderReferer =
      Boolean(withHeaders.sentReferer) &&
      !withHeaders.sentReferer!.startsWith(targetOrigin) &&
      !noHeaders.ok;

    if (withHeaders.status === 200 && isVideoContentType(withHeaders.contentType) && !requiredProviderReferer) {
      return {
        verdict: 'direto_ok',
        verdictLabel: 'direto ok',
        verdictReason:
          'Origem respondeu HTTP 200 com Content-Type de vídeo; reprodução direta compatível com <video>.',
      };
    }

    const acaoAllowsBrowser =
      withHeaders.hasAcao &&
      (withHeaders.accessControlAllowOrigin?.trim() === '*' ||
        withHeaders.accessControlAllowOrigin?.includes('vercel.app') === true);

    if (acaoAllowsBrowser && !requiredProviderReferer && (noHeaders.ok || !withHeaders.sentReferer)) {
      return {
        verdict: 'direto_ok',
        verdictLabel: 'direto ok',
        verdictReason: 'Origem respondeu 2xx com Access-Control-Allow-Origin e sem exigir Referer de terceiros.',
      };
    }

    if (!withHeaders.hasAcao) {
      return {
        verdict: 'proxy_necessario',
        verdictLabel: 'proxy necessário',
        verdictReason: noHeaders.ok
          ? 'Origem respondeu 2xx sem Referer, mas sem Access-Control-Allow-Origin (navegador bloqueia por CORS).'
          : 'Origem respondeu 2xx com UA/Referer do proxy, mas sem Access-Control-Allow-Origin.',
      };
    }

    return {
      verdict: 'proxy_necessario',
      verdictLabel: 'proxy necessário',
      verdictReason: 'Origem exige cabeçalhos do proxy (ex.: Referer do provedor) para responder 2xx.',
    };
  }

  if (noHeaders.ok && noHeaders.hasAcao) {
    return {
      verdict: 'direto_ok',
      verdictLabel: 'direto ok',
      verdictReason: 'Origem respondeu 2xx com Access-Control-Allow-Origin na requisição direta.',
    };
  }

  return {
    verdict: 'bloqueado',
    verdictLabel: 'bloqueado',
    verdictReason: withHeaders.error
      ? withHeaders.error
      : `Origem retornou HTTP ${withHeaders.status ?? noHeaders.status ?? 'desconhecido'} mesmo com User-Agent/Referer do mapa.`,
  };
}

async function detectExpirableHlsSource(params: {
  detectedKind: ExplicitSourceKind;
  targetUrl: string;
  withHeadersRes: InternalAttemptResult;
  noHeadersRes: InternalAttemptResult;
  fetchWithRedirects: typeof safeFetchWithRedirects;
}): Promise<{ isExpirable: boolean; expirableReason: string | null }> {
  const r2Candidate =
    (isR2StorageUrl(params.withHeadersRes.finalUrl ?? '') ? params.withHeadersRes.finalUrl : null) ??
    (isR2StorageUrl(params.noHeadersRes.finalUrl ?? '') ? params.noHeadersRes.finalUrl : null) ??
    (isR2StorageUrl(params.targetUrl) ? params.targetUrl : null);

  if (r2Candidate) {
    const r2Info = inspectR2SourceUrl(r2Candidate);
    return {
      isExpirable: true,
      expirableReason: r2Info.warningMessage,
    };
  }

  const manifestText = params.withHeadersRes.manifestText ?? params.noHeadersRes.manifestText;
  const manifestBaseUrl =
    (params.withHeadersRes.manifestText ? params.withHeadersRes.finalUrl : params.noHeadersRes.finalUrl) ??
    params.targetUrl;

  const isHls = params.detectedKind === 'hls' || Boolean(manifestText);
  if (!isHls) {
    return { isExpirable: false, expirableReason: null };
  }

  const matchedTokens: string[] = [];
  const collectTokenMatches = (text: string | null | undefined) => {
    if (!text) return;
    for (const label of describeExpirableHlsTokens(text)) {
      if (!matchedTokens.includes(label)) {
        matchedTokens.push(label);
      }
    }
  };

  if (
    hasExpirableHlsTokens(params.targetUrl) ||
    hasExpirableHlsTokens(params.withHeadersRes.finalUrl ?? '') ||
    hasExpirableHlsTokens(params.noHeadersRes.finalUrl ?? '')
  ) {
    collectTokenMatches(params.targetUrl);
    collectTokenMatches(params.withHeadersRes.finalUrl);
    collectTokenMatches(params.noHeadersRes.finalUrl);
  }

  if (manifestText && hasExpirableHlsTokens(manifestText)) {
    collectTokenMatches(manifestText);
  }

  if (matchedTokens.length === 0 && manifestText) {
    const variantUrls = extractHlsVariantUrls(manifestText, manifestBaseUrl);
    if (variantUrls.length > 0) {
      const firstVariantUrl = variantUrls[0];
      if (hasExpirableHlsTokens(firstVariantUrl)) {
        collectTokenMatches(firstVariantUrl);
      } else {
        try {
          const parsedVar = new URL(firstVariantUrl);
          const varHeaders: Record<string, string> = {
            'User-Agent': BROWSER_UA,
            Accept: '*/*',
          };
          const varReferer = resolveUpstreamReferer(parsedVar);
          if (varReferer) {
            varHeaders['Referer'] = varReferer;
          }
          const varAttempt = await runSingleAttempt(
            firstVariantUrl,
            varHeaders,
            varReferer || null,
            params.fetchWithRedirects
          );
          if (
            hasExpirableHlsTokens(varAttempt.finalUrl ?? '') ||
            hasExpirableHlsTokens(varAttempt.manifestText ?? '')
          ) {
            collectTokenMatches(varAttempt.finalUrl);
            collectTokenMatches(varAttempt.manifestText);
          }
        } catch {
          // Sonda auxiliar de variante não deve interromper o diagnóstico principal
        }
      }
    }
  }

  if (matchedTokens.length === 0) {
    return { isExpirable: false, expirableReason: null };
  }

  return {
    isExpirable: true,
    expirableReason: `Fonte HLS expirável (${matchedTokens.join(', ')}): pode parar de reproduzir após o vencimento do link.`,
  };
}

export async function diagnoseVideoSource(
  input: SourceTestInput,
  deps: SourceDiagnosticsDeps = {}
): Promise<SourceTestReport> {
  const fetchWithRedirects = deps.fetchWithRedirects ?? safeFetchWithRedirects;
  const label = input.label?.trim() || `Player ${input.slot}`;
  let effectiveUrl = input.url;
  try {
    const resolved = await resolveVideoInputUrl(input.url);
    effectiveUrl = resolved.finalUrl;
  } catch {
    // let validateHttpUrl handle error if resolution fails
  }
  const urlCheck = validateHttpUrl(effectiveUrl, 8192);
  const detectedKind = detectSourceKind(effectiveUrl, input.kind);

  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    const invalidAttempt: SourceAttemptDiagnostic = {
      status: null,
      ok: false,
      accessControlAllowOrigin: null,
      hasAcao: false,
      firstLine: null,
      contentType: null,
      sentReferer: null,
      error: urlCheck.error ?? 'URL inválida.',
    };
    return {
      slot: input.slot,
      label,
      url: input.url.trim(),
      detectedKind,
      noHeaders: invalidAttempt,
      withHeaders: invalidAttempt,
      verdict: 'bloqueado',
      verdictLabel: 'bloqueado',
      verdictReason: urlCheck.error ?? 'URL inválida.',
    };
  }

  const targetUrl = new URL(urlCheck.normalizedUrl);
  const refererCandidates = resolveUpstreamRefererCandidates(
    targetUrl,
    undefined,
    undefined,
    input.sourceReferer
  );

  const noHeadersRes = await runSingleAttempt(
    targetUrl.toString(),
    {},
    null,
    fetchWithRedirects
  );

  const tryWithReferer = async (ref: string): Promise<InternalAttemptResult> => {
    const proxyHeaders: Record<string, string> = {
      'User-Agent': BROWSER_UA,
      Accept: '*/*',
    };
    if (ref) {
      proxyHeaders['Referer'] = ref;
    }
    return await runSingleAttempt(
      targetUrl.toString(),
      proxyHeaders,
      ref || null,
      fetchWithRedirects
    );
  };

  let withHeadersRes = await tryWithReferer(refererCandidates[0] ?? '');

  if (
    detectedKind !== 'iframe' &&
    !isVercelBlobUrl(targetUrl.toString()) &&
    (withHeadersRes.diagnostic.status === 403 || withHeadersRes.diagnostic.status === 404)
  ) {
    for (let i = 1; i < refererCandidates.length; i++) {
      const candidateAttempt = await tryWithReferer(refererCandidates[i]);
      if (candidateAttempt.diagnostic.ok) {
        withHeadersRes = candidateAttempt;
        break;
      }
      if (
        candidateAttempt.diagnostic.status !== null &&
        candidateAttempt.diagnostic.status !== 403 &&
        candidateAttempt.diagnostic.status !== 404
      ) {
        withHeadersRes = candidateAttempt;
        break;
      }
    }
  }

  const hostCategory = classifyEmbedHost(targetUrl.toString());
  const frameAncestorsValue =
    extractFrameAncestorsDirective(noHeadersRes.cspHeader) ??
    extractFrameAncestorsDirective(withHeadersRes.cspHeader);
  const directStatus =
    noHeadersRes.diagnostic.status ?? withHeadersRes.diagnostic.status;

  let embedDiagnostic: EmbedHostDiagnostic | undefined;
  if (hostCategory === 'proxied') {
    let embedProxyStatus: number | null = null;
    let embedProxyOk = false;
    let embedProxyError: string | null = null;
    let redirectChain: EmbedRedirectHopDiagnostic[] = [];
    let successfulStrategy: EmbedAuthStrategy | null = null;
    let finalUrl: string | null = null;

    try {
      const embedReq = new Request(
        `https://local.test/api/embed?u=${encodeURIComponent(targetUrl.toString())}`,
        { method: 'GET' }
      );
      const embedResult = await resolveEmbedProxy(embedReq, {
        fetchImpl: deps.embedFetchImpl,
        assertSafeUrl: deps.embedAssertSafeUrl,
      });
      const embedRes = embedResult.response;
      redirectChain = embedResult.redirectChain;
      successfulStrategy = embedResult.successfulStrategy;
      finalUrl = embedResult.finalUrl;
      embedProxyStatus = embedRes.status;
      embedProxyOk = embedRes.ok;
      if (!embedRes.ok) {
        const bodyText = await embedRes.text();
        const reasonMatch = /<p>([^<]+)<\/p>/i.exec(bodyText);
        const rawReason = reasonMatch?.[1];
        embedProxyError = rawReason
          ? rawReason
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&amp;/g, '&')
          : `HTTP ${embedRes.status}`;
      } else if (embedRes.body) {
        try {
          await embedRes.body.cancel();
        } catch {
          // ignore
        }
      }
    } catch (err) {
      embedProxyError =
        err instanceof Error ? err.message : 'Falha ao testar rota /api/embed.';
    }

    embedDiagnostic = {
      hostCategory: 'proxied',
      hostLabel: 'Exige /api/embed',
      directStatus,
      hasFrameAncestors: Boolean(frameAncestorsValue),
      frameAncestorsValue,
      embedProxyStatus,
      embedProxyOk,
      embedProxyError,
      redirectChain,
      successfulStrategy,
      finalUrl,
    };
  } else if (hostCategory === 'direct') {
    embedDiagnostic = {
      hostCategory: 'direct',
      hostLabel: 'Iframe direto (sem /api/embed)',
      directStatus,
      hasFrameAncestors: Boolean(frameAncestorsValue),
      frameAncestorsValue,
      embedProxyStatus: null,
      embedProxyOk: false,
      embedProxyError: null,
      redirectChain: [],
      successfulStrategy: null,
      finalUrl: null,
    };
  }

  const cloudflareServerBlocked =
    noHeadersRes.cloudflareBlocked ||
    withHeadersRes.cloudflareBlocked ||
    embedDiagnostic?.embedProxyError === CLOUDFLARE_SERVER_BLOCK_MESSAGE;

  const classification = classifySourceDiagnostic(
    detectedKind,
    noHeadersRes.diagnostic,
    withHeadersRes.diagnostic,
    targetUrl.origin,
    embedDiagnostic,
    cloudflareServerBlocked
  );

  const expirableCheck = await detectExpirableHlsSource({
    detectedKind,
    targetUrl: targetUrl.toString(),
    withHeadersRes,
    noHeadersRes,
    fetchWithRedirects,
  });

  const report: SourceTestReport = {
    slot: input.slot,
    label,
    url: targetUrl.toString(),
    detectedKind,
    noHeaders: noHeadersRes.diagnostic,
    withHeaders: withHeadersRes.diagnostic,
    ...classification,
    isExpirable: expirableCheck.isExpirable,
    expirableReason: expirableCheck.expirableReason,
    embedDiagnostic,
  };

  const isMirror = Boolean(input.isMirror || isVercelBlobUrl(targetUrl.toString()));
  if (!isMirror) {
    return report;
  }

  let originalSize =
    typeof input.originalContentLength === 'number' &&
    Number.isFinite(input.originalContentLength) &&
    input.originalContentLength > 0
      ? input.originalContentLength
      : null;

  if (originalSize === null && input.originalUrl?.trim()) {
    originalSize = await probeOriginalContentLength(input.originalUrl, fetchWithRedirects);
  }

  return applyMirrorIntegrityCheck(report, originalSize);
}

export async function diagnoseEpisodeSources(
  sources: SourceTestInput[],
  deps: SourceDiagnosticsDeps = {}
): Promise<SourceTestReport[]> {
  const validInputs = sources.filter((item) => item.url && item.url.trim().length > 0);
  const reports = await Promise.all(
    validInputs.map((item) => diagnoseVideoSource(item, deps))
  );

  let siblingOriginalLength: number | null = null;
  for (let i = 0; i < reports.length; i++) {
    const input = validInputs[i];
    const report = reports[i];
    const isMirror = Boolean(input.isMirror || isVercelBlobUrl(report.url));
    if (isMirror || report.detectedKind === 'iframe') continue;

    const candidateCt = report.withHeaders.contentType ?? report.noHeaders.contentType;
    const candidateLen = report.withHeaders.contentLength ?? report.noHeaders.contentLength;
    const isVideoLike =
      isVideoContentType(candidateCt) ||
      candidateCt?.toLowerCase().startsWith('application/octet-stream') === true ||
      report.detectedKind === 'mp4';

    if (
      isVideoLike &&
      typeof candidateLen === 'number' &&
      Number.isFinite(candidateLen) &&
      candidateLen > 0
    ) {
      siblingOriginalLength = candidateLen;
      break;
    }
  }

  if (siblingOriginalLength === null) {
    return reports;
  }

  return reports.map((report, idx) => {
    const input = validInputs[idx];
    const isMirror = Boolean(input.isMirror || isVercelBlobUrl(report.url));
    if (!isMirror) return report;
    return applyMirrorIntegrityCheck(report, siblingOriginalLength);
  });
}
