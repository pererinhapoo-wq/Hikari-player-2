import crypto from "node:crypto";
// node_modules/.nitro/vite/services/ssr/assets/video-sources-BYrFRAqI.js
var ephemeralDevSecret = null;
function getSessionSecret() {
	const configured = process.env.PLAYER_SESSION_SECRET?.trim();
	if (configured && configured.length >= 16) return configured;
	if (!ephemeralDevSecret) ephemeralDevSecret = crypto.randomBytes(32).toString("hex");
	return ephemeralDevSecret;
}
function createProxySignature(targetUrl, expUnixSeconds) {
	const secret = getSessionSecret();
	return crypto.createHmac("sha256", secret).update(`proxy:${targetUrl}:${expUnixSeconds}`).digest("base64url");
}
function buildSignedProxyPath(targetUrl, ttlSeconds = 21600) {
	const exp = Math.floor(Date.now() / 1e3) + ttlSeconds;
	const sig = createProxySignature(targetUrl, exp);
	return `/api/proxy/stream?${new URLSearchParams({
		url: targetUrl,
		exp: String(exp),
		sig
	}).toString()}`;
}
function verifyProxySignature(targetUrl, expParam, sigParam) {
	if (!expParam || !sigParam) return false;
	const exp = Number(expParam);
	if (!Number.isInteger(exp)) return false;
	if (exp < Math.floor(Date.now() / 1e3)) return false;
	const expected = createProxySignature(targetUrl, exp);
	const expectedBuf = Buffer.from(expected, "utf8");
	const receivedBuf = Buffer.from(sigParam, "utf8");
	if (expectedBuf.length !== receivedBuf.length) return false;
	return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}
function resolveAndSignUri(rawUri, baseUrl, signFn) {
	const trimmed = rawUri.trim();
	if (!trimmed || trimmed.startsWith("data:")) return rawUri;
	return signFn(new URL(trimmed, baseUrl).toString());
}
function rewriteM3u8Playlist(playlistContent, baseUrl, signFn) {
	const lines = playlistContent.split(/\r?\n/);
	const output = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			output.push(line);
			continue;
		}
		if (trimmed.startsWith("#")) {
			const rewrittenTag = line.replace(/URI="([^"]+)"/gi, (_match, uriValue) => {
				try {
					return `URI="${resolveAndSignUri(uriValue, baseUrl, signFn)}"`;
				} catch {
					return `URI="${uriValue}"`;
				}
			});
			output.push(rewrittenTag);
			continue;
		}
		try {
			output.push(resolveAndSignUri(trimmed, baseUrl, signFn));
		} catch {
			output.push(line);
		}
	}
	return output.join("\n");
}
var MAX_URL_LENGTH = 2048;
function validateHttpUrl(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return {
		valid: false,
		error: "URL vazia."
	};
	if (trimmed.length > MAX_URL_LENGTH) return {
		valid: false,
		error: "URL excede o limite máximo de caracteres."
	};
	let parsed;
	try {
		parsed = new URL(trimmed);
	} catch {
		return {
			valid: false,
			error: "URL inválida. Informe uma URL completa com http:// ou https://."
		};
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return {
		valid: false,
		error: "Apenas URLs HTTP e HTTPS são permitidas."
	};
	if (parsed.username || parsed.password) return {
		valid: false,
		error: "Credenciais embutidas na URL não são permitidas."
	};
	if (!parsed.hostname) return {
		valid: false,
		error: "Hostname inválido na URL."
	};
	return {
		valid: true,
		normalizedUrl: parsed.toString()
	};
}
function isMaximaimgHost(hostname) {
	const lower = hostname.toLowerCase();
	return lower === "maximaimg.online" || lower.endsWith(".maximaimg.online");
}
function parseMuxPlaybackUrl(url) {
	const host = url.hostname.toLowerCase();
	if (host === "player.mux.com") {
		const candidate = url.pathname.split("/").filter(Boolean)[0];
		if (!candidate || !/^[A-Za-z0-9_-]{8,128}$/.test(candidate)) return null;
		const streamUrl = new URL(`https://stream.mux.com/${candidate}.m3u8`);
		const token = url.searchParams.get("token");
		if (token) streamUrl.searchParams.set("token", token);
		return {
			playbackId: candidate,
			hlsUrl: streamUrl.toString(),
			embedUrl: url.toString()
		};
	}
	if (host === "stream.mux.com") {
		const match = url.pathname.match(/^\/([A-Za-z0-9_-]{8,128})\.m3u8$/i);
		if (!match) return null;
		return {
			playbackId: match[1],
			hlsUrl: url.toString(),
			embedUrl: `https://player.mux.com/${match[1]}`
		};
	}
	return null;
}
function parseBunnyEmbedUrl(url) {
	const host = url.hostname.toLowerCase();
	if (host !== "player.mediadelivery.net" && host !== "iframe.mediadelivery.net") return null;
	const match = url.pathname.match(/^\/(?:embed|play)\/([0-9]+)\/([0-9a-fA-F-]{8,64})\/?$/);
	if (!match) return null;
	const libraryId = match[1];
	const videoId = match[2];
	const embed = new URL(`https://iframe.mediadelivery.net/embed/${libraryId}/${videoId}`);
	for (const [k, v] of url.searchParams.entries()) embed.searchParams.set(k, v);
	return {
		libraryId,
		videoId,
		embedUrl: embed.toString()
	};
}
function detectDirectOrStreamKind(url) {
	const path = url.pathname.toLowerCase();
	const fullQuery = url.search.toLowerCase();
	if (/\.(m3u8|m3u)($|[?#])/i.test(path) || path.includes("/hls/") || fullQuery.includes("m3u8") || fullQuery.includes("type=hls")) return "hls";
	if (/\.(mp4|m4v)($|[?#])/i.test(path) || fullQuery.includes("video/mp4") || fullQuery.includes("format=mp4")) return "mp4";
	if (/\.webm($|[?#])/i.test(path) || fullQuery.includes("video/webm") || fullQuery.includes("format=webm")) return "webm";
	return null;
}
function isLikelyHtmlPage(url) {
	const path = url.pathname.toLowerCase();
	return /\.(html?|php|asp|aspx|jsp)$/i.test(path);
}
function normalizeVideoSource(rawUrl, slot) {
	const validation = validateHttpUrl(rawUrl);
	if (!validation.valid || !validation.normalizedUrl) return null;
	const normalizedUrl = validation.normalizedUrl;
	const parsed = new URL(normalizedUrl);
	const host = parsed.hostname.toLowerCase();
	const label = `Player ${slot}`;
	const mux = parseMuxPlaybackUrl(parsed);
	if (mux) return {
		slot,
		label,
		rawUrl: normalizedUrl,
		resolvedUrl: mux.hlsUrl,
		fallbackIframeUrl: mux.embedUrl,
		kind: "hls",
		provider: "mux",
		needsProxy: false,
		requiresServerResolve: false,
		formatLabel: "Mux · HLS"
	};
	const bunny = parseBunnyEmbedUrl(parsed);
	if (bunny) return {
		slot,
		label,
		rawUrl: normalizedUrl,
		resolvedUrl: bunny.embedUrl,
		fallbackIframeUrl: bunny.embedUrl,
		kind: "bunny",
		provider: "bunny",
		needsProxy: false,
		requiresServerResolve: true,
		formatLabel: "Bunny Stream"
	};
	if (host.endsWith(".b-cdn.net") && /\.m3u8$/i.test(parsed.pathname)) return {
		slot,
		label,
		rawUrl: normalizedUrl,
		resolvedUrl: normalizedUrl,
		kind: "hls",
		provider: "bunny",
		needsProxy: false,
		requiresServerResolve: false,
		formatLabel: "Bunny · HLS"
	};
	if (isMaximaimgHost(host)) {
		const directKind = detectDirectOrStreamKind(parsed);
		const kind = isLikelyHtmlPage(parsed) ? "iframe" : directKind ?? "hls";
		return {
			slot,
			label,
			rawUrl: normalizedUrl,
			resolvedUrl: normalizedUrl,
			kind,
			provider: "maximaimg",
			needsProxy: kind !== "iframe",
			requiresServerResolve: false,
			formatLabel: kind === "iframe" ? "Maximaimg · Embed" : `Maximaimg · ${kind.toUpperCase()}`
		};
	}
	if (!isLikelyHtmlPage(parsed)) {
		const mediaKind = detectDirectOrStreamKind(parsed);
		if (mediaKind === "mp4") return {
			slot,
			label,
			rawUrl: normalizedUrl,
			resolvedUrl: normalizedUrl,
			kind: "mp4",
			provider: "direct",
			needsProxy: false,
			requiresServerResolve: false,
			formatLabel: "MP4"
		};
		if (mediaKind === "webm") return {
			slot,
			label,
			rawUrl: normalizedUrl,
			resolvedUrl: normalizedUrl,
			kind: "webm",
			provider: "direct",
			needsProxy: false,
			requiresServerResolve: false,
			formatLabel: "WebM"
		};
		if (mediaKind === "hls") return {
			slot,
			label,
			rawUrl: normalizedUrl,
			resolvedUrl: normalizedUrl,
			kind: "hls",
			provider: "hls",
			needsProxy: false,
			requiresServerResolve: false,
			formatLabel: "HLS"
		};
	}
	return {
		slot,
		label,
		rawUrl: normalizedUrl,
		resolvedUrl: normalizedUrl,
		fallbackIframeUrl: normalizedUrl,
		kind: "iframe",
		provider: "iframe",
		needsProxy: false,
		requiresServerResolve: false,
		formatLabel: "Embed"
	};
}
function collectEpisodeSources(episode) {
	const candidates = [
		{
			slot: 1,
			url: episode.video_url
		},
		{
			slot: 2,
			url: episode.video_url_2
		},
		{
			slot: 3,
			url: episode.video_url_3
		},
		{
			slot: 4,
			url: episode.video_url_4
		},
		{
			slot: 5,
			url: episode.video_url_5
		}
	];
	const sources = [];
	for (const item of candidates) {
		if (!item.url || !item.url.trim()) continue;
		const normalized = normalizeVideoSource(item.url, item.slot);
		if (normalized) sources.push(normalized);
	}
	return sources;
}
function getNextFallbackSourceIndex(sources, currentIndex, failedSlots) {
	for (let offset = 1; offset < sources.length; offset++) {
		const idx = (currentIndex + offset) % sources.length;
		if (!failedSlots.has(sources[idx].slot)) return idx;
	}
	return null;
}
export { buildSignedProxyPath, collectEpisodeSources, getNextFallbackSourceIndex, getSessionSecret, isMaximaimgHost, normalizeVideoSource, parseBunnyEmbedUrl, rewriteM3u8Playlist, validateHttpUrl, verifyProxySignature };
