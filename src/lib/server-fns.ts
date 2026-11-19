import { createServerFn } from '@tanstack/react-start';
import {
  deleteCookie,
  getCookie,
  getRequest,
  getRequestIP,
  setCookie,
} from '@tanstack/react-start/server';
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
  createEpisode,
  DatabaseNotConfiguredError,
  deleteEpisode,
  diagnoseDatabaseConnection,
  getEpisodeById,
  isDatabaseConfigured,
  listEpisodes,
  type PlayerEpisode,
  sanitizeDiagnosticError,
  updateEpisode,
} from '@/lib/db';
import { buildSignedProxyPath, createProxySignature } from '@/lib/proxy-signing';
import type {
  AdminDashboardState,
  DatabaseDiagnosticResult,
  EpisodeDto,
  EpisodeFormPayload,
  PlayableSource,
  PublicEpisodeResult,
} from '@/lib/types';
import { collectEpisodeSources } from '@/lib/video-sources';

const WORKER_EXP_BUCKET_SECONDS = 60 * 60 * 6; // Janela de 6h para chave de cache estável no Worker

export function resolveProxyPlayUrl(
  targetUrl: string,
  workerBaseEnv = process.env.WORKER_BASE
): string {
  const rawBase = workerBaseEnv?.trim();
  if (rawBase) {
    try {
      const parsed = new URL(rawBase);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const normalizedBase = parsed
          .toString()
          .replace(/\/+$/, '')
          .replace(/\/api\/proxy\/stream$/, '');
        const nowSeconds = Math.floor(Date.now() / 1000);
        const stableExp =
          (Math.floor(nowSeconds / WORKER_EXP_BUCKET_SECONDS) + 2) * WORKER_EXP_BUCKET_SECONDS;
        const sig = createProxySignature(targetUrl, stableExp);
        const params = new URLSearchParams({
          url: targetUrl,
          exp: String(stableExp),
          sig,
        });
        return `${normalizedBase}/api/proxy/stream?${params.toString()}`;
      }
    } catch {
      // WORKER_BASE inválida: mantém fallback para /api/proxy/stream na Vercel
    }
  }
  return buildSignedProxyPath(targetUrl);
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
    if (!isDatabaseConfigured()) {
      return { status: 'db_unconfigured' };
    }

    const episode = await getEpisodeById(data.id);
    if (!episode) {
      return { status: 'not_found' };
    }

    const normalizedSources = collectEpisodeSources(episode);
    const sources: PlayableSource[] = normalizedSources.map((src) => ({
      ...src,
      playUrl: src.needsProxy ? resolveProxyPlayUrl(src.resolvedUrl) : src.resolvedUrl,
    }));

    return {
      status: 'ok',
      episode: {
        id: episode.id,
        title: episode.title,
        poster_url: episode.poster_url,
        sources,
      },
    };
  });

export const getAdminDashboardFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminDashboardState> => {
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

