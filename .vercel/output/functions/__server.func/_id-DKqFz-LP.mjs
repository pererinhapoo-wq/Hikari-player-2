import { __toESM } from "./_runtime.mjs";
import { getNextFallbackSourceIndex } from "./_ssr/video-sources-BYrFRAqI.mjs";
import { Route$1 } from "./_ssr/router-CQpxJLCG.mjs";
import { require_react } from "./_libs/@tanstack/react-router+[...].mjs";
import { require_jsx_dev_runtime } from "./_libs/react.mjs";
import { CircleAlert, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from "./_libs/lucide-react3.mjs";
import { TriangleAlert } from "./_libs/lucide-react5.mjs";
import { Film } from "./_libs/lucide-react.mjs";
// node_modules/.nitro/vite/services/ssr/assets/_id-DKqFz-LP.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_dev_runtime = require_jsx_dev_runtime();
var _jsxFileName$1 = "/app/applet/src/components/EpisodePlayer.tsx";
var SPEED_OPTIONS = [
	.5,
	.75,
	1,
	1.25,
	1.5,
	2
];
function formatTime(seconds) {
	if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
	const total = Math.floor(seconds);
	const hrs = Math.floor(total / 3600);
	const mins = Math.floor(total % 3600 / 60);
	const secs = total % 60;
	const pad = (n) => String(n).padStart(2, "0");
	return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}
function EpisodePlayer({ title, posterUrl, sources }) {
	const containerRef = (0, import_react.useRef)(null);
	const videoRef = (0, import_react.useRef)(null);
	const hlsInstanceRef = (0, import_react.useRef)(null);
	const hideControlsTimerRef = (0, import_react.useRef)(null);
	const [hasStarted, setHasStarted] = (0, import_react.useState)(false);
	const [activeIndex, setActiveIndex] = (0, import_react.useState)(0);
	const [failedSlots, setFailedSlots] = (0, import_react.useState)(() => /* @__PURE__ */ new Set());
	const [posterError, setPosterError] = (0, import_react.useState)(false);
	const [resolvedRuntime, setResolvedRuntime] = (0, import_react.useState)(null);
	const [isLoadingSource, setIsLoadingSource] = (0, import_react.useState)(false);
	const [statusNotice, setStatusNotice] = (0, import_react.useState)(null);
	const [fatalError, setFatalError] = (0, import_react.useState)(null);
	const [isPlaying, setIsPlaying] = (0, import_react.useState)(false);
	const [currentTime, setCurrentTime] = (0, import_react.useState)(0);
	const [duration, setDuration] = (0, import_react.useState)(0);
	const [bufferedEnd, setBufferedEnd] = (0, import_react.useState)(0);
	const [volume, setVolume] = (0, import_react.useState)(1);
	const [isMuted, setIsMuted] = (0, import_react.useState)(false);
	const [playbackRate, setPlaybackRate] = (0, import_react.useState)(1);
	const [speedMenuOpen, setSpeedMenuOpen] = (0, import_react.useState)(false);
	const [isFullscreen, setIsFullscreen] = (0, import_react.useState)(false);
	const [controlsVisible, setControlsVisible] = (0, import_react.useState)(true);
	const [hoverTime, setHoverTime] = (0, import_react.useState)(null);
	const activeSource = sources[activeIndex] ?? null;
	const cleanupHls = (0, import_react.useCallback)(() => {
		if (hlsInstanceRef.current) {
			try {
				hlsInstanceRef.current.destroy();
			} catch {}
			hlsInstanceRef.current = null;
		}
	}, []);
	const scheduleHideControls = (0, import_react.useCallback)(() => {
		if (hideControlsTimerRef.current) window.clearTimeout(hideControlsTimerRef.current);
		setControlsVisible(true);
		hideControlsTimerRef.current = window.setTimeout(() => {
			if (videoRef.current && !videoRef.current.paused) {
				setControlsVisible(false);
				setSpeedMenuOpen(false);
			}
		}, 2800);
	}, []);
	const triggerFailover = (0, import_react.useCallback)((failedSlot, reason) => {
		cleanupHls();
		setFailedSlots((prev) => {
			const next = new Set(prev);
			next.add(failedSlot);
			const fallbackIdx = getNextFallbackSourceIndex(sources, activeIndex, next);
			if (fallbackIdx !== null) {
				const nextSource = sources[fallbackIdx];
				setStatusNotice(`${sources[activeIndex]?.label ?? "Fonte atual"} indisponível — alternando para ${nextSource.label}...`);
				setActiveIndex(fallbackIdx);
				setFatalError(null);
			} else {
				setStatusNotice(null);
				setFatalError(reason || "Não foi possível reproduzir nenhuma das fontes configuradas para este episódio.");
			}
			return next;
		});
	}, [
		activeIndex,
		cleanupHls,
		sources
	]);
	(0, import_react.useEffect)(() => {
		if (!hasStarted || !activeSource) return;
		let cancelled = false;
		setFatalError(null);
		setIsLoadingSource(true);
		setCurrentTime(0);
		setDuration(0);
		setBufferedEnd(0);
		setIsPlaying(false);
		async function prepareActiveSource(source) {
			if (source.kind === "iframe") {
				if (!cancelled) {
					setResolvedRuntime({
						slot: source.slot,
						mode: "iframe",
						url: source.playUrl
					});
					setIsLoadingSource(false);
				}
				return;
			}
			if (source.kind === "bunny" && source.requiresServerResolve) {
				try {
					const payload = await (await fetch(`/api/resolve-bunny?url=${encodeURIComponent(source.rawUrl)}`)).json();
					if (cancelled) return;
					if (payload.ok && payload.hlsUrl) setResolvedRuntime({
						slot: source.slot,
						mode: "hls",
						url: payload.hlsUrl
					});
					else {
						setStatusNotice(payload.reason ?? "Usando reprodução via embed para Bunny Stream.");
						setResolvedRuntime({
							slot: source.slot,
							mode: "iframe",
							url: payload.embedUrl || source.fallbackIframeUrl || source.playUrl
						});
						setIsLoadingSource(false);
					}
				} catch {
					if (cancelled) return;
					if (source.fallbackIframeUrl) {
						setResolvedRuntime({
							slot: source.slot,
							mode: "iframe",
							url: source.fallbackIframeUrl
						});
						setIsLoadingSource(false);
					} else triggerFailover(source.slot, "Falha ao resolver fonte Bunny Stream.");
				}
				return;
			}
			if (source.kind === "hls") {
				if (!cancelled) setResolvedRuntime({
					slot: source.slot,
					mode: "hls",
					url: source.playUrl
				});
				return;
			}
			if (!cancelled) setResolvedRuntime({
				slot: source.slot,
				mode: "video",
				url: source.playUrl
			});
		}
		prepareActiveSource(activeSource);
		return () => {
			cancelled = true;
		};
	}, [
		hasStarted,
		activeSource,
		triggerFailover
	]);
	(0, import_react.useEffect)(() => {
		if (!hasStarted || !resolvedRuntime || resolvedRuntime.mode === "iframe") {
			cleanupHls();
			return;
		}
		const video = videoRef.current;
		if (!video) return;
		let cancelled = false;
		cleanupHls();
		const startPlayback = async () => {
			try {
				video.playbackRate = playbackRate;
				await video.play();
			} catch {
				setControlsVisible(true);
			}
		};
		if (resolvedRuntime.mode === "video") {
			video.src = resolvedRuntime.url;
			video.load();
			setIsLoadingSource(false);
			startPlayback();
			return () => {
				video.removeAttribute("src");
				video.load();
			};
		}
		async function attachHls() {
			const el = videoRef.current;
			if (!el || !resolvedRuntime) return;
			try {
				const Hls = (await import("./_libs/hls.js.mjs").then((n) => n.hls_exports)).default;
				if (cancelled) return;
				if (Hls.isSupported()) {
					const hls = new Hls({
						enableWorker: true,
						lowLatencyMode: false,
						backBufferLength: 30
					});
					hlsInstanceRef.current = hls;
					hls.on(Hls.Events.MANIFEST_PARSED, () => {
						if (cancelled) return;
						setIsLoadingSource(false);
						startPlayback();
					});
					hls.on(Hls.Events.ERROR, (_event, data) => {
						if (cancelled || !data.fatal) return;
						if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
							hls.recoverMediaError();
							return;
						}
						const source = activeSource;
						if (source?.fallbackIframeUrl && source.provider === "mux") {
							setStatusNotice("Stream HLS indisponível — alternando para embed Mux.");
							setResolvedRuntime({
								slot: source.slot,
								mode: "iframe",
								url: source.fallbackIframeUrl
							});
							setIsLoadingSource(false);
							return;
						}
						triggerFailover(resolvedRuntime.slot, "Falha ao carregar transmissão HLS.");
					});
					hls.loadSource(resolvedRuntime.url);
					hls.attachMedia(el);
					return;
				}
				if (el.canPlayType("application/vnd.apple.mpegurl")) {
					el.src = resolvedRuntime.url;
					el.load();
					setIsLoadingSource(false);
					startPlayback();
					return;
				}
				triggerFailover(resolvedRuntime.slot, "Este navegador não oferece suporte à reprodução HLS.");
			} catch {
				if (!cancelled) triggerFailover(resolvedRuntime.slot, "Erro ao inicializar motor de reprodução HLS.");
			}
		}
		attachHls();
		return () => {
			cancelled = true;
			cleanupHls();
		};
	}, [
		hasStarted,
		resolvedRuntime,
		cleanupHls,
		triggerFailover,
		activeSource,
		playbackRate
	]);
	(0, import_react.useEffect)(() => {
		const onFsChange = () => {
			setIsFullscreen(Boolean(document.fullscreenElement));
		};
		document.addEventListener("fullscreenchange", onFsChange);
		return () => document.removeEventListener("fullscreenchange", onFsChange);
	}, []);
	const togglePlayPause = (0, import_react.useCallback)(() => {
		const video = videoRef.current;
		if (!video) return;
		if (video.paused) video.play();
		else video.pause();
		scheduleHideControls();
	}, [scheduleHideControls]);
	const seekBy = (0, import_react.useCallback)((deltaSeconds) => {
		const video = videoRef.current;
		if (!video || !Number.isFinite(video.duration)) return;
		const target = Math.max(0, Math.min(video.duration, video.currentTime + deltaSeconds));
		video.currentTime = target;
		setCurrentTime(target);
		scheduleHideControls();
	}, [scheduleHideControls]);
	const toggleMute = (0, import_react.useCallback)(() => {
		const video = videoRef.current;
		if (!video) return;
		const nextMuted = !video.muted;
		video.muted = nextMuted;
		setIsMuted(nextMuted);
		scheduleHideControls();
	}, [scheduleHideControls]);
	const changeVolume = (0, import_react.useCallback)((nextVol) => {
		const clamped = Math.max(0, Math.min(1, nextVol));
		const video = videoRef.current;
		if (video) {
			video.volume = clamped;
			video.muted = clamped === 0;
		}
		setVolume(clamped);
		setIsMuted(clamped === 0);
		scheduleHideControls();
	}, [scheduleHideControls]);
	const changePlaybackRate = (0, import_react.useCallback)((rate) => {
		setPlaybackRate(rate);
		if (videoRef.current) videoRef.current.playbackRate = rate;
		setSpeedMenuOpen(false);
		scheduleHideControls();
	}, [scheduleHideControls]);
	const toggleFullscreen = (0, import_react.useCallback)(async () => {
		const container = containerRef.current;
		const video = videoRef.current;
		if (!container) return;
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else if (container.requestFullscreen) await container.requestFullscreen();
			else if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
		} catch {
			if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
		}
		scheduleHideControls();
	}, [scheduleHideControls]);
	(0, import_react.useEffect)(() => {
		if (!hasStarted || resolvedRuntime?.mode === "iframe") return;
		const handleKeyDown = (e) => {
			const target = e.target;
			if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
			switch (e.key.toLowerCase()) {
				case " ":
				case "k":
					e.preventDefault();
					togglePlayPause();
					break;
				case "arrowleft":
				case "j":
					e.preventDefault();
					seekBy(-10);
					break;
				case "arrowright":
				case "l":
					e.preventDefault();
					seekBy(10);
					break;
				case "arrowup":
					e.preventDefault();
					changeVolume((videoRef.current?.volume ?? volume) + .1);
					break;
				case "arrowdown":
					e.preventDefault();
					changeVolume((videoRef.current?.volume ?? volume) - .1);
					break;
				case "m":
					e.preventDefault();
					toggleMute();
					break;
				case "f":
					e.preventDefault();
					toggleFullscreen();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		hasStarted,
		resolvedRuntime?.mode,
		togglePlayPause,
		seekBy,
		changeVolume,
		volume,
		toggleMute,
		toggleFullscreen
	]);
	const selectSourceManually = (index) => {
		setFailedSlots((prev) => {
			const next = new Set(prev);
			next.delete(sources[index].slot);
			return next;
		});
		setStatusNotice(null);
		setFatalError(null);
		setActiveIndex(index);
		if (!hasStarted) setHasStarted(true);
	};
	const retryPlayback = () => {
		setFailedSlots(/* @__PURE__ */ new Set());
		setFatalError(null);
		setStatusNotice(null);
		setActiveIndex(0);
		setResolvedRuntime(null);
		setHasStarted(true);
	};
	const progressPct = (0, import_react.useMemo)(() => {
		if (!duration || duration <= 0) return 0;
		return Math.min(100, Math.max(0, currentTime / duration * 100));
	}, [currentTime, duration]);
	const bufferedPct = (0, import_react.useMemo)(() => {
		if (!duration || duration <= 0) return 0;
		return Math.min(100, Math.max(0, bufferedEnd / duration * 100));
	}, [bufferedEnd, duration]);
	if (sources.length === 0) return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
		className: "w-full aspect-video bg-[#11151E] border border-white/10 rounded-xl flex flex-col items-center justify-center p-8 text-center",
		children: [
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(CircleAlert, { className: "w-10 h-10 text-rose-400 mb-3" }, void 0, false, {
				fileName: _jsxFileName$1,
				lineNumber: 534,
				columnNumber: 9
			}, this),
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("h2", {
				className: "text-lg font-semibold text-white",
				children: "Nenhuma fonte de vídeo válida"
			}, void 0, false, {
				fileName: _jsxFileName$1,
				lineNumber: 535,
				columnNumber: 9
			}, this),
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("p", {
				className: "mt-1.5 text-sm text-slate-400 max-w-md",
				children: "Este episódio ainda não possui uma URL de reprodução configurada."
			}, void 0, false, {
				fileName: _jsxFileName$1,
				lineNumber: 536,
				columnNumber: 9
			}, this)
		]
	}, void 0, true, {
		fileName: _jsxFileName$1,
		lineNumber: 533,
		columnNumber: 7
	}, this);
	return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
		className: "w-full space-y-3",
		children: [
			sources.length > 1 && /* @__PURE__ */ (void 0)("div", {
				className: "flex flex-wrap items-center justify-between gap-3",
				children: [/* @__PURE__ */ (void 0)("div", {
					role: "tablist",
					"aria-label": "Fontes de vídeo disponíveis",
					className: "inline-flex flex-wrap items-center gap-1 p-1 bg-[#11151E] border border-white/10 rounded-lg",
					children: sources.map((src, idx) => {
						const isActive = idx === activeIndex;
						const isFailed = failedSlots.has(src.slot);
						return /* @__PURE__ */ (void 0)("button", {
							type: "button",
							role: "tab",
							"aria-selected": isActive,
							onClick: () => selectSourceManually(idx),
							className: `px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 ${isActive ? "bg-rose-600 text-white" : isFailed ? "text-slate-500 hover:text-slate-300 line-through" : "text-slate-300 hover:text-white hover:bg-white/5"}`,
							children: src.label
						}, src.slot, false, {
							fileName: _jsxFileName$1,
							lineNumber: 557,
							columnNumber: 17
						}, this);
					})
				}, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 548,
					columnNumber: 11
				}, this), activeSource && /* @__PURE__ */ (void 0)("span", {
					className: "text-xs text-slate-400 font-mono tabular-nums",
					children: activeSource.formatLabel
				}, void 0, false, {
					fileName: _jsxFileName$1,
					lineNumber: 578,
					columnNumber: 13
				}, this)]
			}, void 0, true, {
				fileName: _jsxFileName$1,
				lineNumber: 547,
				columnNumber: 9
			}, this),
			/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
				ref: containerRef,
				onMouseMove: hasStarted ? scheduleHideControls : void 0,
				onTouchStart: hasStarted ? scheduleHideControls : void 0,
				className: "relative w-full aspect-video bg-black border border-white/10 rounded-xl overflow-hidden select-none group",
				children: [
					!hasStarted && /* @__PURE__ */ (void 0)("div", {
						className: "absolute inset-0",
						children: [
							!posterError && posterUrl ? /* @__PURE__ */ (void 0)("img", {
								src: posterUrl,
								alt: `Capa de ${title}`,
								referrerPolicy: "no-referrer",
								onError: () => setPosterError(true),
								className: "w-full h-full object-cover"
							}, void 0, false, {
								fileName: _jsxFileName$1,
								lineNumber: 596,
								columnNumber: 15
							}, this) : /* @__PURE__ */ (void 0)("div", {
								className: "w-full h-full bg-gradient-to-br from-[#141926] via-[#0D1018] to-[#090B10] flex items-center justify-center",
								children: /* @__PURE__ */ (void 0)(Film, { className: "w-16 h-16 text-slate-600" }, void 0, false, {
									fileName: _jsxFileName$1,
									lineNumber: 605,
									columnNumber: 17
								}, this)
							}, void 0, false, {
								fileName: _jsxFileName$1,
								lineNumber: 604,
								columnNumber: 15
							}, this),
							/* @__PURE__ */ (void 0)("div", { className: "absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-black/30" }, void 0, false, {
								fileName: _jsxFileName$1,
								lineNumber: 609,
								columnNumber: 13
							}, this),
							/* @__PURE__ */ (void 0)("div", {
								className: "absolute inset-0 flex flex-col items-center justify-center p-6 text-center",
								children: [/* @__PURE__ */ (void 0)("button", {
									type: "button",
									onClick: () => {
										setHasStarted(true);
										scheduleHideControls();
									},
									"aria-label": `Reproduzir ${title}`,
									className: "w-20 h-20 rounded-full bg-rose-600 hover:bg-rose-500 active:scale-95 text-white flex items-center justify-center shadow-xl transition-transform duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-rose-500/50 cursor-pointer",
									children: /* @__PURE__ */ (void 0)(Play, { className: "w-8 h-8 fill-current ml-1" }, void 0, false, {
										fileName: _jsxFileName$1,
										lineNumber: 621,
										columnNumber: 17
									}, this)
								}, void 0, false, {
									fileName: _jsxFileName$1,
									lineNumber: 612,
									columnNumber: 15
								}, this), /* @__PURE__ */ (void 0)("span", {
									className: "mt-4 text-sm font-medium text-white/90",
									children: "Clique para reproduzir"
								}, void 0, false, {
									fileName: _jsxFileName$1,
									lineNumber: 623,
									columnNumber: 15
								}, this)]
							}, void 0, true, {
								fileName: _jsxFileName$1,
								lineNumber: 611,
								columnNumber: 13
							}, this)
						]
					}, void 0, true, {
						fileName: _jsxFileName$1,
						lineNumber: 594,
						columnNumber: 11
					}, this),
					hasStarted && resolvedRuntime?.mode === "iframe" && !fatalError && /* @__PURE__ */ (void 0)("iframe", {
						src: resolvedRuntime.url,
						title,
						className: "w-full h-full border-0 bg-black",
						allow: "autoplay; fullscreen; picture-in-picture; encrypted-media",
						allowFullScreen: true,
						referrerPolicy: "no-referrer-when-downgrade"
					}, `${resolvedRuntime.slot}-${resolvedRuntime.url}`, false, {
						fileName: _jsxFileName$1,
						lineNumber: 632,
						columnNumber: 11
					}, this),
					hasStarted && resolvedRuntime && resolvedRuntime.mode !== "iframe" && !fatalError && /* @__PURE__ */ (void 0)(import_jsx_dev_runtime.Fragment, { children: [
						/* @__PURE__ */ (void 0)("video", {
							ref: videoRef,
							poster: posterError ? void 0 : posterUrl,
							playsInline: true,
							preload: "metadata",
							onClick: togglePlayPause,
							onLoadStart: () => setIsLoadingSource(true),
							onCanPlay: () => setIsLoadingSource(false),
							onPlay: () => {
								setIsPlaying(true);
								setIsLoadingSource(false);
								scheduleHideControls();
							},
							onPause: () => {
								setIsPlaying(false);
								setControlsVisible(true);
							},
							onTimeUpdate: () => {
								const v = videoRef.current;
								if (!v) return;
								setCurrentTime(v.currentTime);
								if (v.buffered.length > 0) setBufferedEnd(v.buffered.end(v.buffered.length - 1));
							},
							onLoadedMetadata: () => {
								const v = videoRef.current;
								if (!v) return;
								setDuration(Number.isFinite(v.duration) ? v.duration : 0);
							},
							onVolumeChange: () => {
								const v = videoRef.current;
								if (!v) return;
								setVolume(v.volume);
								setIsMuted(v.muted);
							},
							onError: () => {
								if (activeSource) triggerFailover(activeSource.slot, "Não foi possível carregar este vídeo nesta fonte.");
							},
							className: "w-full h-full object-contain bg-black cursor-pointer"
						}, void 0, false, {
							fileName: _jsxFileName$1,
							lineNumber: 646,
							columnNumber: 13
						}, this),
						isLoadingSource && /* @__PURE__ */ (void 0)("div", {
							className: "pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40",
							children: /* @__PURE__ */ (void 0)("div", { className: "w-10 h-10 rounded-full border-2 border-white/25 border-t-rose-500 animate-spin" }, void 0, false, {
								fileName: _jsxFileName$1,
								lineNumber: 696,
								columnNumber: 17
							}, this)
						}, void 0, false, {
							fileName: _jsxFileName$1,
							lineNumber: 695,
							columnNumber: 15
						}, this),
						!isPlaying && !isLoadingSource && /* @__PURE__ */ (void 0)("button", {
							type: "button",
							onClick: togglePlayPause,
							"aria-label": "Continuar reprodução",
							className: "absolute inset-0 m-auto w-16 h-16 rounded-full bg-black/65 hover:bg-rose-600 text-white flex items-center justify-center border border-white/15 transition-colors cursor-pointer",
							children: /* @__PURE__ */ (void 0)(Play, { className: "w-7 h-7 fill-current ml-0.5" }, void 0, false, {
								fileName: _jsxFileName$1,
								lineNumber: 708,
								columnNumber: 17
							}, this)
						}, void 0, false, {
							fileName: _jsxFileName$1,
							lineNumber: 702,
							columnNumber: 15
						}, this),
						/* @__PURE__ */ (void 0)("div", {
							className: `absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent pt-10 pb-3 px-3 sm:px-4 transition-opacity duration-200 ${controlsVisible || !isPlaying ? "opacity-100" : "opacity-0 pointer-events-none"}`,
							children: [/* @__PURE__ */ (void 0)("div", {
								className: "relative h-5 flex items-center cursor-pointer group/bar",
								onClick: (e) => {
									const rect = e.currentTarget.getBoundingClientRect();
									const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
									if (videoRef.current && duration > 0) {
										const target = pct * duration;
										videoRef.current.currentTime = target;
										setCurrentTime(target);
									}
								},
								onMouseMove: (e) => {
									if (duration <= 0) return;
									const rect = e.currentTarget.getBoundingClientRect();
									const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
									setHoverTime({
										time: pct * duration,
										pct: pct * 100
									});
								},
								onMouseLeave: () => setHoverTime(null),
								children: [hoverTime && /* @__PURE__ */ (void 0)("div", {
									style: { left: `${hoverTime.pct}%` },
									className: "hidden sm:block absolute -top-7 -translate-x-1/2 px-2 py-0.5 rounded bg-black/90 border border-white/15 text-[11px] font-mono tabular-nums text-white pointer-events-none",
									children: formatTime(hoverTime.time)
								}, void 0, false, {
									fileName: _jsxFileName$1,
									lineNumber: 739,
									columnNumber: 19
								}, this), /* @__PURE__ */ (void 0)("div", {
									className: "w-full h-1.5 group-hover/bar:h-2 transition-all rounded-full bg-white/20 overflow-hidden relative",
									children: [/* @__PURE__ */ (void 0)("div", {
										className: "absolute inset-y-0 left-0 bg-white/30",
										style: { width: `${bufferedPct}%` }
									}, void 0, false, {
										fileName: _jsxFileName$1,
										lineNumber: 748,
										columnNumber: 19
									}, this), /* @__PURE__ */ (void 0)("div", {
										className: "absolute inset-y-0 left-0 bg-rose-500",
										style: { width: `${progressPct}%` }
									}, void 0, false, {
										fileName: _jsxFileName$1,
										lineNumber: 752,
										columnNumber: 19
									}, this)]
								}, void 0, true, {
									fileName: _jsxFileName$1,
									lineNumber: 747,
									columnNumber: 17
								}, this)]
							}, void 0, true, {
								fileName: _jsxFileName$1,
								lineNumber: 719,
								columnNumber: 15
							}, this), /* @__PURE__ */ (void 0)("div", {
								className: "mt-1 flex items-center justify-between gap-2",
								children: [/* @__PURE__ */ (void 0)("div", {
									className: "flex items-center gap-1 sm:gap-2",
									children: [
										/* @__PURE__ */ (void 0)("button", {
											type: "button",
											onClick: togglePlayPause,
											"aria-label": isPlaying ? "Pausar" : "Reproduzir",
											className: "min-w-[40px] min-h-[40px] sm:min-w-[36px] sm:min-h-[36px] flex items-center justify-center rounded-lg text-white hover:bg-white/10 transition-colors cursor-pointer",
											children: isPlaying ? /* @__PURE__ */ (void 0)(Pause, { className: "w-5 h-5 fill-current" }, void 0, false, {
												fileName: _jsxFileName$1,
												lineNumber: 769,
												columnNumber: 23
											}, this) : /* @__PURE__ */ (void 0)(Play, { className: "w-5 h-5 fill-current" }, void 0, false, {
												fileName: _jsxFileName$1,
												lineNumber: 771,
												columnNumber: 23
											}, this)
										}, void 0, false, {
											fileName: _jsxFileName$1,
											lineNumber: 762,
											columnNumber: 19
										}, this),
										/* @__PURE__ */ (void 0)("button", {
											type: "button",
											onClick: () => seekBy(-10),
											"aria-label": "Retroceder 10 segundos",
											title: "Retroceder 10s (J / Seta esquerda)",
											className: "min-w-[40px] min-h-[40px] sm:min-w-[36px] sm:min-h-[36px] flex items-center justify-center gap-0.5 rounded-lg text-slate-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer",
											children: [/* @__PURE__ */ (void 0)(RotateCcw, { className: "w-4 h-4" }, void 0, false, {
												fileName: _jsxFileName$1,
												lineNumber: 782,
												columnNumber: 21
											}, this), /* @__PURE__ */ (void 0)("span", {
												className: "text-[11px] font-mono tabular-nums",
												children: "10"
											}, void 0, false, {
												fileName: _jsxFileName$1,
												lineNumber: 783,
												columnNumber: 21
											}, this)]
										}, void 0, true, {
											fileName: _jsxFileName$1,
											lineNumber: 775,
											columnNumber: 19
										}, this),
										/* @__PURE__ */ (void 0)("button", {
											type: "button",
											onClick: () => seekBy(10),
											"aria-label": "Avançar 10 segundos",
											title: "Avançar 10s (L / Seta direita)",
											className: "min-w-[40px] min-h-[40px] sm:min-w-[36px] sm:min-h-[36px] flex items-center justify-center gap-0.5 rounded-lg text-slate-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer",
											children: [/* @__PURE__ */ (void 0)(RotateCw, { className: "w-4 h-4" }, void 0, false, {
												fileName: _jsxFileName$1,
												lineNumber: 793,
												columnNumber: 21
											}, this), /* @__PURE__ */ (void 0)("span", {
												className: "text-[11px] font-mono tabular-nums",
												children: "10"
											}, void 0, false, {
												fileName: _jsxFileName$1,
												lineNumber: 794,
												columnNumber: 21
											}, this)]
										}, void 0, true, {
											fileName: _jsxFileName$1,
											lineNumber: 786,
											columnNumber: 19
										}, this),
										/* @__PURE__ */ (void 0)("div", {
											className: "flex items-center gap-1.5",
											children: [/* @__PURE__ */ (void 0)("button", {
												type: "button",
												onClick: toggleMute,
												"aria-label": isMuted ? "Ativar som" : "Silenciar",
												className: "min-w-[40px] min-h-[40px] sm:min-w-[36px] sm:min-h-[36px] flex items-center justify-center rounded-lg text-slate-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer",
												children: isMuted || volume === 0 ? /* @__PURE__ */ (void 0)(VolumeX, { className: "w-4 h-4" }, void 0, false, {
													fileName: _jsxFileName$1,
													lineNumber: 806,
													columnNumber: 25
												}, this) : /* @__PURE__ */ (void 0)(Volume2, { className: "w-4 h-4" }, void 0, false, {
													fileName: _jsxFileName$1,
													lineNumber: 808,
													columnNumber: 25
												}, this)
											}, void 0, false, {
												fileName: _jsxFileName$1,
												lineNumber: 799,
												columnNumber: 21
											}, this), /* @__PURE__ */ (void 0)("input", {
												type: "range",
												"aria-label": "Volume",
												min: 0,
												max: 1,
												step: .05,
												value: isMuted ? 0 : volume,
												onChange: (e) => changeVolume(Number(e.target.value)),
												className: "hidden sm:block w-16 accent-rose-500 cursor-pointer"
											}, void 0, false, {
												fileName: _jsxFileName$1,
												lineNumber: 811,
												columnNumber: 21
											}, this)]
										}, void 0, true, {
											fileName: _jsxFileName$1,
											lineNumber: 798,
											columnNumber: 19
										}, this),
										/* @__PURE__ */ (void 0)("div", {
											className: "ml-1 text-xs font-mono tabular-nums text-slate-300 whitespace-nowrap",
											children: [
												formatTime(currentTime),
												" ",
												/* @__PURE__ */ (void 0)("span", {
													className: "text-slate-500",
													children: ["/ ", formatTime(duration)]
												}, void 0, true, {
													fileName: _jsxFileName$1,
													lineNumber: 826,
													columnNumber: 21
												}, this)
											]
										}, void 0, true, {
											fileName: _jsxFileName$1,
											lineNumber: 824,
											columnNumber: 19
										}, this)
									]
								}, void 0, true, {
									fileName: _jsxFileName$1,
									lineNumber: 761,
									columnNumber: 17
								}, this), /* @__PURE__ */ (void 0)("div", {
									className: "flex items-center gap-1 relative",
									children: [/* @__PURE__ */ (void 0)("div", {
										className: "relative",
										children: [/* @__PURE__ */ (void 0)("button", {
											type: "button",
											onClick: () => setSpeedMenuOpen((prev) => !prev),
											"aria-label": "Velocidade de reprodução",
											className: "px-2.5 min-h-[36px] rounded-lg text-xs font-mono tabular-nums text-slate-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap",
											children: [playbackRate, "x"]
										}, void 0, true, {
											fileName: _jsxFileName$1,
											lineNumber: 833,
											columnNumber: 21
										}, this), speedMenuOpen && /* @__PURE__ */ (void 0)("div", {
											className: "absolute right-0 bottom-11 bg-[#11151E] border border-white/15 rounded-lg p-1 shadow-2xl min-w-[76px] z-20",
											children: SPEED_OPTIONS.map((rate) => /* @__PURE__ */ (void 0)("button", {
												type: "button",
												onClick: () => changePlaybackRate(rate),
												className: `w-full text-left px-2.5 py-1.5 rounded text-xs font-mono tabular-nums transition-colors cursor-pointer ${playbackRate === rate ? "bg-rose-600 text-white" : "text-slate-300 hover:bg-white/10 hover:text-white"}`,
												children: [rate, "x"]
											}, rate, true, {
												fileName: _jsxFileName$1,
												lineNumber: 845,
												columnNumber: 27
											}, this))
										}, void 0, false, {
											fileName: _jsxFileName$1,
											lineNumber: 843,
											columnNumber: 23
										}, this)]
									}, void 0, true, {
										fileName: _jsxFileName$1,
										lineNumber: 832,
										columnNumber: 19
									}, this), /* @__PURE__ */ (void 0)("button", {
										type: "button",
										onClick: () => void toggleFullscreen(),
										"aria-label": isFullscreen ? "Sair da tela cheia" : "Tela cheia",
										className: "min-w-[40px] min-h-[40px] sm:min-w-[36px] sm:min-h-[36px] flex items-center justify-center rounded-lg text-slate-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer",
										children: isFullscreen ? /* @__PURE__ */ (void 0)(Minimize, { className: "w-4 h-4" }, void 0, false, {
											fileName: _jsxFileName$1,
											lineNumber: 869,
											columnNumber: 23
										}, this) : /* @__PURE__ */ (void 0)(Maximize, { className: "w-4 h-4" }, void 0, false, {
											fileName: _jsxFileName$1,
											lineNumber: 871,
											columnNumber: 23
										}, this)
									}, void 0, false, {
										fileName: _jsxFileName$1,
										lineNumber: 862,
										columnNumber: 19
									}, this)]
								}, void 0, true, {
									fileName: _jsxFileName$1,
									lineNumber: 831,
									columnNumber: 17
								}, this)]
							}, void 0, true, {
								fileName: _jsxFileName$1,
								lineNumber: 760,
								columnNumber: 15
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName$1,
							lineNumber: 713,
							columnNumber: 13
						}, this)
					] }, void 0, true, {
						fileName: _jsxFileName$1,
						lineNumber: 645,
						columnNumber: 11
					}, this),
					fatalError && /* @__PURE__ */ (void 0)("div", {
						className: "absolute inset-0 bg-[#0B0E14]/95 flex flex-col items-center justify-center p-6 text-center",
						children: [
							/* @__PURE__ */ (void 0)(CircleAlert, { className: "w-10 h-10 text-rose-400 mb-3" }, void 0, false, {
								fileName: _jsxFileName$1,
								lineNumber: 883,
								columnNumber: 13
							}, this),
							/* @__PURE__ */ (void 0)("h3", {
								className: "text-base font-semibold text-white",
								children: "Falha na reprodução do vídeo"
							}, void 0, false, {
								fileName: _jsxFileName$1,
								lineNumber: 884,
								columnNumber: 13
							}, this),
							/* @__PURE__ */ (void 0)("p", {
								className: "mt-1.5 text-sm text-slate-400 max-w-md",
								children: fatalError
							}, void 0, false, {
								fileName: _jsxFileName$1,
								lineNumber: 887,
								columnNumber: 13
							}, this),
							/* @__PURE__ */ (void 0)("div", {
								className: "mt-5 flex flex-wrap items-center justify-center gap-3",
								children: /* @__PURE__ */ (void 0)("button", {
									type: "button",
									onClick: retryPlayback,
									className: "px-4 py-2 text-sm font-medium rounded-lg bg-rose-600 hover:bg-rose-500 text-white transition-colors cursor-pointer",
									children: "Tentar novamente"
								}, void 0, false, {
									fileName: _jsxFileName$1,
									lineNumber: 889,
									columnNumber: 15
								}, this)
							}, void 0, false, {
								fileName: _jsxFileName$1,
								lineNumber: 888,
								columnNumber: 13
							}, this)
						]
					}, void 0, true, {
						fileName: _jsxFileName$1,
						lineNumber: 882,
						columnNumber: 11
					}, this)
				]
			}, void 0, true, {
				fileName: _jsxFileName$1,
				lineNumber: 586,
				columnNumber: 7
			}, this),
			statusNotice && !fatalError && /* @__PURE__ */ (void 0)("p", {
				className: "text-xs text-amber-300/90",
				role: "status",
				children: statusNotice
			}, void 0, false, {
				fileName: _jsxFileName$1,
				lineNumber: 903,
				columnNumber: 9
			}, this)
		]
	}, void 0, true, {
		fileName: _jsxFileName$1,
		lineNumber: 544,
		columnNumber: 5
	}, this);
}
var _jsxFileName = "/app/applet/src/routes/e/$id.tsx?tsr-split=component";
function PublicEpisodePage() {
	const data = Route$1.useLoaderData();
	if (data.status === "db_unconfigured") return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("main", {
		className: "min-h-screen bg-[#090B10] flex items-center justify-center px-6 py-12",
		children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
			className: "max-w-md w-full bg-[#11151E] border border-white/10 rounded-xl p-8 text-center",
			children: [
				/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(TriangleAlert, { className: "w-10 h-10 text-amber-400 mx-auto mb-3" }, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 9,
					columnNumber: 11
				}, this),
				/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("h1", {
					className: "text-lg font-semibold text-white",
					children: "Banco de dados não configurado"
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 10,
					columnNumber: 11
				}, this),
				/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("p", {
					className: "mt-2 text-sm text-slate-400",
					children: [
						"Configure a variável ",
						/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("code", {
							className: "font-mono text-slate-300",
							children: "DATABASE_URL"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 12,
							columnNumber: 34
						}, this),
						" ",
						"do Neon e aplique a migration para carregar episódios."
					]
				}, void 0, true, {
					fileName: _jsxFileName,
					lineNumber: 11,
					columnNumber: 11
				}, this)
			]
		}, void 0, true, {
			fileName: _jsxFileName,
			lineNumber: 8,
			columnNumber: 9
		}, this)
	}, void 0, false, {
		fileName: _jsxFileName,
		lineNumber: 7,
		columnNumber: 12
	}, this);
	if (data.status === "not_found") return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("main", {
		className: "min-h-screen bg-[#090B10] flex items-center justify-center px-6 py-12",
		children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
			className: "max-w-md w-full bg-[#11151E] border border-white/10 rounded-xl p-8 text-center",
			children: [
				/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(Film, { className: "w-10 h-10 text-slate-500 mx-auto mb-3" }, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 21,
					columnNumber: 11
				}, this),
				/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("h1", {
					className: "text-lg font-semibold text-white",
					children: "Episódio não encontrado"
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 22,
					columnNumber: 11
				}, this),
				/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("p", {
					className: "mt-2 text-sm text-slate-400",
					children: "O link pode estar incorreto ou este episódio foi removido."
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 23,
					columnNumber: 11
				}, this)
			]
		}, void 0, true, {
			fileName: _jsxFileName,
			lineNumber: 20,
			columnNumber: 9
		}, this)
	}, void 0, false, {
		fileName: _jsxFileName,
		lineNumber: 19,
		columnNumber: 12
	}, this);
	const { episode } = data;
	return /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("main", {
		className: "min-h-screen bg-[#090B10] flex flex-col items-center justify-center px-4 sm:px-8 py-6 sm:py-10",
		children: /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("div", {
			className: "w-full max-w-5xl space-y-4",
			children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("header", {
				className: "flex items-baseline justify-between gap-4",
				children: [/* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("h1", {
					className: "text-lg sm:text-2xl font-semibold tracking-tight text-white text-balance",
					children: episode.title
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 35,
					columnNumber: 11
				}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)("span", {
					className: "text-xs text-slate-500 whitespace-nowrap shrink-0",
					children: "Player"
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 38,
					columnNumber: 11
				}, this)]
			}, void 0, true, {
				fileName: _jsxFileName,
				lineNumber: 34,
				columnNumber: 9
			}, this), /* @__PURE__ */ (0, import_jsx_dev_runtime.jsxDEV)(EpisodePlayer, {
				title: episode.title,
				posterUrl: episode.poster_url,
				sources: episode.sources
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 43,
				columnNumber: 9
			}, this)]
		}, void 0, true, {
			fileName: _jsxFileName,
			lineNumber: 33,
			columnNumber: 7
		}, this)
	}, void 0, false, {
		fileName: _jsxFileName,
		lineNumber: 32,
		columnNumber: 10
	}, this);
}
export { PublicEpisodePage as component };
