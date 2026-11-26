import { createServerFn } from '@tanstack/react-start';
import {
  deleteCookie,
  getCookie,
  getRequest,
  getRequestIP,
  setCookie,
  setResponseHeader,
} from '@tanstack/react-start/server';
import { formatEpisodeDisplayTitle } from '@/lib/anime-library';
import {
  ADMIN_SESSION_COOKIE_NAME,
  buildPublicEpisodeUrl,
  checkLoginRateLimit,
  clearLoginAttempts,
  createSessionToken,
  getPublicBaseUrl,
  isAuthEnvConfigured,
  recordFailedLogin,
  verifyAdminPassword,
  verifySessionToken,
} from '@/lib/auth';
import {
  type BatchItemReport,
  type BatchValidateDeps,
  type ParsedBatchLine,
  validateBatchIframeItem,
} from '@/lib/batch-import';
import {
  appendEpisodeIframeSource,
  createEpisode,
  DatabaseNotConfiguredError,
  deleteEpisode,
  diagnoseDatabaseConnection,
  getEpisodeById,
  isDatabaseConfigured,
  listEpisodes,
  type PlayerEpisode,
  sanitizeDiagnosticError,
  saveEpisodeImportedSource,
  updateEpisode,
} from '@/lib/db';
import { IMAGE_WIDTH_LIMITS, resizeImageUrlForWidth } from '@/lib/image-optimization';
import {
  buildSignedProxyPath,
  createProxyExpirableSignature,
  createProxyRefererSignature,
  createProxySignature,
  getStableProxyExpiry,
} from '@/lib/proxy-signing';
import { importSourceFromEpisodePage, type SiteImportDeps } from '@/lib/site-import';
import {
  diagnoseEpisodeSources,
  diagnoseVideoSource,
  type SourceTestInput,
} from '@/lib/source-diagnostics';
import { resolveUpstreamReferer } from '@/lib/stream-proxy';
import type {
  AdminDashboardState,
  DatabaseDiagnosticResult,
  EpisodeDto,
  EpisodeFormPayload,
  PlayableSource,
  PublicEpisodeResult,
  SiteImportFromPageResult,
  SourceTestReport,
} from '@/lib/types';
import { resolveThumbnailSourceForAdmin } from '@/lib/thumbnails';
import type { ThumbnailSourcePlan } from '@/lib/thumbnail-utils';
import {
  buildIframePlayUrl,
  collectEpisodeSources,
  type ExplicitSourceKind,
  isDirectMediaUrl,
  isR2StorageUrl,
  isVercelBlobUrl,
} from '@/lib/video-sources';

export function resolveProxyPlayUrl(
  targetUrl: string,
  workerBaseEnv = process.env.WORKER_BASE,
  nowSeconds = Math.floor(Date.now() / 1000),
  customReferer?: string | null
): string {
  const cleanRef = typeof customReferer === 'string' ? customReferer.trim() : '';
  const rawBase = workerBaseEnv?.trim();
  if (rawBase) {
    try {
      const parsed = new URL(rawBase);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const normalizedBase = parsed
          .toString()
          .replace(/\/+$/, '')
          .replace(/\/api\/proxy\/stream$/, '');
        const stableExp = getStableProxyExpiry(nowSeconds);
        const sig = createProxySignature(targetUrl, stableExp);
        const params = new URLSearchParams({
          url: targetUrl,
          exp: String(stableExp),
          sig,
        });
        if (cleanRef) {
          params.set('ref', cleanRef);
          params.set('rsig', createProxyRefererSignature(targetUrl, stableExp, cleanRef));
        }
        if (isR2StorageUrl(targetUrl)) {
          params.set('ex', '1');
          params.set('xsig', createProxyExpirableSignature(targetUrl, stableExp));
        }
        return `${normalizedBase}/api/proxy/stream?${params.toString()}`;
      }
    } catch {
      // WORKER_BASE inválida: mantém fallback para /api/proxy/stream na Vercel
    }
  }
  return buildSignedProxyPath(targetUrl, undefined, nowSeconds, 0, cleanRef || undefined);
}

function trySetResponseHeader(name: string, value: string): void {
  try {
    setResponseHeader(name, value);
  } catch {
    // Ignorado fora do contexto HTTP (ex.: testes unitários)
  }
}

function toEpisodeDto(ep: PlayerEpisode): EpisodeDto {
  return {
    ...ep,
    public_url: buildPublicEpisodeUrl(ep.id),
  };
}

function isRequestHttps(): boolean {
  try {
    const req = getRequest();
    const proto = req.headers.get('x-forwarded-proto') || new URL(req.url).protocol;
    return proto.includes('https');
  } catch {
    return process.env.NODE_ENV === 'production';
  }
}

function requireAdminSession(): void {
  const token = getCookie(ADMIN_SESSION_COOKIE_NAME);
  const session = verifySessionToken(token);
  if (!session) {
    throw new Error('Sessão administrativa expirada ou não autenticada.');
  }
}

export const getPublicEpisodeFn = createServerFn({ method: 'GET' })
  .validator((data: { id: string }) => ({ id: String(data?.id ?? '') }))
  .handler(async ({ data }): Promise<PublicEpisodeResult> => {
    trySetResponseHeader(
      'Cache-Control',
      'public, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400'
    );

    if (!isDatabaseConfigured()) {
      return { status: 'db_unconfigured' };
    }

    const episode = await getEpisodeById(data.id);
    if (!episode) {
      return { status: 'not_found' };
    }

    const forceProxyBySlot: Record<1 | 2 | 3 | 4 | 5, boolean | null> = {
      1: episode.force_proxy,
      2: episode.force_proxy_2,
      3: episode.force_proxy_3,
      4: episode.force_proxy_4,
      5: episode.force_proxy_5,
    };

    const sourceRefererBySlot: Record<1 | 2 | 3 | 4 | 5, string | null> = {
      1: episode.source_referer ?? null,
      2: episode.source_referer_2 ?? null,
      3: episode.source_referer_3 ?? null,
      4: episode.source_referer_4 ?? null,
      5: episode.source_referer_5 ?? null,
    };

    const normalizedSources = collectEpisodeSources(episode);
    const sources: PlayableSource[] = normalizedSources.map((src) => {
      const isMirrorSource = Boolean(
        src.isMirror || isDirectMediaUrl(src.resolvedUrl) || isVercelBlobUrl(src.resolvedUrl)
      );
      const shouldProxy =
        src.kind !== 'iframe' &&
        !src.requiresServerResolve &&
        !isMirrorSource &&
        forceProxyBySlot[src.slot] !== false &&
        src.needsProxy;
      let customRefererForProxy: string | null = null;
      if (shouldProxy && sourceRefererBySlot[src.slot]) {
        try {
          const defaultRef = resolveUpstreamReferer(new URL(src.resolvedUrl));
          if (sourceRefererBySlot[src.slot] !== defaultRef) {
            customRefererForProxy = sourceRefererBySlot[src.slot];
          }
        } catch {
          // Ignora URL inválida ao resolver referer
        }
      }
      const playUrl =
        src.kind === 'iframe'
          ? buildIframePlayUrl(src.resolvedUrl)
          : shouldProxy
            ? resolveProxyPlayUrl(src.resolvedUrl, undefined, undefined, customRefererForProxy)
            : src.resolvedUrl;
      return {
        ...src,
        isMirror: isMirrorSource,
        needsProxy: shouldProxy,
        playUrl,
      };
    });

    return {
      status: 'ok',
      episode: {
        id: episode.id,
        title: formatEpisodeDisplayTitle(episode),
        poster_url: resizeImageUrlForWidth(episode.poster_url, IMAGE_WIDTH_LIMITS.banner),
        opening_start_seconds: episode.opening_start_seconds,
        opening_end_seconds: episode.opening_end_seconds,
        sources,
      },
    };
  });

export const getAdminDashboardFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminDashboardState> => {
    trySetResponseHeader('Cache-Control', 'private, no-store');

    const authEnv = isAuthEnvConfigured();
    const databaseConfigured = isDatabaseConfigured();
    const publicBaseUrl = getPublicBaseUrl();

    const token = getCookie(ADMIN_SESSION_COOKIE_NAME);
    const authenticated = Boolean(verifySessionToken(token));

    if (!authenticated) {
      return {
        authenticated: false,
        databaseConfigured,
        authConfigured: authEnv.ready,
        passwordConfigured: authEnv.passwordConfigured,
        secretConfigured: authEnv.secretConfigured,
        publicBaseUrl,
        episodes: [],
      };
    }

    if (!databaseConfigured) {
      return {
        authenticated: true,
        databaseConfigured: false,
        authConfigured: authEnv.ready,
        passwordConfigured: authEnv.passwordConfigured,
        secretConfigured: authEnv.secretConfigured,
        publicBaseUrl,
        episodes: [],
      };
    }

    try {
      const episodes = await listEpisodes();
      return {
        authenticated: true,
        databaseConfigured: true,
        authConfigured: authEnv.ready,
        passwordConfigured: authEnv.passwordConfigured,
        secretConfigured: authEnv.secretConfigured,
        publicBaseUrl,
        episodes: episodes.map(toEpisodeDto),
      };
    } catch (err) {
      let message: string;
      if (err instanceof DatabaseNotConfiguredError) {
        message = err.message;
      } else {
        const sanitized = sanitizeDiagnosticError(err);
        const codeTag = sanitized.code ? ` [${sanitized.code}]` : '';
        message = `Erro ao consultar episódios no banco Neon (${sanitized.name}${codeTag}): ${sanitized.message}`;
      }
      return {
        authenticated: true,
        databaseConfigured: true,
        authConfigured: authEnv.ready,
        passwordConfigured: authEnv.passwordConfigured,
        secretConfigured: authEnv.secretConfigured,
        publicBaseUrl,
        episodes: [],
        errorMessage: message,
      };
    }
  }
);

export const adminLoginFn = createServerFn({ method: 'POST' })
  .validator((data: { password: string }) => ({
    password: typeof data?.password === 'string' ? data.password : '',
  }))
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const authEnv = isAuthEnvConfigured();
    if (!authEnv.passwordConfigured) {
      return {
        ok: false,
        error: 'PLAYER_ADMIN_PASSWORD não está configurada no servidor.',
      };
    }
    if (!authEnv.ready) {
      return {
        ok: false,
        error: 'PLAYER_SESSION_SECRET (mínimo 16 caracteres) é obrigatória em produção.',
      };
    }

    const clientIp = getRequestIP({ xForwardedFor: true }) ?? 'local';
    const rate = checkLoginRateLimit(clientIp);
    if (!rate.allowed) {
      return {
        ok: false,
        error: `Muitas tentativas inválidas. Aguarde ${rate.retryAfterSeconds ?? 60} segundos.`,
      };
    }

    if (!verifyAdminPassword(data.password)) {
      recordFailedLogin(clientIp);
      return {
        ok: false,
        error: 'Senha administrativa incorreta.',
      };
    }

    clearLoginAttempts(clientIp);
    const token = createSessionToken();
    const secure = process.env.NODE_ENV === 'production' || isRequestHttps();

    setCookie(ADMIN_SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
      secure,
    });

    return { ok: true };
  });

export const adminLogoutFn = createServerFn({ method: 'POST' }).handler(async () => {
  deleteCookie(ADMIN_SESSION_COOKIE_NAME, { path: '/' });
  return { ok: true };
});

export const adminCreateEpisodeFn = createServerFn({ method: 'POST' })
  .validator((data: EpisodeFormPayload) => data)
  .handler(async ({ data }): Promise<{ ok: true; episode: EpisodeDto } | { ok: false; error: string }> => {
    try {
      requireAdminSession();
      const created = await createEpisode(data);
      return { ok: true, episode: toEpisodeDto(created) };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Falha ao cadastrar episódio.',
      };
    }
  });

export const adminUpdateEpisodeFn = createServerFn({ method: 'POST' })
  .validator((data: { id: string } & EpisodeFormPayload) => data)
  .handler(async ({ data }): Promise<{ ok: true; episode: EpisodeDto } | { ok: false; error: string }> => {
    try {
      requireAdminSession();
      const { id, ...payload } = data;
      const updated = await updateEpisode(id, payload);
      if (!updated) {
        return { ok: false, error: 'Episódio não encontrado.' };
      }
      return { ok: true, episode: toEpisodeDto(updated) };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Falha ao atualizar episódio.',
      };
    }
  });

export const adminDeleteEpisodeFn = createServerFn({ method: 'POST' })
  .validator((data: { id: string }) => ({ id: String(data?.id ?? '') }))
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      requireAdminSession();
      const deleted = await deleteEpisode(data.id);
      if (!deleted) {
        return { ok: false, error: 'Episódio não encontrado.' };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Falha ao excluir episódio.',
      };
    }
  });

export const adminDiagnoseDatabaseFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<
    { ok: true; diagnostic: DatabaseDiagnosticResult } | { ok: false; error: string }
  > => {
    try {
      requireAdminSession();
      const diagnostic = await diagnoseDatabaseConnection();
      return { ok: true, diagnostic };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : 'Sessão administrativa expirada ou não autenticada.',
      };
    }
  }
);

export const adminTestSourceFn = createServerFn({ method: 'POST' })
  .validator(
    (data: {
      slot?: number;
      label?: string;
      url: string;
      kind?: ExplicitSourceKind | '' | null;
      sourceReferer?: string | null;
      isMirror?: boolean;
      originalContentLength?: number | null;
      originalUrl?: string | null;
    }) => ({
      slot: ([1, 2, 3, 4, 5].includes(Number(data?.slot)) ? Number(data?.slot) : 1) as
        | 1
        | 2
        | 3
        | 4
        | 5,
      label: typeof data?.label === 'string' ? data.label : undefined,
      url: typeof data?.url === 'string' ? data.url : '',
      kind: data?.kind ?? null,
      sourceReferer: typeof data?.sourceReferer === 'string' ? data.sourceReferer : null,
      isMirror: typeof data?.isMirror === 'boolean' ? data.isMirror : undefined,
      originalContentLength:
        typeof data?.originalContentLength === 'number' &&
        Number.isFinite(data.originalContentLength)
          ? data.originalContentLength
          : null,
      originalUrl: typeof data?.originalUrl === 'string' ? data.originalUrl : null,
    })
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; report: SourceTestReport } | { ok: false; error: string }> => {
      try {
        requireAdminSession();
        const report = await diagnoseVideoSource(data);
        return { ok: true, report };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error ? err.message : 'Falha ao testar fonte no servidor.',
        };
      }
    }
  );

export const adminTestEpisodeSourcesFn = createServerFn({ method: 'POST' })
  .validator((data: { sources: SourceTestInput[] }) => ({
    sources: Array.isArray(data?.sources) ? data.sources : [],
  }))
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; reports: SourceTestReport[] } | { ok: false; error: string }> => {
      try {
        requireAdminSession();
        const reports = await diagnoseEpisodeSources(data.sources);
        return { ok: true, reports };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Falha ao testar fontes do episódio no servidor.',
        };
      }
    }
  );

export interface ProcessBatchItemInput extends ParsedBatchLine {
  save: boolean;
}

export interface ProcessBatchItemDeps {
  validateDeps?: BatchValidateDeps;
  saveSource?: (
    episodeId: string,
    normalizedUrl: string
  ) => Promise<{ saved: boolean; slot: 1 | 2 | 3 | 4 | 5 | null; reason: string }>;
}

export async function processBatchItemServer(
  input: ProcessBatchItemInput,
  deps: ProcessBatchItemDeps = {}
): Promise<BatchItemReport> {
  const validation = await validateBatchIframeItem(input, deps.validateDeps);

  if (validation.verdict !== 'aprovado' || !validation.normalizedUrl) {
    return {
      lineNumber: input.lineNumber,
      episodeId: input.episodeId,
      url: input.url,
      explicitKind: input.explicitKind,
      verdict: 'reprovado',
      saveStatus: 'skipado',
      savedSlot: null,
      reason: validation.reason,
    };
  }

  if (!input.save) {
    return {
      lineNumber: input.lineNumber,
      episodeId: input.episodeId,
      url: validation.normalizedUrl,
      explicitKind: input.explicitKind,
      verdict: 'aprovado',
      saveStatus: 'skipado',
      savedSlot: null,
      reason: validation.reason,
    };
  }

  const saver =
    deps.saveSource ??
    (async (episodeId: string, normalizedUrl: string) => {
      if (!isDatabaseConfigured()) {
        return {
          saved: false,
          slot: null,
          reason: 'DATABASE_URL não configurada no servidor.',
        };
      }
      return await appendEpisodeIframeSource(episodeId, normalizedUrl);
    });

  const saveRes = await saver(input.episodeId, validation.normalizedUrl);

  return {
    lineNumber: input.lineNumber,
    episodeId: input.episodeId,
    url: validation.normalizedUrl,
    explicitKind: input.explicitKind,
    verdict: 'aprovado',
    saveStatus: saveRes.saved ? 'salvo' : 'skipado',
    savedSlot: saveRes.slot,
    reason: `${validation.reason} ${saveRes.reason}`,
  };
}

export const adminProcessBatchItemFn = createServerFn({ method: 'POST' })
  .validator((data: ProcessBatchItemInput) => ({
    lineNumber: Number(data?.lineNumber) || 0,
    rawLine: typeof data?.rawLine === 'string' ? data.rawLine : '',
    episodeId: typeof data?.episodeId === 'string' ? data.episodeId : '',
    url: typeof data?.url === 'string' ? data.url : '',
    explicitKind:
      data?.explicitKind === 'iframe' ||
      data?.explicitKind === 'hls' ||
      data?.explicitKind === 'mp4'
        ? data.explicitKind
        : null,
    parseError: typeof data?.parseError === 'string' ? data.parseError : null,
    save: Boolean(data?.save),
  }))
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; report: BatchItemReport } | { ok: false; error: string }> => {
      try {
        requireAdminSession();
        const report = await processBatchItemServer(data);
        return { ok: true, report };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Falha ao processar item do lote no servidor.',
        };
      }
    }
  );

export const adminResolveThumbnailSourceFn = createServerFn({ method: 'POST' })
  .validator(
    (data: {
      episodeId?: string | null;
      videoUrl?: string | null;
      sourceKind?: ExplicitSourceKind | '' | null;
    }) => ({
      episodeId: typeof data?.episodeId === 'string' ? data.episodeId : null,
      videoUrl: typeof data?.videoUrl === 'string' ? data.videoUrl : null,
      sourceKind:
        data?.sourceKind === 'iframe' ||
        data?.sourceKind === 'hls' ||
        data?.sourceKind === 'mp4'
          ? data.sourceKind
          : null,
    })
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; plan: ThumbnailSourcePlan } | { ok: false; error: string }> => {
      try {
        requireAdminSession();
        const plan = await resolveThumbnailSourceForAdmin(data);
        return { ok: true, plan };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Falha ao preparar fonte de vídeo para gerar thumbnails.',
        };
      }
    }
  );

export async function processSiteImportServer(
  input: {
    pageUrl: string;
    episodeId?: string | null;
    targetSlot?: 1 | 2 | 3 | 4 | 5 | null;
  },
  deps: {
    importDeps?: SiteImportDeps;
    saveSource?: typeof saveEpisodeImportedSource;
    isDbConfigured?: typeof isDatabaseConfigured;
  } = {}
): Promise<SiteImportFromPageResult> {
  const importRes = await importSourceFromEpisodePage(input.pageUrl, deps.importDeps);
  if (!importRes.ok) {
    return {
      ok: false,
      error: importRes.error,
      candidates: importRes.candidates,
    };
  }

  let saved = false;
  let savedEpisode: EpisodeDto | undefined;
  let savedSlot: 1 | 2 | 3 | 4 | 5 | undefined;

  if (input.episodeId?.trim()) {
    const checkDb = deps.isDbConfigured ?? isDatabaseConfigured;
    if (!checkDb()) {
      return {
        ok: false,
        error: 'DATABASE_URL não configurada no servidor.',
        candidates: importRes.candidates,
      };
    }

    const saveSource = deps.saveSource ?? saveEpisodeImportedSource;
    const savedResult = await saveSource(input.episodeId.trim(), {
      videoUrl: importRes.selected.url,
      sourceKind: importRes.selected.kind,
      forceProxy: true,
      sourceReferer: importRes.selected.hostReferer || null,
      targetSlot: input.targetSlot ?? undefined,
    });
    saved = true;
    savedEpisode = toEpisodeDto(savedResult.episode);
    savedSlot = savedResult.slot;
  }

  const reportSlot = savedSlot ?? input.targetSlot ?? 1;
  const testReport = await diagnoseVideoSource({
    slot: reportSlot,
    label: `Player ${reportSlot}`,
    url: importRes.selected.url,
    kind: importRes.selected.kind,
    sourceReferer: importRes.selected.hostReferer || null,
  });

  const isExpirable = Boolean(importRes.selected.isExpirable || testReport.isExpirable);
  const expirableReason =
    importRes.selected.expirableReason ?? testReport.expirableReason ?? null;

  return {
    ok: true,
    saved,
    episode: savedEpisode,
    slot: savedSlot,
    selected: {
      ...importRes.selected,
      isExpirable,
      expirableReason,
    },
    extractedTitle: importRes.extractedTitle,
    extractedPoster: importRes.extractedPoster,
    candidates: importRes.candidates,
    testReport: {
      ...testReport,
      isExpirable,
      expirableReason,
    },
  };
}

export const adminImportFromSiteFn = createServerFn({ method: 'POST' })
  .validator(
    (data: {
      pageUrl: string;
      episodeId?: string | null;
      targetSlot?: number | null;
    }) => ({
      pageUrl: typeof data?.pageUrl === 'string' ? data.pageUrl : '',
      episodeId: typeof data?.episodeId === 'string' ? data.episodeId : null,
      targetSlot: [1, 2, 3, 4, 5].includes(Number(data?.targetSlot))
        ? (Number(data?.targetSlot) as 1 | 2 | 3 | 4 | 5)
        : null,
    })
  )
  .handler(async ({ data }): Promise<SiteImportFromPageResult> => {
    try {
      requireAdminSession();
      return await processSiteImportServer(data);
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : 'Falha ao importar fonte da página no servidor.',
        candidates: [],
      };
    }
  });

