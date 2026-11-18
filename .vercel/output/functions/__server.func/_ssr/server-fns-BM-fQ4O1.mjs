import { TSS_SERVER_FUNCTION, createServerFn, deleteCookie, getCookie, getRequest, getRequestIP, setCookie } from "./ssr.mjs";
import { buildSignedProxyPath, collectEpisodeSources, getSessionSecret, validateHttpUrl } from "./video-sources-BYrFRAqI.mjs";
import { ps } from "../_libs/neondatabase__serverless.mjs";
import crypto from "node:crypto";
// node_modules/.nitro/vite/services/ssr/assets/server-fns-BM-fQ4O1.js
var createServerRpc = (serverFnMeta, splitImportFn) => {
	const url = "/_serverFn/" + serverFnMeta.id;
	return Object.assign(splitImportFn, {
		url,
		serverFnMeta,
		[TSS_SERVER_FUNCTION]: true
	});
};
var ADMIN_SESSION_COOKIE_NAME = "player_admin_session";
var SESSION_TTL_SECONDS = 604800;
var MAX_ATTEMPTS_WINDOW_MS = 6e5;
var MAX_FAILED_ATTEMPTS = 8;
var failedAttempts = /* @__PURE__ */ new Map();
function isAuthEnvConfigured() {
	const passwordConfigured = Boolean(process.env.PLAYER_ADMIN_PASSWORD?.trim());
	return {
		passwordConfigured,
		secretConfigured: (process.env.PLAYER_SESSION_SECRET?.trim().length ?? 0) >= 16,
		ready: passwordConfigured && true
	};
}
function verifyAdminPassword(candidatePassword) {
	const expectedPassword = process.env.PLAYER_ADMIN_PASSWORD;
	if (!expectedPassword || !candidatePassword) return false;
	const candidateDigest = crypto.createHash("sha256").update(candidatePassword, "utf8").digest();
	const expectedDigest = crypto.createHash("sha256").update(expectedPassword, "utf8").digest();
	return crypto.timingSafeEqual(candidateDigest, expectedDigest);
}
function createSessionToken(nowSeconds = Math.floor(Date.now() / 1e3)) {
	const payload = {
		sub: "admin",
		iat: nowSeconds,
		exp: nowSeconds + SESSION_TTL_SECONDS
	};
	const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	return `${encodedPayload}.${crypto.createHmac("sha256", getSessionSecret()).update(encodedPayload).digest("base64url")}`;
}
function verifySessionToken(token, nowSeconds = Math.floor(Date.now() / 1e3)) {
	if (!token || typeof token !== "string") return null;
	const parts = token.split(".");
	if (parts.length !== 2) return null;
	const [encodedPayload, signature] = parts;
	if (!encodedPayload || !signature) return null;
	let expectedSignature;
	try {
		expectedSignature = crypto.createHmac("sha256", getSessionSecret()).update(encodedPayload).digest("base64url");
	} catch {
		return null;
	}
	const sigBuf = Buffer.from(signature, "utf8");
	const expectedBuf = Buffer.from(expectedSignature, "utf8");
	if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
	try {
		const parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
		if (parsed.sub !== "admin" || typeof parsed.exp !== "number" || typeof parsed.iat !== "number" || parsed.exp <= nowSeconds) return null;
		return parsed;
	} catch {
		return null;
	}
}
function checkLoginRateLimit(clientKey) {
	const entry = failedAttempts.get(clientKey);
	if (!entry) return { allowed: true };
	const elapsed = Date.now() - entry.firstAt;
	if (elapsed > MAX_ATTEMPTS_WINDOW_MS) {
		failedAttempts.delete(clientKey);
		return { allowed: true };
	}
	if (entry.count >= MAX_FAILED_ATTEMPTS) return {
		allowed: false,
		retryAfterSeconds: Math.ceil((MAX_ATTEMPTS_WINDOW_MS - elapsed) / 1e3)
	};
	return { allowed: true };
}
function recordFailedLogin(clientKey) {
	const now = Date.now();
	const entry = failedAttempts.get(clientKey);
	if (!entry || now - entry.firstAt > MAX_ATTEMPTS_WINDOW_MS) {
		failedAttempts.set(clientKey, {
			count: 1,
			firstAt: now
		});
		return;
	}
	entry.count += 1;
}
function clearLoginAttempts(clientKey) {
	failedAttempts.delete(clientKey);
}
function getPublicBaseUrl() {
	const configured = process.env.PLAYER_PUBLIC_BASE_URL?.trim();
	if (configured) try {
		const url = new URL(configured);
		if (url.protocol === "http:" || url.protocol === "https:") return url.toString().replace(/\/+$/, "");
	} catch {}
	const appUrl = process.env.APP_URL?.trim();
	if (appUrl) try {
		const url = new URL(appUrl);
		if (url.protocol === "http:" || url.protocol === "https:") return url.toString().replace(/\/+$/, "");
	} catch {}
	return "http://localhost:3000";
}
function buildPublicEpisodeUrl(episodeId) {
	return `${getPublicBaseUrl()}/e/${encodeURIComponent(episodeId)}`;
}
var DatabaseNotConfiguredError = class extends Error {
	constructor() {
		super("DATABASE_URL do Neon não está configurada no ambiente do servidor.");
		this.name = "DatabaseNotConfiguredError";
	}
};
function isDatabaseConfigured() {
	const url = process.env.DATABASE_URL?.trim();
	return Boolean(url && url.startsWith("postgres"));
}
function getSql() {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) throw new DatabaseNotConfiguredError();
	return ps(databaseUrl);
}
var ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
function generateEpisodeId(length = 21) {
	const bytes = crypto.randomBytes(length);
	let id = "";
	for (let i = 0; i < length; i++) id += ID_ALPHABET[bytes[i] % 64];
	return id;
}
function sanitizeEpisodeInput(input) {
	const title = input.title?.trim() ?? "";
	if (!title || title.length > 200) throw new Error("O título do episódio é obrigatório (máximo 200 caracteres).");
	const posterCheck = validateHttpUrl(input.poster_url ?? "");
	if (!posterCheck.valid || !posterCheck.normalizedUrl) throw new Error(`Imagem de capa inválida: ${posterCheck.error}`);
	const primaryCheck = validateHttpUrl(input.video_url ?? "");
	if (!primaryCheck.valid || !primaryCheck.normalizedUrl) throw new Error(`Player 1 inválido: ${primaryCheck.error}`);
	const optionalSlots = [
		["video_url_2", "Player 2"],
		["video_url_3", "Player 3"],
		["video_url_4", "Player 4"],
		["video_url_5", "Player 5"]
	];
	const sanitizedOptional = {};
	for (const [key, label] of optionalSlots) {
		const raw = input[key];
		if (!raw || !raw.trim()) {
			sanitizedOptional[key] = null;
			continue;
		}
		const check = validateHttpUrl(raw);
		if (!check.valid || !check.normalizedUrl) throw new Error(`${label} inválido: ${check.error}`);
		sanitizedOptional[key] = check.normalizedUrl;
	}
	return {
		title,
		poster_url: posterCheck.normalizedUrl,
		video_url: primaryCheck.normalizedUrl,
		video_url_2: sanitizedOptional.video_url_2,
		video_url_3: sanitizedOptional.video_url_3,
		video_url_4: sanitizedOptional.video_url_4,
		video_url_5: sanitizedOptional.video_url_5
	};
}
function mapEpisodeRow(row) {
	return {
		id: String(row.id),
		title: String(row.title),
		poster_url: String(row.poster_url),
		video_url: String(row.video_url),
		video_url_2: row.video_url_2 ? String(row.video_url_2) : null,
		video_url_3: row.video_url_3 ? String(row.video_url_3) : null,
		video_url_4: row.video_url_4 ? String(row.video_url_4) : null,
		video_url_5: row.video_url_5 ? String(row.video_url_5) : null,
		created_at: new Date(String(row.created_at)).toISOString(),
		updated_at: new Date(String(row.updated_at)).toISOString()
	};
}
async function listEpisodes() {
	return (await getSql()`
    SELECT id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5, created_at, updated_at
    FROM player_episodes
    ORDER BY created_at DESC
  `).map(mapEpisodeRow);
}
async function getEpisodeById(id) {
	const cleanId = id.trim();
	if (!cleanId || cleanId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cleanId)) return null;
	const row = (await getSql()`
    SELECT id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5, created_at, updated_at
    FROM player_episodes
    WHERE id = ${cleanId}
    LIMIT 1
  `)[0];
	return row ? mapEpisodeRow(row) : null;
}
async function createEpisode(rawInput) {
	const input = sanitizeEpisodeInput(rawInput);
	const id = generateEpisodeId();
	return mapEpisodeRow((await getSql()`
    INSERT INTO player_episodes (
      id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5
    ) VALUES (
      ${id},
      ${input.title},
      ${input.poster_url},
      ${input.video_url},
      ${input.video_url_2 ?? null},
      ${input.video_url_3 ?? null},
      ${input.video_url_4 ?? null},
      ${input.video_url_5 ?? null}
    )
    RETURNING id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5, created_at, updated_at
  `)[0]);
}
async function updateEpisode(id, rawInput) {
	const cleanId = id.trim();
	if (!cleanId || !/^[A-Za-z0-9_-]+$/.test(cleanId)) return null;
	const input = sanitizeEpisodeInput(rawInput);
	const row = (await getSql()`
    UPDATE player_episodes
    SET
      title = ${input.title},
      poster_url = ${input.poster_url},
      video_url = ${input.video_url},
      video_url_2 = ${input.video_url_2 ?? null},
      video_url_3 = ${input.video_url_3 ?? null},
      video_url_4 = ${input.video_url_4 ?? null},
      video_url_5 = ${input.video_url_5 ?? null},
      updated_at = NOW()
    WHERE id = ${cleanId}
    RETURNING id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5, created_at, updated_at
  `)[0];
	return row ? mapEpisodeRow(row) : null;
}
async function deleteEpisode(id) {
	const cleanId = id.trim();
	if (!cleanId || !/^[A-Za-z0-9_-]+$/.test(cleanId)) return false;
	return (await getSql()`
    DELETE FROM player_episodes
    WHERE id = ${cleanId}
    RETURNING id
  `).length > 0;
}
function toEpisodeDto(ep) {
	return {
		...ep,
		public_url: buildPublicEpisodeUrl(ep.id)
	};
}
function isRequestHttps() {
	try {
		const req = getRequest();
		return (req.headers.get("x-forwarded-proto") || new URL(req.url).protocol).includes("https");
	} catch {
		return false;
	}
}
function requireAdminSession() {
	if (!verifySessionToken(getCookie(ADMIN_SESSION_COOKIE_NAME))) throw new Error("Sessão administrativa expirada ou não autenticada.");
}
var getPublicEpisodeFn_createServerFn_handler = createServerRpc({
	id: "9afb2c20fee236aa1debe74ee97b74db22d869606c6c818b33de6510e63e416b",
	name: "getPublicEpisodeFn",
	filename: "src/lib/server-fns.ts"
}, (opts) => getPublicEpisodeFn.__executeServer(opts));
var getPublicEpisodeFn = createServerFn({ method: "GET" }).validator((data) => ({ id: String(data?.id ?? "") })).handler(getPublicEpisodeFn_createServerFn_handler, async ({ data }) => {
	if (!isDatabaseConfigured()) return { status: "db_unconfigured" };
	const episode = await getEpisodeById(data.id);
	if (!episode) return { status: "not_found" };
	const sources = collectEpisodeSources(episode).map((src) => ({
		...src,
		playUrl: src.needsProxy ? buildSignedProxyPath(src.resolvedUrl) : src.resolvedUrl
	}));
	return {
		status: "ok",
		episode: {
			id: episode.id,
			title: episode.title,
			poster_url: episode.poster_url,
			sources
		}
	};
});
var getAdminDashboardFn_createServerFn_handler = createServerRpc({
	id: "04581ec28f318041978d3b4c9817cba3ff404f66e72e8a198a212c523fcc81cb",
	name: "getAdminDashboardFn",
	filename: "src/lib/server-fns.ts"
}, (opts) => getAdminDashboardFn.__executeServer(opts));
var getAdminDashboardFn = createServerFn({ method: "GET" }).handler(getAdminDashboardFn_createServerFn_handler, async () => {
	const authEnv = isAuthEnvConfigured();
	const databaseConfigured = isDatabaseConfigured();
	const publicBaseUrl = getPublicBaseUrl();
	const token = getCookie(ADMIN_SESSION_COOKIE_NAME);
	if (!Boolean(verifySessionToken(token))) return {
		authenticated: false,
		databaseConfigured,
		authConfigured: authEnv.ready,
		passwordConfigured: authEnv.passwordConfigured,
		secretConfigured: authEnv.secretConfigured,
		publicBaseUrl,
		episodes: []
	};
	if (!databaseConfigured) return {
		authenticated: true,
		databaseConfigured: false,
		authConfigured: authEnv.ready,
		passwordConfigured: authEnv.passwordConfigured,
		secretConfigured: authEnv.secretConfigured,
		publicBaseUrl,
		episodes: []
	};
	try {
		const episodes = await listEpisodes();
		return {
			authenticated: true,
			databaseConfigured: true,
			authConfigured: authEnv.ready,
			passwordConfigured: authEnv.passwordConfigured,
			secretConfigured: authEnv.secretConfigured,
			publicBaseUrl,
			episodes: episodes.map(toEpisodeDto)
		};
	} catch (err) {
		const message = err instanceof DatabaseNotConfiguredError ? err.message : "Erro ao consultar episódios no banco Neon. Verifique se a migration 0001_player_episodes.sql foi aplicada.";
		return {
			authenticated: true,
			databaseConfigured: true,
			authConfigured: authEnv.ready,
			passwordConfigured: authEnv.passwordConfigured,
			secretConfigured: authEnv.secretConfigured,
			publicBaseUrl,
			episodes: [],
			errorMessage: message
		};
	}
});
var adminLoginFn_createServerFn_handler = createServerRpc({
	id: "030c93b1e3db6c41ff78e464f4859d6380421ed77e2854ab8ac0dd1963f6b3a9",
	name: "adminLoginFn",
	filename: "src/lib/server-fns.ts"
}, (opts) => adminLoginFn.__executeServer(opts));
var adminLoginFn = createServerFn({ method: "POST" }).validator((data) => ({ password: typeof data?.password === "string" ? data.password : "" })).handler(adminLoginFn_createServerFn_handler, async ({ data }) => {
	const authEnv = isAuthEnvConfigured();
	if (!authEnv.passwordConfigured) return {
		ok: false,
		error: "PLAYER_ADMIN_PASSWORD não está configurada no servidor."
	};
	if (!authEnv.ready) return {
		ok: false,
		error: "PLAYER_SESSION_SECRET (mínimo 16 caracteres) é obrigatória em produção."
	};
	const clientIp = getRequestIP({ xForwardedFor: true }) ?? "local";
	const rate = checkLoginRateLimit(clientIp);
	if (!rate.allowed) return {
		ok: false,
		error: `Muitas tentativas inválidas. Aguarde ${rate.retryAfterSeconds ?? 60} segundos.`
	};
	if (!verifyAdminPassword(data.password)) {
		recordFailedLogin(clientIp);
		return {
			ok: false,
			error: "Senha administrativa incorreta."
		};
	}
	clearLoginAttempts(clientIp);
	const token = createSessionToken();
	const secure = isRequestHttps();
	setCookie(ADMIN_SESSION_COOKIE_NAME, token, {
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		maxAge: 604800,
		secure
	});
	return { ok: true };
});
var adminLogoutFn_createServerFn_handler = createServerRpc({
	id: "faeb3013da07d6b989b66ac73705d7399f1298ee2a5a7109c90650f53e1f994f",
	name: "adminLogoutFn",
	filename: "src/lib/server-fns.ts"
}, (opts) => adminLogoutFn.__executeServer(opts));
var adminLogoutFn = createServerFn({ method: "POST" }).handler(adminLogoutFn_createServerFn_handler, async () => {
	deleteCookie(ADMIN_SESSION_COOKIE_NAME, { path: "/" });
	return { ok: true };
});
var adminCreateEpisodeFn_createServerFn_handler = createServerRpc({
	id: "d3613d554797e17663a8e3bd4394a4766d9bf015979c64e1c6ca019971631c48",
	name: "adminCreateEpisodeFn",
	filename: "src/lib/server-fns.ts"
}, (opts) => adminCreateEpisodeFn.__executeServer(opts));
var adminCreateEpisodeFn = createServerFn({ method: "POST" }).validator((data) => data).handler(adminCreateEpisodeFn_createServerFn_handler, async ({ data }) => {
	try {
		requireAdminSession();
		return {
			ok: true,
			episode: toEpisodeDto(await createEpisode(data))
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Falha ao cadastrar episódio."
		};
	}
});
var adminUpdateEpisodeFn_createServerFn_handler = createServerRpc({
	id: "6b9298c225d12818805fe4834a8e33421be87c5d01e0e16a06f74c6d66552f5e",
	name: "adminUpdateEpisodeFn",
	filename: "src/lib/server-fns.ts"
}, (opts) => adminUpdateEpisodeFn.__executeServer(opts));
var adminUpdateEpisodeFn = createServerFn({ method: "POST" }).validator((data) => data).handler(adminUpdateEpisodeFn_createServerFn_handler, async ({ data }) => {
	try {
		requireAdminSession();
		const { id, ...payload } = data;
		const updated = await updateEpisode(id, payload);
		if (!updated) return {
			ok: false,
			error: "Episódio não encontrado."
		};
		return {
			ok: true,
			episode: toEpisodeDto(updated)
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Falha ao atualizar episódio."
		};
	}
});
var adminDeleteEpisodeFn_createServerFn_handler = createServerRpc({
	id: "5b34c4f06bef994047f2a046c73892d61809f3a1ce34cc45e4cf90f8137d054e",
	name: "adminDeleteEpisodeFn",
	filename: "src/lib/server-fns.ts"
}, (opts) => adminDeleteEpisodeFn.__executeServer(opts));
var adminDeleteEpisodeFn = createServerFn({ method: "POST" }).validator((data) => ({ id: String(data?.id ?? "") })).handler(adminDeleteEpisodeFn_createServerFn_handler, async ({ data }) => {
	try {
		requireAdminSession();
		if (!await deleteEpisode(data.id)) return {
			ok: false,
			error: "Episódio não encontrado."
		};
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Falha ao excluir episódio."
		};
	}
});
export { adminCreateEpisodeFn_createServerFn_handler, adminDeleteEpisodeFn_createServerFn_handler, adminLoginFn_createServerFn_handler, adminLogoutFn_createServerFn_handler, adminUpdateEpisodeFn_createServerFn_handler, getAdminDashboardFn_createServerFn_handler, getPublicEpisodeFn_createServerFn_handler };
