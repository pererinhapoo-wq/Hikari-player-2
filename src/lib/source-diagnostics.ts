import { resolveEmbedProxy } from '@/lib/embed-proxy';
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
    const firstLine = await readFirstLineSafely(response, contentType);
    if (response.status !== 200 && response.body) {
      try {
        await response.body.cancel();
      } catch {
        // Ignora erro ao descartar corpo
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
    };
  }
}

export function classifySourceDiagnostic(
  detectedKind: ExplicitSourceKind,
  noHeaders: SourceAttemptDiagnostic,
  withHeaders: SourceAttemptDiagnostic,
  targetOrigin: string,
  embedDiagnostic?: EmbedHostDiagnostic
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
      if (embedDiagnostic.embedProxyOk) {
        const strategyText =
          embedDiagnostic.successfulStrategy === 'chrome_ua_no_referer'
            ? 'UA Chrome sem Referer (fallback após 403)'
            : 'UA Chrome + Referer';
        const chainSummary =
          embedDiagnostic.redirectChain.length > 0
            ? embedDiagnostic.redirectChain
                .map((h) => `${h.host}:${h.status ?? 'erro'}`)
                .join(' -> ')
            : 'sem saltos';
        return {
          verdict: 'proxy_necessario',
          verdictLabel: 'proxy necessário',
          verdictReason: `Host exige /api/embed (fetch direto: ${directStatusText}; ${faText}; /api/embed: HTTP ${embedDiagnostic.embedProxyStatus} via ${strategyText}; saltos: ${chainSummary}).`,
        };
      }
      return {
        verdict: 'bloqueado',
        verdictLabel: 'bloqueado',
        verdictReason: `Host exige /api/embed, mas /api/embed falhou (${embedDiagnostic.embedProxyError ?? `HTTP ${embedDiagnostic.embedProxyStatus ?? 'erro'}`}). Fetch direto: ${directStatusText}; ${faText}.`,
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
  const urlCheck = validateHttpUrl(input.url);
  const detectedKind = detectSourceKind(input.url, input.kind);

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

  const classification = classifySourceDiagnostic(
    detectedKind,
    noHeadersRes.diagnostic,
    withHeadersRes.diagnostic,
    targetUrl.origin,
    embedDiagnostic
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
