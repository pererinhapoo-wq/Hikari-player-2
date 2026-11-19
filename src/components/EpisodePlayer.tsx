import {
  AlertCircle,
  Film,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  canUseDirectMaximaimgFallback,
  classifyHlsError,
  decideHlsErrorAction,
  type PlaybackStrategy,
} from '@/lib/hls-playback';
import type { PlayableSource } from '@/lib/types';
import { getNextFallbackSourceIndex } from '@/lib/video-sources';

interface EpisodePlayerProps {
  title: string;
  posterUrl: string;
  sources: PlayableSource[];
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

export function EpisodePlayer({ title, posterUrl, sources }: EpisodePlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsInstanceRef = useRef<{ destroy: () => void } | null>(null);
  const hideControlsTimerRef = useRef<number | null>(null);

  const [hasStarted, setHasStarted] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [failedSlots, setFailedSlots] = useState<Set<number>>(() => new Set());
  const [posterError, setPosterError] = useState(false);

  // Resolved runtime mode for the active source (especially Bunny Stream -> HLS or iframe fallback)
  const [resolvedRuntime, setResolvedRuntime] = useState<{
    slot: number;
    mode: 'video' | 'hls' | 'iframe';
    url: string;
    strategy: PlaybackStrategy;
  } | null>(null);

  const attemptedDirectSlotsRef = useRef<Set<number>>(new Set());

  const [isLoadingSource, setIsLoadingSource] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  // Video element state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hoverTime, setHoverTime] = useState<{ time: number; pct: number } | null>(null);

  const activeSource = sources[activeIndex] ?? null;
  const activeSourceRef = useRef(activeSource);
  activeSourceRef.current = activeSource;

  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;

  const cleanupHls = useCallback(() => {
    if (hlsInstanceRef.current) {
      try {
        hlsInstanceRef.current.destroy();
      } catch {
        // Ignore cleanup errors
      }
      hlsInstanceRef.current = null;
    }
  }, []);

  const scheduleHideControls = useCallback(() => {
    if (hideControlsTimerRef.current) {
      window.clearTimeout(hideControlsTimerRef.current);
    }
    setControlsVisible(true);
    hideControlsTimerRef.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        setControlsVisible(false);
        setSpeedMenuOpen(false);
      }
    }, 2800);
  }, []);

  const triggerFailover = useCallback(
    (failedSlot: number, reason: string) => {
      cleanupHls();
      setFailedSlots((prev) => {
        const next = new Set(prev);
        next.add(failedSlot);
        const fallbackIdx = getNextFallbackSourceIndex(sources, activeIndex, next);
        if (fallbackIdx !== null) {
          const nextSource = sources[fallbackIdx];
          setStatusNotice(
            `${sources[activeIndex]?.label ?? 'Fonte atual'} indisponível — alternando para ${nextSource.label}...`
          );
          setActiveIndex(fallbackIdx);
          setFatalError(null);
        } else {
          setStatusNotice(null);
          setFatalError(
            reason ||
              'Não foi possível reproduzir nenhuma das fontes configuradas para este episódio.'
          );
        }
        return next;
      });
    },
    [activeIndex, cleanupHls, sources]
  );

  const triggerFailoverRef = useRef(triggerFailover);
  triggerFailoverRef.current = triggerFailover;

  // Resolve source ONLY after user clicks Play
  useEffect(() => {
    if (!hasStarted || !activeSource) return;

    let cancelled = false;
    setFatalError(null);
    setIsLoadingSource(true);
    setCurrentTime(0);
    setDuration(0);
    setBufferedEnd(0);
    setIsPlaying(false);

    async function prepareActiveSource(source: PlayableSource) {
      if (source.kind === 'iframe') {
        if (!cancelled) {
          setResolvedRuntime({
            slot: source.slot,
            mode: 'iframe',
            url: source.playUrl,
            strategy: 'iframe',
          });
          setIsLoadingSource(false);
        }
        return;
      }

      if (source.kind === 'bunny' && source.requiresServerResolve) {
        try {
          const res = await fetch(
            `/api/resolve-bunny?url=${encodeURIComponent(source.rawUrl)}`
          );
          const payload = (await res.json()) as {
            ok: boolean;
            hlsUrl?: string;
            embedUrl: string;
            reason?: string;
          };
          if (cancelled) return;
          if (payload.ok && payload.hlsUrl) {
            setResolvedRuntime({
              slot: source.slot,
              mode: 'hls',
              url: payload.hlsUrl,
              strategy: 'direct',
            });
          } else {
            setStatusNotice(
              payload.reason ?? 'Usando reprodução via embed para Bunny Stream.'
            );
            setResolvedRuntime({
              slot: source.slot,
              mode: 'iframe',
              url: payload.embedUrl || source.fallbackIframeUrl || source.playUrl,
              strategy: 'iframe',
            });
            setIsLoadingSource(false);
          }
        } catch {
          if (cancelled) return;
          if (source.fallbackIframeUrl) {
            setResolvedRuntime({
              slot: source.slot,
              mode: 'iframe',
              url: source.fallbackIframeUrl,
              strategy: 'iframe',
            });
            setIsLoadingSource(false);
          } else {
            triggerFailover(source.slot, 'Falha ao resolver fonte Bunny Stream.');
          }
        }
        return;
      }

      if (source.kind === 'hls') {
        if (!cancelled) {
          setResolvedRuntime({
            slot: source.slot,
            mode: 'hls',
            url: source.playUrl,
            strategy: source.needsProxy ? 'proxy' : 'direct',
          });
        }
        return;
      }

      // Direct mp4 / webm
      if (!cancelled) {
        setResolvedRuntime({
          slot: source.slot,
          mode: 'video',
          url: source.playUrl,
          strategy: source.needsProxy ? 'proxy' : 'direct',
        });
      }
    }

    prepareActiveSource(activeSource);

    return () => {
      cancelled = true;
    };
  }, [hasStarted, activeSource, triggerFailover]);

  // Mount video/hls.js playback ONLY after user interaction & source resolution
  useEffect(() => {
    if (!hasStarted || !resolvedRuntime || resolvedRuntime.mode === 'iframe') {
      cleanupHls();
      return;
    }

    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    cleanupHls();

    const startPlayback = async () => {
      try {
        video.playbackRate = playbackRateRef.current;
        await video.play();
      } catch {
        // Browser may require explicit interaction if switched asynchronously; keep controls visible
        setControlsVisible(true);
      }
    };

    if (resolvedRuntime.mode === 'video') {
      video.src = resolvedRuntime.url;
      video.load();
      setIsLoadingSource(false);
      void startPlayback();
      return () => {
        video.removeAttribute('src');
        video.load();
      };
    }

    // HLS mode: prefer hls.js on MSE-capable browsers (desktop + Android), native HLS on iOS/Safari
    async function attachHls() {
      const el = videoRef.current;
      if (!el || !resolvedRuntime) return;

      let networkRetriesUsed = 0;
      let mediaRecoveriesUsed = 0;

      console.info(
        `[Hikari Player] Iniciando reprodução HLS (slot=${resolvedRuntime.slot}, estratégia=${resolvedRuntime.strategy}).`
      );

      try {
        const HlsModule = await import('hls.js');
        const Hls = HlsModule.default;

        if (cancelled) return;

        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 30,
          });
          hlsInstanceRef.current = hls;

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;
            console.info(
              `[Hikari Player] Manifesto HLS carregado (slot=${resolvedRuntime.slot}, estratégia=${resolvedRuntime.strategy}).`
            );
            setIsLoadingSource(false);
            if (resolvedRuntime.strategy === 'direct') {
              setStatusNotice(null);
            }
            void startPlayback();
          });

          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (cancelled || !data.fatal) return;

            const diagnostic = classifyHlsError({
              type: data.type,
              details: data.details,
              httpCode: data.response?.code,
              url: data.url ?? data.frag?.url ?? data.context?.url ?? resolvedRuntime.url,
            });

            console.warn('[Hikari Player] Erro fatal HLS.js:', {
              slot: resolvedRuntime.slot,
              strategy: resolvedRuntime.strategy,
              category: diagnostic.category,
              type: diagnostic.type,
              details: diagnostic.details,
              httpCode: diagnostic.httpCode,
              url: diagnostic.url,
            });

            const source = activeSourceRef.current;
            if (
              diagnostic.category !== 'decode' &&
              source?.fallbackIframeUrl &&
              source.provider === 'mux'
            ) {
              setStatusNotice('Stream HLS indisponível — alternando para embed Mux.');
              setResolvedRuntime({
                slot: source.slot,
                mode: 'iframe',
                url: source.fallbackIframeUrl,
                strategy: 'iframe',
              });
              setIsLoadingSource(false);
              return;
            }

            const alreadyAttemptedDirect = attemptedDirectSlotsRef.current.has(
              resolvedRuntime.slot
            );
            const decision = decideHlsErrorAction({
              source,
              strategy: resolvedRuntime.strategy,
              alreadyAttemptedDirect,
              networkRetriesUsed,
              mediaRecoveriesUsed,
              diagnostic,
            });

            if (decision.action === 'recover_media') {
              mediaRecoveriesUsed += 1;
              hls.recoverMediaError();
              return;
            }

            if (decision.action === 'retry_load') {
              networkRetriesUsed += 1;
              console.info(
                `[Hikari Player] Tentando recuperação controlada com hls.startLoad() (slot=${resolvedRuntime.slot}, estratégia=${resolvedRuntime.strategy}).`
              );
              hls.startLoad();
              return;
            }

            if (decision.action === 'fallback_direct' && source) {
              attemptedDirectSlotsRef.current.add(resolvedRuntime.slot);
              console.warn(
                `[Hikari Player] Proxy HLS falhou (${diagnostic.category}, HTTP ${diagnostic.httpCode ?? 'N/A'}); tentando URL original direta Maximaimg (tentativa única).`
              );
              cleanupHls();
              setStatusNotice('Tentando conexão direta com o servidor de vídeo...');
              setResolvedRuntime({
                slot: resolvedRuntime.slot,
                mode: 'hls',
                url: source.resolvedUrl,
                strategy: 'direct',
              });
              return;
            }

            triggerFailoverRef.current(resolvedRuntime.slot, decision.reason);
          });

          hls.loadSource(resolvedRuntime.url);
          hls.attachMedia(el);
          return;
        }

        // Native HLS (iOS Safari / macOS Safari)
        if (el.canPlayType('application/vnd.apple.mpegurl')) {
          console.info(
            `[Hikari Player] Usando HLS nativo do navegador (slot=${resolvedRuntime.slot}, estratégia=${resolvedRuntime.strategy}).`
          );
          el.src = resolvedRuntime.url;
          el.load();
          setIsLoadingSource(false);
          void startPlayback();
          return;
        }

        triggerFailoverRef.current(
          resolvedRuntime.slot,
          'Este navegador não oferece suporte à reprodução HLS.'
        );
      } catch {
        if (!cancelled) {
          triggerFailoverRef.current(
            resolvedRuntime.slot,
            'Erro ao inicializar motor de reprodução HLS.'
          );
        }
      }
    }

    void attachHls();

    return () => {
      cancelled = true;
      cleanupHls();
    };
  }, [hasStarted, resolvedRuntime, cleanupHls]);

  // Apply playbackRate changes without tearing down or remounting HLS.js / video
  useEffect(() => {
    const video = videoRef.current;
    if (video && video.playbackRate !== playbackRate) {
      video.playbackRate = playbackRate;
    }
  }, [playbackRate, resolvedRuntime]);

  // Sync fullscreen state
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
    scheduleHideControls();
  }, [scheduleHideControls]);

  const seekBy = useCallback(
    (deltaSeconds: number) => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(video.duration)) return;
      const target = Math.max(0, Math.min(video.duration, video.currentTime + deltaSeconds));
      video.currentTime = target;
      setCurrentTime(target);
      scheduleHideControls();
    },
    [scheduleHideControls]
  );

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !video.muted;
    video.muted = nextMuted;
    setIsMuted(nextMuted);
    scheduleHideControls();
  }, [scheduleHideControls]);

  const changeVolume = useCallback(
    (nextVol: number) => {
      const clamped = Math.max(0, Math.min(1, nextVol));
      const video = videoRef.current;
      if (video) {
        video.volume = clamped;
        video.muted = clamped === 0;
      }
      setVolume(clamped);
      setIsMuted(clamped === 0);
      scheduleHideControls();
    },
    [scheduleHideControls]
  );

  const changePlaybackRate = useCallback(
    (rate: number) => {
      setPlaybackRate(rate);
      if (videoRef.current) {
        videoRef.current.playbackRate = rate;
      }
      setSpeedMenuOpen(false);
      scheduleHideControls();
    },
    [scheduleHideControls]
  );

  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!container) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (container.requestFullscreen) {
        await container.requestFullscreen();
      } else if (video?.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      }
    } catch {
      if (video?.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      }
    }
    scheduleHideControls();
  }, [scheduleHideControls]);

  // Keyboard shortcuts while player is active in video/hls mode
  useEffect(() => {
    if (!hasStarted || resolvedRuntime?.mode === 'iframe') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlayPause();
          break;
        case 'arrowleft':
        case 'j':
          e.preventDefault();
          seekBy(-10);
          break;
        case 'arrowright':
        case 'l':
          e.preventDefault();
          seekBy(10);
          break;
        case 'arrowup':
          e.preventDefault();
          changeVolume((videoRef.current?.volume ?? volume) + 0.1);
          break;
        case 'arrowdown':
          e.preventDefault();
          changeVolume((videoRef.current?.volume ?? volume) - 0.1);
          break;
        case 'm':
          e.preventDefault();
          toggleMute();
          break;
        case 'f':
          e.preventDefault();
          void toggleFullscreen();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    hasStarted,
    resolvedRuntime?.mode,
    togglePlayPause,
    seekBy,
    changeVolume,
    volume,
    toggleMute,
    toggleFullscreen,
  ]);

  const selectSourceManually = (index: number) => {
    attemptedDirectSlotsRef.current.delete(sources[index].slot);
    setFailedSlots((prev) => {
      const next = new Set(prev);
      next.delete(sources[index].slot);
      return next;
    });
    setStatusNotice(null);
    setFatalError(null);
    setActiveIndex(index);
    if (!hasStarted) {
      setHasStarted(true);
    }
  };

  const retryPlayback = () => {
    attemptedDirectSlotsRef.current.clear();
    setFailedSlots(new Set());
    setFatalError(null);
    setStatusNotice(null);
    setActiveIndex(0);
    setResolvedRuntime(null);
    setHasStarted(true);
  };

  const progressPct = useMemo(() => {
    if (!duration || duration <= 0) return 0;
    return Math.min(100, Math.max(0, (currentTime / duration) * 100));
  }, [currentTime, duration]);

  const bufferedPct = useMemo(() => {
    if (!duration || duration <= 0) return 0;
    return Math.min(100, Math.max(0, (bufferedEnd / duration) * 100));
  }, [bufferedEnd, duration]);

  if (sources.length === 0) {
    return (
      <div className="w-full aspect-video bg-[#11151E] border border-white/10 rounded-xl flex flex-col items-center justify-center p-8 text-center">
        <AlertCircle className="w-10 h-10 text-rose-400 mb-3" />
        <h2 className="text-lg font-semibold text-white">Nenhuma fonte de vídeo válida</h2>
        <p className="mt-1.5 text-sm text-slate-400 max-w-md">
          Este episódio ainda não possui uma URL de reprodução configurada.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full space-y-3">
      {/* Segmented source selector when multiple sources exist */}
      {sources.length > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="Fontes de vídeo disponíveis"
            className="inline-flex flex-wrap items-center gap-1 p-1 bg-[#11151E] border border-white/10 rounded-lg"
          >
            {sources.map((src, idx) => {
              const isActive = idx === activeIndex;
              const isFailed = failedSlots.has(src.slot);
              return (
                <button
                  key={src.slot}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => selectSourceManually(idx)}
                  className={`px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 ${
                    isActive
                      ? 'bg-rose-600 text-white'
                      : isFailed
                        ? 'text-slate-500 hover:text-slate-300 line-through'
                        : 'text-slate-300 hover:text-white hover:bg-white/5'
                  }`}
                >
                  {src.label}
                </button>
              );
            })}
          </div>

          {activeSource && (
            <span className="text-xs text-slate-400 font-mono tabular-nums">
              {activeSource.formatLabel}
            </span>
          )}
        </div>
      )}

      {/* Cinema stage */}
      <div
        ref={containerRef}
        onMouseMove={hasStarted ? scheduleHideControls : undefined}
        onTouchStart={hasStarted ? scheduleHideControls : undefined}
        className="relative w-full aspect-video bg-black border border-white/10 rounded-xl overflow-hidden select-none group"
      >
        {/* INITIAL GATE: Static cover + Play button (no video/iframe/hls mounted before click) */}
        {!hasStarted && (
          <div className="absolute inset-0">
            {!posterError && posterUrl ? (
              <img
                src={posterUrl}
                alt={`Capa de ${title}`}
                referrerPolicy="no-referrer"
                onError={() => setPosterError(true)}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-[#141926] via-[#0D1018] to-[#090B10] flex items-center justify-center">
                <Film className="w-16 h-16 text-slate-600" />
              </div>
            )}

            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-black/30" />

            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
              <button
                type="button"
                onClick={() => {
                  setHasStarted(true);
                  scheduleHideControls();
                }}
                aria-label={`Reproduzir ${title}`}
                className="w-20 h-20 rounded-full bg-rose-600 hover:bg-rose-500 active:scale-95 text-white flex items-center justify-center shadow-xl transition-transform duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-rose-500/50 cursor-pointer"
              >
                <Play className="w-8 h-8 fill-current ml-1" />
              </button>
              <span className="mt-4 text-sm font-medium text-white/90">
                Clique para reproduzir
              </span>
            </div>
          </div>
        )}

        {/* ACTIVE PLAYBACK: Iframe mode */}
        {hasStarted && resolvedRuntime?.mode === 'iframe' && !fatalError && (
          <iframe
            key={`${resolvedRuntime.slot}-${resolvedRuntime.url}`}
            src={resolvedRuntime.url}
            title={title}
            className="w-full h-full border-0 bg-black"
            allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
            allowFullScreen
            referrerPolicy="no-referrer-when-downgrade"
          />
        )}

        {/* ACTIVE PLAYBACK: HTML5 Video / HLS mode */}
        {hasStarted && resolvedRuntime && resolvedRuntime.mode !== 'iframe' && !fatalError && (
          <>
            <video
              ref={videoRef}
              poster={posterError ? undefined : posterUrl}
              playsInline
              preload="metadata"
              onClick={togglePlayPause}
              onLoadStart={() => setIsLoadingSource(true)}
              onCanPlay={() => setIsLoadingSource(false)}
              onPlay={() => {
                setIsPlaying(true);
                setIsLoadingSource(false);
                scheduleHideControls();
              }}
              onPause={() => {
                setIsPlaying(false);
                setControlsVisible(true);
              }}
              onTimeUpdate={() => {
                const v = videoRef.current;
                if (!v) return;
                setCurrentTime(v.currentTime);
                if (v.buffered.length > 0) {
                  setBufferedEnd(v.buffered.end(v.buffered.length - 1));
                }
              }}
              onLoadedMetadata={() => {
                const v = videoRef.current;
                if (!v) return;
                setDuration(Number.isFinite(v.duration) ? v.duration : 0);
              }}
              onVolumeChange={() => {
                const v = videoRef.current;
                if (!v) return;
                setVolume(v.volume);
                setIsMuted(v.muted);
              }}
              onError={() => {
                if (
                  activeSource &&
                  resolvedRuntime?.mode === 'hls' &&
                  canUseDirectMaximaimgFallback(
                    activeSource,
                    resolvedRuntime.strategy,
                    attemptedDirectSlotsRef.current.has(activeSource.slot)
                  )
                ) {
                  attemptedDirectSlotsRef.current.add(activeSource.slot);
                  console.warn(
                    `[Hikari Player] Reprodução HLS via proxy falhou no elemento de vídeo (slot=${activeSource.slot}); tentando URL original direta Maximaimg.`
                  );
                  cleanupHls();
                  setStatusNotice('Tentando conexão direta com o servidor de vídeo...');
                  setResolvedRuntime({
                    slot: activeSource.slot,
                    mode: 'hls',
                    url: activeSource.resolvedUrl,
                    strategy: 'direct',
                  });
                  return;
                }
                if (activeSource) {
                  triggerFailover(
                    activeSource.slot,
                    'Não foi possível carregar este vídeo nesta fonte.'
                  );
                }
              }}
              className="w-full h-full object-contain bg-black cursor-pointer"
            />

            {/* Loading spinner overlay */}
            {isLoadingSource && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40">
                <div className="w-10 h-10 rounded-full border-2 border-white/25 border-t-rose-500 animate-spin" />
              </div>
            )}

            {/* Center Play/Pause indicator when paused */}
            {!isPlaying && !isLoadingSource && (
              <button
                type="button"
                onClick={togglePlayPause}
                aria-label="Continuar reprodução"
                className="absolute inset-0 m-auto w-16 h-16 rounded-full bg-black/65 hover:bg-rose-600 text-white flex items-center justify-center border border-white/15 transition-colors cursor-pointer"
              >
                <Play className="w-7 h-7 fill-current ml-0.5" />
              </button>
            )}

            {/* Custom Controls Bar */}
            <div
              className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent pt-10 pb-3 px-3 sm:px-4 transition-opacity duration-200 ${
                controlsVisible || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
            >
              {/* Scrubber */}
              <div
                className="relative h-5 flex items-center cursor-pointer group/bar"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  if (videoRef.current && duration > 0) {
                    const target = pct * duration;
                    videoRef.current.currentTime = target;
                    setCurrentTime(target);
                  }
                }}
                onMouseMove={(e) => {
                  if (duration <= 0) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  setHoverTime({ time: pct * duration, pct: pct * 100 });
                }}
                onMouseLeave={() => setHoverTime(null)}
              >
                {hoverTime && (
                  <div
                    style={{ left: `${hoverTime.pct}%` }}
                    className="hidden sm:block absolute -top-7 -translate-x-1/2 px-2 py-0.5 rounded bg-black/90 border border-white/15 text-[11px] font-mono tabular-nums text-white pointer-events-none"
                  >
                    {formatTime(hoverTime.time)}
                  </div>
                )}

                <div className="w-full h-1.5 group-hover/bar:h-2 transition-all rounded-full bg-white/20 overflow-hidden relative">
                  <div
                    className="absolute inset-y-0 left-0 bg-white/30"
                    style={{ width: `${bufferedPct}%` }}
                  />
                  <div
                    className="absolute inset-y-0 left-0 bg-rose-500"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>

              {/* Control buttons row */}
              <div className="mt-1 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1 sm:gap-2">
                  <button
                    type="button"
                    onClick={togglePlayPause}
                    aria-label={isPlaying ? 'Pausar' : 'Reproduzir'}
                    className="min-w-[40px] min-h-[40px] sm:min-w-[36px] sm:min-h-[36px] flex items-center justify-center rounded-lg text-white hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    {isPlaying ? (
                      <Pause className="w-5 h-5 fill-current" />
                    ) : (
                      <Play className="w-5 h-5 fill-current" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => seekBy(-10)}
                    aria-label="Retroceder 10 segundos"
                    title="Retroceder 10s (J / Seta esquerda)"
                    className="min-w-[40px] min-h-[40px] sm:min-w-[36px] sm:min-h-[36px] flex items-center justify-center gap-0.5 rounded-lg text-slate-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span className="text-[11px] font-mono tabular-nums">10</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => seekBy(10)}
                    aria-label="Avançar 10 segundos"
                    title="Avançar 10s (L / Seta direita)"
                    className="min-w-[40px] min-h-[40px] sm:min-w-[36px] sm:min-h-[36px] flex items-center justify-center gap-0.5 rounded-lg text-slate-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <RotateCw className="w-4 h-4" />
                    <span className="text-[11px] font-mono tabular-nums">10</span>
                  </button>

                  {/* Volume */}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={toggleMute}
                      aria-label={isMuted ? 'Ativar som' : 'Silenciar'}
                      className="min-w-[40px] min-h-[40px] sm:min-w-[36px] sm:min-h-[36px] flex items-center justify-center rounded-lg text-slate-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                    >
                      {isMuted || volume === 0 ? (
                        <VolumeX className="w-4 h-4" />
                      ) : (
                        <Volume2 className="w-4 h-4" />
                      )}
                    </button>
                    <input
                      type="range"
                      aria-label="Volume"
                      min={0}
                      max={1}
                      step={0.05}
                      value={isMuted ? 0 : volume}
                      onChange={(e) => changeVolume(Number(e.target.value))}
                      className="hidden sm:block w-16 accent-rose-500 cursor-pointer"
                    />
                  </div>

                  {/* Timecode */}
                  <div className="ml-1 text-xs font-mono tabular-nums text-slate-300 whitespace-nowrap">
                    {formatTime(currentTime)}{' '}
                    <span className="text-slate-500">/ {formatTime(duration)}</span>
                  </div>
                </div>

                {/* Right controls: Speed + Fullscreen */}
                <div className="flex items-center gap-1 relative">
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setSpeedMenuOpen((prev) => !prev)}
                      aria-label="Velocidade de reprodução"
                      className="px-2.5 min-h-[36px] rounded-lg text-xs font-mono tabular-nums text-slate-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {playbackRate}x
                    </button>

                    {speedMenuOpen && (
                      <div className="absolute right-0 bottom-11 bg-[#11151E] border border-white/15 rounded-lg p-1 shadow-2xl min-w-[76px] z-20">
                        {SPEED_OPTIONS.map((rate) => (
                          <button
                            key={rate}
                            type="button"
                            onClick={() => changePlaybackRate(rate)}
                            className={`w-full text-left px-2.5 py-1.5 rounded text-xs font-mono tabular-nums transition-colors cursor-pointer ${
                              playbackRate === rate
                                ? 'bg-rose-600 text-white'
                                : 'text-slate-300 hover:bg-white/10 hover:text-white'
                            }`}
                          >
                            {rate}x
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => void toggleFullscreen()}
                    aria-label={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
                    className="min-w-[40px] min-h-[40px] sm:min-w-[36px] sm:min-h-[36px] flex items-center justify-center rounded-lg text-slate-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    {isFullscreen ? (
                      <Minimize className="w-4 h-4" />
                    ) : (
                      <Maximize className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* FATAL ERROR OVERLAY */}
        {fatalError && (
          <div className="absolute inset-0 bg-[#0B0E14]/95 flex flex-col items-center justify-center p-6 text-center">
            <AlertCircle className="w-10 h-10 text-rose-400 mb-3" />
            <h3 className="text-base font-semibold text-white">
              Falha na reprodução do vídeo
            </h3>
            <p className="mt-1.5 text-sm text-slate-400 max-w-md">{fatalError}</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={retryPlayback}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-rose-600 hover:bg-rose-500 text-white transition-colors cursor-pointer"
              >
                Tentar novamente
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Transient failover or adapter notice */}
      {statusNotice && !fatalError && (
        <p className="text-xs text-amber-300/90" role="status">
          {statusNotice}
        </p>
      )}
    </div>
  );
}
