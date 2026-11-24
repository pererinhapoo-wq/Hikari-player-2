import {
  CLOUDFLARE_SERVER_BLOCK_MESSAGE,
  formatEmbedAttemptSequence,
  isCloudflareBlockedBody,
  resolveEmbedProxy,
} from '@/lib/embed-proxy';
import { safeFetchWithRedirects } from '@/lib/ssrf';
import { BROWSER_UA, resolveUpstreamReferer } from '@/lib/stream-proxy';
import type {
  EmbedAuthStrategy,
  EmbedHostDiagnostic,
  EmbedRedirectHopDiagnostic,
  SourceAttemptDiagnostic,
  SourceTestReport,
  SourceTestVerdict,
} from '@/lib/types';
import {
  classifyEmbedHost,
  detectSourceKind,
  type ExplicitSourceKind,
  validateHttpUrl,
} from '@/lib/video-sources';
import { resolveVideoInputUrl } from '@/lib/r2-resolver';

export interface SourceTestInput {
  slot: 1 | 2 | 3 | 4 | 5;
  label?: string;
  url: string;
  kind?: ExplicitSourceKind | '' | null;
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

async function readFirstLineSafely(response: Response, contentType: string | null): Promise<string | null> {
  if (response.status !== 200) {
    return null;
  }

  const lowerCt = (contentType ?? '').toLowerCase();
  const isLikelyBinary =
    lowerCt.startsWith('video/') ||
    lowerCt.startsWith('audio/') ||
    lowerCt.startsWith('image/') ||
    lowerCt === 'application/octet-stream';

  try {
    let bytes: Uint8Array;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      const MAX_BYTES = 4096;
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
      bytes = buf.slice(0, 4096);
    }

    if (bytes.byteLength === 0) {
      return null;
    }

    // Se contém NUL byte ou sync MPEG-TS sem #EXTM3U, trata como binário
    if (isLikelyBinary && bytes[0] !== 0x23) {
      return `(binário: ${contentType || 'application/octet-stream'})`;
    }

    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (decoded.includes('\u0000')) {
      return `(binário: ${contentType || 'application/octet-stream'})`;
    }

    const firstLine = decoded
      .split(/\r?\n/)
      .map((line) => line.replace(/^\uFEFF/, '').trim())
      .find((line) => line.length > 0);

    if (!firstLine) return null;
    return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
  } catch {
    return null;
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

async function runSingleAttempt(
  url: string,
  headers: Record<string, string>,
  sentReferer: string | null,
  fetchWithRedirects: typeof safeFetchWithRedirects
): Promise<InternalAttemptResult> {
  try {
    const { response } = await fetchWithRedirects(url, {
      headers,
      timeoutMs: 12000,
    });
    const acao = response.headers.get('access-control-allow-origin');
    const contentType = response.headers.get('content-type');
    const cspHeader = response.headers.get('content-security-policy');
    const xFrameOptions = response.headers.get('x-frame-options');
    let firstLine: string | null = null;
    let cloudflareBlocked = false;

    if (response.status === 200) {
      firstLine = await readFirstLineSafely(response, contentType);
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
        sentReferer,
        error: null,
      },
      cspHeader,
      xFrameOptions,
      cloudflareBlocked,
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
        sentReferer,
        error: err instanceof Error ? err.message : 'Falha de rede ao consultar origem.',
      },
      cspHeader: null,
      xFrameOptions: null,
      cloudflareBlocked: false,
    };
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

  if (withHeaders.ok) {
    const acaoAllowsBrowser =
      withHeaders.hasAcao &&
      (withHeaders.accessControlAllowOrigin?.trim() === '*' ||
        withHeaders.accessControlAllowOrigin?.includes('vercel.app') === true);

    const requiredProviderReferer =
      Boolean(withHeaders.sentReferer) &&
      !withHeaders.sentReferer!.startsWith(targetOrigin) &&
      !noHeaders.ok;

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
  const urlCheck = validateHttpUrl(effectiveUrl);
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
  const mappedReferer = resolveUpstreamReferer(targetUrl);

  const noHeadersRes = await runSingleAttempt(
    targetUrl.toString(),
    {},
    null,
    fetchWithRedirects
  );

  const proxyHeaders: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
  };
  if (mappedReferer) {
    proxyHeaders['Referer'] = mappedReferer;
  }

  const withHeadersRes = await runSingleAttempt(
    targetUrl.toString(),
    proxyHeaders,
    mappedReferer || null,
    fetchWithRedirects
  );

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

  return {
    slot: input.slot,
    label,
    url: targetUrl.toString(),
    detectedKind,
    noHeaders: noHeadersRes.diagnostic,
    withHeaders: withHeadersRes.diagnostic,
    ...classification,
    embedDiagnostic,
  };
}

export async function diagnoseEpisodeSources(
  sources: SourceTestInput[],
  deps: SourceDiagnosticsDeps = {}
): Promise<SourceTestReport[]> {
  const validInputs = sources.filter((item) => item.url && item.url.trim().length > 0);
  return await Promise.all(validInputs.map((item) => diagnoseVideoSource(item, deps)));
}
