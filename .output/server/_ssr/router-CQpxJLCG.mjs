import { TSS_SERVER_FUNCTION, createServerFn, getServerFnById } from "./ssr.mjs";
import { buildSignedProxyPath, isMaximaimgHost, parseBunnyEmbedUrl, rewriteM3u8Playlist, validateHttpUrl, verifyProxySignature } from "./video-sources-BYrFRAqI.mjs";
import { HeadContent, Scripts, createFileRoute, createRootRoute, createRouter, lazyRouteComponent } from "../_libs/@tanstack/react-router+[4...].mjs";
import { Outlet } from "../_libs/@tanstack/react-router+[2...].mjs";
import { require_jsx_dev_runtime } from "../_libs/react.mjs";
import dns from "node:dns/promises";
import net from "node:net";
// node_modules/.nitro/vite/services/ssr/assets/server-fns-DFJobGFU.js
var createSsrRpc = (functionId) => {
	const url = "/_serverFn/" + functionId;
	const serverFnMeta = { id: functionId };
	const fn = async (...args) => {
		return (await getServerFnById(functionId, { origin: "server" }))(...args);
	};
	return Object.assign(fn, {
		url,
		serverFnMeta,
		[TSS_SERVER_FUNCTION]: true
	});
};
var getPublicEpisodeFn = createServerFn({ method: "GET" }).validator((data) => ({ id: String(data?.id ?? "") })).handler(createSsrRpc("9afb2c20fee236aa1debe74ee97b74db22d869606c6c818b33de6510e63e416b"));
var getAdminDashboardFn = createServerFn({ method: "GET" }).handler(createSsrRpc("04581ec28f318041978d3b4c9817cba3ff404f66e72e8a198a212c523fcc81cb"));
var adminLoginFn = createServerFn({ method: "POST" }).validator((data) => ({ password: typeof data?.password === "string" ? data.password : "" })).handler(createSsrRpc("030c93b1e3db6c41ff78e464f4859d6380421ed77e2854ab8ac0dd1963f6b3a9"));
var adminLogoutFn = createServerFn({ method: "POST" }).handler(createSsrRpc("faeb3013da07d6b989b66ac73705d7399f1298ee2a5a7109c90650f53e1f994f"));
var adminCreateEpisodeFn = createServerFn({ method: "POST" }).validator((data) => data).handler(createSsrRpc("d3613d554797e17663a8e3bd4394a4766d9bf015979c64e1c6ca019971631c48"));
var adminUpdateEpisodeFn = createServerFn({ method: "POST" }).validator((data) => data).handler(createSsrRpc("6b9298c225d12818805fe4834a8e33421be87c5d01e0e16a06f74c6d66552f5e"));
var adminDeleteEpisodeFn = createServerFn({ method: "POST" }).validator((data) => ({ id: String(data?.id ?? "") })).handler(createSsrRpc("5b34c4f06bef994047f2a046c73892d61809f3a1ce34cc45e4cf90f8137d054e"));
// node_modules/.nitro/vite/services/ssr/assets/router-CQpxJLCG.js
var import_jsx_dev_runtime = require_jsx_dev_runtime();
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
var src_default = "/assets/index-CTnT60ze.css";
var _jsxFileName = "/app/applet/src/routes/__root.tsx";
var Route$5 = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1"
			},
			{ title: "Player" },
			{
				name: "description",
				content: "Independent anime episode video player by external URL with multi-source fallback and admin management."
			},
			{
				property: "og:title",
				content: "Player"
			},
			{
				property: "og:description",
				content: "Independent anime episode video player by external URL with multi-source fallback and admin management."
			},
			{
				property: "og:type",
				content: "website"
			},
			{
				name: "twitter:card",
				content: "summary_large_image"
			}
		],
		links: [
			{
				rel: "stylesheet",
				href: src_default
			},
			{
				rel: "preconnect",
				href: "https://fonts.googleapis.com"
			},
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossOrigin: "anonymous"
			},
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Plus+Jakarta+Sans:wght@500;600;700&display=swap"
			}
		]
	}),
	component: RootLayout,
	notFoundComponent: RootNotFound
});
function RootLayout() {
	return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("html", {
		lang: "pt-BR",
		children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("head", { children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(HeadContent, {}, void 0, false, {
			fileName: _jsxFileName,
			lineNumber: 51,
			columnNumber: 9
		}, this) }, void 0, false, {
			fileName: _jsxFileName,
			lineNumber: 50,
			columnNumber: 7
		}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("body", {
			className: "min-h-screen bg-[#090B10] text-slate-100 antialiased selection:bg-rose-600/30 selection:text-white",
			children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(Outlet, {}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 54,
				columnNumber: 9
			}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(Scripts, {}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 55,
				columnNumber: 9
			}, this)]
		}, void 0, true, {
			fileName: _jsxFileName,
			lineNumber: 53,
			columnNumber: 7
		}, this)]
	}, void 0, true, {
		fileName: _jsxFileName,
		lineNumber: 49,
		columnNumber: 5
	}, this);
}
function RootNotFound() {
	return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("main", {
		className: "min-h-screen flex items-center justify-center px-6",
		children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
			className: "max-w-md w-full bg-[#11151E] border border-white/10 rounded-xl p-8 text-center",
			children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("h1", {
				className: "text-xl font-semibold text-white",
				children: "Página não encontrada"
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 65,
				columnNumber: 9
			}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("p", {
				className: "mt-2 text-sm text-slate-400",
				children: "O endereço acessado não existe neste servidor."
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 66,
				columnNumber: 9
			}, this)]
		}, void 0, true, {
			fileName: _jsxFileName,
			lineNumber: 64,
			columnNumber: 7
		}, this)
	}, void 0, false, {
		fileName: _jsxFileName,
		lineNumber: 63,
		columnNumber: 5
	}, this);
}
var $$splitComponentImporter$2 = () => import("./routes-DThznvTs.mjs");
var Route$4 = createFileRoute("/")({ component: lazyRouteComponent($$splitComponentImporter$2, "component") });
var $$splitComponentImporter$1 = () => import("./admin-CzAZxp3t.mjs");
var Route$3 = createFileRoute("/admin")({
	loader: async () => {
		return await getAdminDashboardFn();
	},
	head: () => ({ meta: [{ title: "Administração · Player" }] }),
	component: lazyRouteComponent($$splitComponentImporter$1, "component")
});
var BLOCKED_HOSTNAMES = /* @__PURE__ */ new Set([
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
	"metadata.google.internal",
	"metadata"
]);
function isPrivateIpv4(ip) {
	const parts = ip.split(".").map((part) => Number(part));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = parts;
	if (a === 0) return true;
	if (a === 10) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 0) return true;
	if (a === 192 && b === 168) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	if (a >= 224) return true;
	return false;
}
function isPrivateOrReservedIp(ip) {
	const normalized = ip.trim().toLowerCase();
	const kind = net.isIP(normalized);
	if (kind === 0) return true;
	if (kind === 4) return isPrivateIpv4(normalized);
	if (normalized === "::" || normalized === "::1") return true;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
	if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
	if (normalized.startsWith("ff")) return true;
	if (normalized.startsWith("::ffff:")) {
		const v4 = normalized.slice(7);
		if (net.isIPv4(v4)) return isPrivateIpv4(v4);
		return true;
	}
	return false;
}
async function assertSafeExternalUrl(rawUrl) {
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error("URL inválida para requisição externa.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Protocolo não permitido.");
	if (parsed.username || parsed.password) throw new Error("Credenciais na URL não são permitidas.");
	const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) throw new Error("Destino de rede interno bloqueado.");
	if (net.isIP(hostname) !== 0) {
		if (isPrivateOrReservedIp(hostname)) throw new Error("Endereço IP privado ou reservado bloqueado.");
		return parsed;
	}
	let records;
	try {
		records = await dns.lookup(hostname, {
			all: true,
			verbatim: true
		});
	} catch {
		throw new Error("Falha ao resolver DNS do destino externo.");
	}
	if (!records || records.length === 0) throw new Error("Destino sem registros DNS válidos.");
	for (const record of records) if (isPrivateOrReservedIp(record.address)) throw new Error("Destino resolve para endereço IP privado ou reservado.");
	return parsed;
}
async function safeFetchWithRedirects(initialUrl, options = {}) {
	const maxRedirects = options.maxRedirects ?? 5;
	const timeoutMs = options.timeoutMs ?? 15e3;
	let currentUrl = initialUrl;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		const validatedUrl = await assertSafeExternalUrl(currentUrl);
		const response = await fetch(validatedUrl.toString(), {
			method: "GET",
			redirect: "manual",
			headers: options.headers,
			signal: AbortSignal.timeout(timeoutMs)
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw new Error("Redirecionamento sem cabeçalho Location.");
			if (hop === maxRedirects) throw new Error("Número máximo de redirecionamentos excedido.");
			currentUrl = new URL(location, validatedUrl).toString();
			continue;
		}
		return {
			response,
			finalUrl: validatedUrl.toString()
		};
	}
	throw new Error("Falha ao seguir redirecionamentos.");
}
var DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
function extractBunnyHlsFromHtml(html, videoId) {
	const escapedVideoId = videoId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const patterns = [
		new RegExp(`https:\\/\\/vz-[a-z0-9-]+\\.b-cdn\\.net\\/${escapedVideoId}\\/playlist\\.m3u8(?:\\?[^"'\\s<>\\\\]*)?`, "i"),
		/https:\/\/vz-[a-z0-9-]+\.b-cdn\.net\/[^"'\s<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?/i,
		/["'](https:\/\/[^"'\s<>\\]+\/playlist\.m3u8(?:\?[^"'\s<>\\]*)?)["']/i
	];
	for (const regex of patterns) {
		const match = html.match(regex);
		const candidate = match ? match[1] ?? match[0] : null;
		if (candidate) {
			const cleaned = candidate.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
			const check = validateHttpUrl(cleaned);
			if (check.valid && check.normalizedUrl) return check.normalizedUrl;
		}
	}
	return null;
}
async function resolveBunnyStreamSource(rawUrl) {
	const validation = validateHttpUrl(rawUrl);
	if (!validation.valid || !validation.normalizedUrl) throw new Error(validation.error || "URL Bunny inválida.");
	const parsed = new URL(validation.normalizedUrl);
	const bunnyInfo = parseBunnyEmbedUrl(parsed);
	if (!bunnyInfo) throw new Error("URL não corresponde ao formato player.mediadelivery.net/embed.");
	try {
		const { response } = await safeFetchWithRedirects(bunnyInfo.embedUrl, {
			headers: {
				"User-Agent": DEFAULT_USER_AGENT,
				Referer: "https://iframe.mediadelivery.net/",
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
			},
			timeoutMs: 1e4
		});
		if (!response.ok) return {
			ok: false,
			embedUrl: bunnyInfo.embedUrl,
			reason: `Bunny embed retornou status ${response.status}; usando reprodução via embed.`
		};
		const hlsUrl = extractBunnyHlsFromHtml(await response.text(), bunnyInfo.videoId);
		if (!hlsUrl) return {
			ok: false,
			embedUrl: bunnyInfo.embedUrl,
			reason: "Playlist HLS protegida ou indisponível; usando fallback de embed."
		};
		return {
			ok: true,
			hlsUrl,
			embedUrl: bunnyInfo.embedUrl
		};
	} catch {
		return {
			ok: false,
			embedUrl: bunnyInfo.embedUrl,
			reason: "Não foi possível resolver a playlist diretamente; usando fallback de embed."
		};
	}
}
var Route$2 = createFileRoute("/api/resolve-bunny")({ server: { handlers: { GET: async ({ request }) => {
	const rawTarget = new URL(request.url).searchParams.get("url") ?? "";
	const validation = validateHttpUrl(rawTarget);
	if (!validation.valid || !validation.normalizedUrl) return Response.json({
		ok: false,
		error: "URL Bunny inválida."
	}, { status: 400 });
	const parsed = new URL(validation.normalizedUrl);
	if (!parseBunnyEmbedUrl(parsed)) return Response.json({
		ok: false,
		error: "Apenas URLs player.mediadelivery.net/embed são aceitas."
	}, { status: 400 });
	const resolved = await resolveBunnyStreamSource(validation.normalizedUrl);
	return Response.json(resolved, {
		status: 200,
		headers: { "Cache-Control": "no-store" }
	});
} } } });
var $$splitComponentImporter = () => import("../_id-DKqFz-LP.mjs");
var Route$1 = createFileRoute("/e/$id")({
	loader: async ({ params }) => {
		return await getPublicEpisodeFn({ data: { id: params.id } });
	},
	head: ({ loaderData }) => {
		const title = loaderData?.status === "ok" ? `${loaderData.episode.title} · Player` : "Episódio não encontrado · Player";
		return { meta: [
			{ title },
			{
				property: "og:title",
				content: title
			},
			...loaderData?.status === "ok" ? [{
				property: "og:image",
				content: loaderData.episode.poster_url
			}] : []
		] };
	},
	component: lazyRouteComponent($$splitComponentImporter, "component")
});
var BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
function getUpstreamHeaders(targetUrl, incomingRequest) {
	const headers = {
		"User-Agent": BROWSER_UA,
		Accept: "*/*"
	};
	if (isMaximaimgHost(targetUrl.hostname)) {
		const configuredReferer = process.env.PLAYER_MAXIMAIMG_REFERER?.trim() || "https://maximaimg.online/";
		headers["Referer"] = configuredReferer;
		try {
			headers["Origin"] = new URL(configuredReferer).origin;
		} catch {
			headers["Origin"] = "https://maximaimg.online";
		}
	} else headers["Referer"] = `${targetUrl.origin}/`;
	const range = incomingRequest.headers.get("range");
	if (range) headers["Range"] = range;
	return headers;
}
function isM3u8Response(contentType, targetUrl, firstChunk) {
	const lowerCt = contentType.toLowerCase();
	const lowerPath = targetUrl.pathname.toLowerCase();
	if (lowerCt.includes("mpegurl") || lowerCt.includes("m3u8") || lowerPath.endsWith(".m3u8") || lowerPath.endsWith(".m3u")) return true;
	return firstChunk.trimStart().startsWith("#EXTM3U");
}
var Route = createFileRoute("/api/proxy/stream")({ server: { handlers: { GET: async ({ request }) => {
	const reqUrl = new URL(request.url);
	const rawTarget = reqUrl.searchParams.get("url") ?? "";
	const exp = reqUrl.searchParams.get("exp");
	const sig = reqUrl.searchParams.get("sig");
	const urlCheck = validateHttpUrl(rawTarget);
	if (!urlCheck.valid || !urlCheck.normalizedUrl) return new Response("Parâmetro de URL inválido.", { status: 400 });
	if (!verifyProxySignature(urlCheck.normalizedUrl, exp, sig)) return new Response("Assinatura de proxy inválida ou expirada.", { status: 403 });
	try {
		const targetUrl = new URL(urlCheck.normalizedUrl);
		const upstreamHeaders = getUpstreamHeaders(targetUrl, request);
		const { response: upstream, finalUrl } = await safeFetchWithRedirects(targetUrl.toString(), {
			headers: upstreamHeaders,
			timeoutMs: 2e4
		});
		if (!upstream.ok && upstream.status !== 206) return new Response(`Origem retornou erro HTTP ${upstream.status}.`, { status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502 });
		const contentType = upstream.headers.get("content-type") || "application/octet-stream";
		const finalParsed = new URL(finalUrl);
		if (contentType.toLowerCase().includes("mpegurl") || contentType.toLowerCase().includes("text/") || finalParsed.pathname.toLowerCase().endsWith(".m3u8") || finalParsed.pathname.toLowerCase().endsWith(".m3u")) {
			const text = await upstream.text();
			if (isM3u8Response(contentType, finalParsed, text)) {
				const rewritten = rewriteM3u8Playlist(text, finalUrl, (resolved) => buildSignedProxyPath(resolved));
				return new Response(rewritten, {
					status: 200,
					headers: {
						"Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
						"Cache-Control": "no-store",
						"Access-Control-Allow-Origin": "*"
					}
				});
			}
			return new Response(text, {
				status: upstream.status,
				headers: {
					"Content-Type": contentType,
					"Cache-Control": "no-store"
				}
			});
		}
		const outHeaders = new Headers();
		outHeaders.set("Content-Type", contentType);
		outHeaders.set("Cache-Control", "private, max-age=300");
		outHeaders.set("Access-Control-Allow-Origin", "*");
		for (const h of [
			"content-length",
			"content-range",
			"accept-ranges"
		]) {
			const val = upstream.headers.get(h);
			if (val) outHeaders.set(h, val);
		}
		return new Response(upstream.body, {
			status: upstream.status,
			headers: outHeaders
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Falha ao processar stream via proxy.";
		return new Response(message, { status: 502 });
	}
} } } });
var rootRouteChildren = {
	IndexRoute: Route$4.update({
		id: "/",
		path: "/",
		getParentRoute: () => Route$5
	}),
	AdminRoute: Route$3.update({
		id: "/admin",
		path: "/admin",
		getParentRoute: () => Route$5
	}),
	ApiResolveBunnyRoute: Route$2.update({
		id: "/api/resolve-bunny",
		path: "/api/resolve-bunny",
		getParentRoute: () => Route$5
	}),
	EIdRoute: Route$1.update({
		id: "/e/$id",
		path: "/e/$id",
		getParentRoute: () => Route$5
	}),
	ApiProxyStreamRoute: Route.update({
		id: "/api/proxy/stream",
		path: "/api/proxy/stream",
		getParentRoute: () => Route$5
	})
};
var routeTree = Route$5._addFileChildren(rootRouteChildren)._addFileTypes();
var router_exports = /* @__PURE__ */ __exportAll({ getRouter: () => getRouter });
function getRouter() {
	return createRouter({
		routeTree,
		scrollRestoration: true
	});
}
export { Route$1, Route$3, adminCreateEpisodeFn, adminDeleteEpisodeFn, adminLoginFn, adminLogoutFn, adminUpdateEpisodeFn, router_exports };
