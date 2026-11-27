import {
  AlertCircle,
  Film,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  canUseDirectMaximaimgFallback,
  classifyHlsError,
  decideHlsErrorAction,
  type PlaybackStrategy,
} from '@/lib/hls-playback';
import { isOpeningSkipVisible } from '@/lib/opening-skip';
import type { PlayableSource } from '@/lib/types';
import {
  buildIframeSrcWithFreshTime,
  getIframeElementProps,
  getNextFallbackSourceIndex,
  isDirectMediaUrl,
  isVercelBlobUrl,
} from '@/lib/video-sources';

interface EpisodePlayerProps {
  title: string;
  posterUrl: string;
  sources: PlayableSource[];
  openingStartSeconds?: number | null;
  openingEndSeconds?: number | null;
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

export function EpisodePlayer({
  title,
  posterUrl,
  sources,
  openingStartSeconds = null,
  openingEndSeconds = null,
}: EpisodePlayerProps) {
  const prefersReducedMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubberRef = useRef<HTMLDivElement>(null);
  const hlsInstanceRef = useRef<{ destroy: () => void } | null>(null);
  const hideControlsTimerRef = useRef<number | null>(null);
  const singleTapTimerRef = useRef<number | null>(null);
  const seekFeedbackTimerRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

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
  const iframeLoadTimerRef = useRef<number | null>(null);

  const [iframeReloadKey, setIframeReloadKey] = useState(0);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [isLoadingSource, setIsLoadingSource] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [fatalErrorKind, setFatalErrorKind] = useState<'iframe' | 'media' | null>(null);

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
  const [isSeeking, setIsSeeking] = useState(false);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [isAdjustingVolume, setIsAdjustingVolume] = useState(false);
  const [isHoveringControls, setIsHoveringControls] = useState(false);
  const [seekFeedback, setSeekFeedback] = useState<{
    side: 'left' | 'right';
    seconds: number;
    key: number;
  } | null>(null);

  const safeActiveIndex =
    activeIndex >= 0 && activeIndex < sources.length ? activeIndex : 0;
  const activeSource = sources[safeActiveIndex] ?? null;
  const activeSourceRef = useRef(activeSource);
  activeSourceRef.current = activeSource;

  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;

  const speedMenuOpenRef = useRef(speedMenuOpen);
  speedMenuOpenRef.current = speedMenuOpen;

  const isSeekingRef = useRef(isSeeking);
  isSeekingRef.current = isSeeking;

  const isAdjustingVolumeRef = useRef(isAdjustingVolume);
  isAdjustingVolumeRef.current = isAdjustingVolume;

  const isHoveringControlsRef = useRef(isHoveringControls);
  isHoveringControlsRef.current = isHoveringControls;

  const controlsVisibleRef = useRef(controlsVisible);
  controlsVisibleRef.current = controlsVisible;

  const pointerDownInfoRef = useRef<{
    pointerId: number;
    pointerType: string;
    x: number;
    y: number;
  } | null>(null);
  const lastTouchTapRef = useRef<{
    time: number;
    region: 'left' | 'center' | 'right';
  } | null>(null);
  const activeScrubPointerIdRef = useRef<number | null>(null);

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

  const clearHideControlsTimer = useCallback(() => {
    if (hideControlsTimerRef.current !== null) {
      window.clearTimeout(hideControlsTimerRef.current);
      hideControlsTimerRef.current = null;
    }
  }, []);

  const hasAutoHideBlocker = useCallback(() => {
    return (
      speedMenuOpenRef.current ||
      isSeekingRef.current ||
      isAdjustingVolumeRef.current ||
      isHoveringControlsRef.current
    );
  }, []);

  const scheduleHideControls = useCallback(() => {
    clearHideControlsTimer();
    setControlsVisible(true);
    if (hasAutoHideBlocker()) {
      return;
    }
    hideControlsTimerRef.current = window.setTimeout(() => {
      hideControlsTimerRef.current = null;
      if (!isMountedRef.current) return;
      if (
        videoRef.current &&
        !videoRef.current.paused &&
        !speedMenuOpenRef.current &&
        !isSeekingRef.current &&
        !isAdjustingVolumeRef.current &&
        !isHoveringControlsRef.current
      ) {
        setControlsVisible(false);
      }
    }, 3000);
  }, [clearHideControlsTimer, hasAutoHideBlocker]);

  const clearIframeLoadTimer = useCallback(() => {
    if (iframeLoadTimerRef.current !== null) {
      window.clearTimeout(iframeLoadTimerRef.current);
      iframeLoadTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearHideControlsTimer();
      clearIframeLoadTimer();
      if (singleTapTimerRef.current !== null) {
        window.clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      if (seekFeedbackTimerRef.current !== null) {
        window.clearTimeout(seekFeedbackTimerRef.current);
        seekFeedbackTimerRef.current = null;
      }
    };
  }, [clearHideControlsTimer, clearIframeLoadTimer]);

  // Keep controls visible during active interactions and restart 3s timer when finished
  useEffect(() => {
    if (!hasStarted || resolvedRuntime?.mode === 'iframe') return;

    if (
      !isPlaying ||
      speedMenuOpen ||
      isSeeking ||
      isAdjustingVolume ||
      isHoveringControls
    ) {
      clearHideControlsTimer();
      setControlsVisible(true);
      return;
    }

    if (controlsVisibleRef.current) {
      scheduleHideControls();
    }
  }, [
    hasStarted,
    resolvedRuntime?.mode,
    isPlaying,
    speedMenuOpen,
    isSeeking,
    isAdjustingVolume,
    isHoveringControls,
    clearHideControlsTimer,
    scheduleHideControls,
  ]);

  // Ensure volume-slider interaction lock never sticks if pointer is released outside slider
  useEffect(() => {
    if (!isAdjustingVolume) return;
    const stopAdjusting = () => {
      setIsAdjustingVolume(false);
    };
    window.addEventListener('pointerup', stopAdjusting);
    window.addEventListener('pointercancel', stopAdjusting);
    return () => {
      window.removeEventListener('pointerup', stopAdjusting);
      window.removeEventListener('pointercancel', stopAdjusting);
    };
  }, [isAdjustingVolume]);

  const triggerFailover = useCallback(
    (failedSlot: number, reason: string, errorKind: 'iframe' | 'media' = 'media') => {
      clearIframeLoadTimer();
      cleanupHls();

      setFailedSlots((prev) => {
        const next = new Set(prev);
        next.add(failedSlot);
        const fallbackIdx = getNextFallbackSourceIndex(sources, safeActiveIndex, next);
        if (fallbackIdx !== null) {
          const nextSource = sources[fallbackIdx];
          const failureLabel =
            errorKind === 'iframe'
              ? 'player do provedor não carregou'
              : 'fonte indisponível';
          setStatusNotice(
            `${sources[safeActiveIndex]?.label ?? 'Fonte atual'} (${failureLabel}) — alternando para ${nextSource.label}...`
          );
          setActiveIndex(fallbackIdx);
          setFatalError(null);
          setFatalErrorKind(null);
        } else {
          setStatusNotice(null);
          setFatalErrorKind(errorKind);
          setFatalError(
            reason ||
              (errorKind === 'iframe'
                ? 'Player do provedor não carregou.'
                : 'Fonte indisponível.')
          );
        }
        return next;
      });
    },
    [safeActiveIndex, cleanupHls, clearIframeLoadTimer, sources]
  );

  const triggerFailoverRef = useRef(triggerFailover);
  triggerFailoverRef.current = triggerFailover;

  // Resolve source ONLY after user clicks Play
  useEffect(() => {
    if (!hasStarted || !activeSource) return;

    let cancelled = false;
    setFatalError(null);
    setFatalErrorKind(null);
    setIsLoadingSource(true);
    setCurrentTime(0);
    setDuration(0);
    setBufferedEnd(0);
    setIsPlaying(false);

    async function prepareActiveSource(source: PlayableSource) {
      const isBlobDirect =
        isDirectMediaUrl(source.resolvedUrl) ||
        isDirectMediaUrl(source.rawUrl) ||
        isVercelBlobUrl(source.resolvedUrl) ||
        isVercelBlobUrl(source.rawUrl);
      if (isBlobDirect) {
        clearIframeLoadTimer();
        if (!cancelled) {
          setResolvedRuntime({
            slot: source.slot,
            mode: 'video',
            url: source.resolvedUrl || source.rawUrl,
            strategy: 'direct',
          });
        }
        return;
      }

      if (source.kind === 'iframe') {
        clearIframeLoadTimer();
        if (!cancelled) {
          const freshUrl = buildIframeSrcWithFreshTime(source.playUrl);
          setIframeLoaded(false);
          setResolvedRuntime({
            slot: source.slot,
            mode: 'iframe',
            url: freshUrl,
            strategy: 'iframe',
          });
          setIsLoadingSource(true);
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
  }, [hasStarted, activeSource, iframeReloadKey, clearIframeLoadTimer, triggerFailover]);

  // Timeout de 12s para detectar falha de carregamento do iframe do provedor
  useEffect(() => {
    clearIframeLoadTimer();
    if (!hasStarted || resolvedRuntime?.mode !== 'iframe' || fatalError || iframeLoaded) {
      return;
    }

    const targetSlot = resolvedRuntime.slot;
    iframeLoadTimerRef.current = window.setTimeout(() => {
      iframeLoadTimerRef.current = null;
      if (!isMountedRef.current) return;
      setIsLoadingSource(false);
      triggerFailoverRef.current(
        targetSlot,
        'Player do provedor não carregou.',
        'iframe'
      );
    }, 12000);

    return () => {
      clearIframeLoadTimer();
    };
  }, [hasStarted, resolvedRuntime, iframeLoaded, fatalError, clearIframeLoadTimer]);

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
      if (video.getAttribute('src') !== resolvedRuntime.url) {
        video.src = resolvedRuntime.url;
        video.load();
      }
      setIsLoadingSource(false);
      void startPlayback();
      return () => {
        video.pause();
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

  // Sync fullscreen state (standard + iOS Safari webkitbeginfullscreen/webkitendfullscreen)
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    const onWebkitBegin = () => setIsFullscreen(true);
    const onWebkitEnd = () => setIsFullscreen(false);

    document.addEventListener('fullscreenchange', onFsChange);
    const video = videoRef.current;
    if (video) {
      video.addEventListener('webkitbeginfullscreen', onWebkitBegin);
      video.addEventListener('webkitendfullscreen', onWebkitEnd);
    }
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      if (video) {
        video.removeEventListener('webkitbeginfullscreen', onWebkitBegin);
        video.removeEventListener('webkitendfullscreen', onWebkitEnd);
      }
    };
  }, [hasStarted, resolvedRuntime?.mode]);

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

  const handleSkipOpening = useCallback(() => {
    const video = videoRef.current;
    if (
      !video ||
      typeof openingEndSeconds !== 'number' ||
      !Number.isFinite(openingEndSeconds)
    ) {
      return;
    }
    const maxTime =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : openingEndSeconds;
    const targetTime = Math.min(openingEndSeconds, maxTime);
    video.currentTime = targetTime;
    setCurrentTime(targetTime);
    scheduleHideControls();
  }, [openingEndSeconds, scheduleHideControls]);

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

  const showSeekFeedback = useCallback((side: 'left' | 'right', seconds: number) => {
    if (seekFeedbackTimerRef.current !== null) {
      window.clearTimeout(seekFeedbackTimerRef.current);
    }
    setSeekFeedback({ side, seconds, key: Date.now() });
    seekFeedbackTimerRef.current = window.setTimeout(() => {
      seekFeedbackTimerRef.current = null;
      if (isMountedRef.current) {
        setSeekFeedback(null);
      }
    }, 650);
  }, []);

  const getScrubTimeFromClientX = useCallback(
    (clientX: number): { time: number; pct: number } | null => {
      const bar = scrubberRef.current;
      if (!bar || !Number.isFinite(duration) || duration <= 0) return null;
      const rect = bar.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return { time: pct * duration, pct: pct * 100 };
    },
    [duration]
  );

  const handleScrubberPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      activeScrubPointerIdRef.current = e.pointerId;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture is unsupported
      }
      isSeekingRef.current = true;
      setIsSeeking(true);
      clearHideControlsTimer();
      setControlsVisible(true);

      const pos = getScrubTimeFromClientX(e.clientX);
      if (pos) {
        setScrubTime(pos.time);
        setHoverTime(pos);
      }
    },
    [clearHideControlsTimer, getScrubTimeFromClientX]
  );

  const handleScrubberPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const pos = getScrubTimeFromClientX(e.clientX);
      if (!pos) return;
      if (e.pointerType !== 'touch' || isSeekingRef.current) {
        setHoverTime(pos);
      }
      if (isSeekingRef.current && activeScrubPointerIdRef.current === e.pointerId) {
        setScrubTime(pos.time);
      }
    },
    [getScrubTimeFromClientX]
  );

  const finishScrub = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, commitSeek: boolean) => {
      if (!isSeekingRef.current || activeScrubPointerIdRef.current !== e.pointerId) {
        return;
      }
      e.stopPropagation();
      activeScrubPointerIdRef.current = null;
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore release errors
      }

      const pos = getScrubTimeFromClientX(e.clientX);
      const targetTime = pos ? pos.time : scrubTime;
      if (commitSeek && videoRef.current && targetTime !== null && Number.isFinite(targetTime)) {
        videoRef.current.currentTime = targetTime;
        setCurrentTime(targetTime);
      }

      isSeekingRef.current = false;
      setIsSeeking(false);
      setScrubTime(null);
      if (e.pointerType === 'touch') {
        setHoverTime(null);
      }
      scheduleHideControls();
    },
    [getScrubTimeFromClientX, scheduleHideControls, scrubTime]
  );

  const handleStagePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch' && e.button !== 0) return;
    pointerDownInfoRef.current = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      x: e.clientX,
      y: e.clientY,
    };
  }, []);

  const handleStagePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const down = pointerDownInfoRef.current;
      pointerDownInfoRef.current = null;
      if (!down || down.pointerId !== e.pointerId) return;

      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (moved > 12) {
        return;
      }

      // Mouse / pen click preserves immediate Play/Pause behavior
      if (e.pointerType !== 'touch') {
        if (speedMenuOpenRef.current) {
          setSpeedMenuOpen(false);
        }
        togglePlayPause();
        return;
      }

      // Touch gestures: single tap toggles controls (never play/pause); double tap seeks or toggles fullscreen
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
      const region: 'left' | 'center' | 'right' =
        ratio < 0.35 ? 'left' : ratio > 0.65 ? 'right' : 'center';

      const now = Date.now();
      const lastTap = lastTouchTapRef.current;

      if (lastTap && now - lastTap.time <= 250 && lastTap.region === region) {
        if (singleTapTimerRef.current !== null) {
          window.clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }
        lastTouchTapRef.current = null;

        if (region === 'left') {
          seekBy(-10);
          showSeekFeedback('left', 10);
        } else if (region === 'right') {
          seekBy(10);
          showSeekFeedback('right', 10);
        } else {
          void toggleFullscreen();
        }
        return;
      }

      lastTouchTapRef.current = { time: now, region };
      if (singleTapTimerRef.current !== null) {
        window.clearTimeout(singleTapTimerRef.current);
      }

      singleTapTimerRef.current = window.setTimeout(() => {
        singleTapTimerRef.current = null;
        lastTouchTapRef.current = null;
        if (!isMountedRef.current) return;

        if (speedMenuOpenRef.current) {
          setSpeedMenuOpen(false);
          scheduleHideControls();
          return;
        }

        if (videoRef.current && videoRef.current.paused) {
          setControlsVisible(true);
          return;
        }

        if (controlsVisibleRef.current) {
          clearHideControlsTimer();
          setControlsVisible(false);
        } else {
          scheduleHideControls();
        }
      }, 250);
    },
    [clearHideControlsTimer, scheduleHideControls, seekBy, showSeekFeedback, toggleFullscreen, togglePlayPause]
  );

  const handleStagePointerCancel = useCallback(() => {
    pointerDownInfoRef.current = null;
  }, []);

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

      if (e.key === 'Escape' && speedMenuOpenRef.current) {
        e.preventDefault();
        setSpeedMenuOpen(false);
        scheduleHideControls();
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
    scheduleHideControls,
  ]);

  const selectSourceManually = (index: number, preserveNotice = false) => {
    const target = sources[index];
    if (!target) return;
    clearIframeLoadTimer();
    attemptedDirectSlotsRef.current.delete(target.slot);
    setFailedSlots((prev) => {
      const next = new Set(prev);
      next.delete(target.slot);
      return next;
    });
    if (!preserveNotice) {
      setStatusNotice(null);
    }
    setFatalError(null);
    setFatalErrorKind(null);
    setIframeLoaded(false);
    setIframeReloadKey((prev) => prev + 1);
    setActiveIndex(index);
    if (!hasStarted) {
      setHasStarted(true);
    }
  };

  const reloadIframeSource = () => {
    clearIframeLoadTimer();
    const targetSlot = activeSource?.slot ?? resolvedRuntime?.slot;
    if (targetSlot !== undefined) {
      setFailedSlots((prev) => {
        const next = new Set(prev);
        next.delete(targetSlot);
        return next;
      });
    }
    setFatalError(null);
    setFatalErrorKind(null);
    setStatusNotice(null);
    setIframeLoaded(false);
    setIframeReloadKey((prev) => prev + 1);
    setHasStarted(true);
  };

  const retryPlayback = () => {
    clearIframeLoadTimer();
    attemptedDirectSlotsRef.current.clear();
    setFailedSlots(new Set());
    setFatalError(null);
    setFatalErrorKind(null);
    setStatusNotice(null);
    setIframeLoaded(false);
    setIframeReloadKey((prev) => prev + 1);
    setActiveIndex(0);
    setResolvedRuntime(null);
    setHasStarted(true);
  };

  const displayedTime = scrubTime ?? currentTime;

  const showSkipOpening = isOpeningSkipVisible({
    currentTime,
    openingStartSeconds,
    openingEndSeconds,
    hasStarted,
    isIframeMode: resolvedRuntime?.mode === 'iframe',
    fatalError: Boolean(fatalError),
  });

  const progressPct = useMemo(() => {
    if (!duration || duration <= 0) return 0;
    return Math.min(100, Math.max(0, (displayedTime / duration) * 100));
  }, [displayedTime, duration]);

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
      {/* Segmented source selector when multiple sources exist (or iframe reload control) */}
      {(sources.length > 1 || (hasStarted && activeSource?.kind === 'iframe')) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {sources.length > 1 ? (
            <div
              role="tablist"
              aria-label="Fontes de vídeo disponíveis"
              className="inline-flex flex-wrap items-center gap-1 p-1 bg-[#11151E] border border-white/10 rounded-lg"
            >
              {sources.map((src, idx) => {
                const isActive = idx === safeActiveIndex;
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
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2.5">
            {hasStarted && activeSource?.kind === 'iframe' && (
              <button
                type="button"
                onClick={reloadIframeSource}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/10 bg-[#11151E] hover:bg-white/5 text-xs font-medium text-slate-200 transition-colors cursor-pointer whitespace-nowrap"
              >
                <RotateCw className="w-3.5 h-3.5" />
                Recarregar fonte
              </button>
            )}
            {activeSource && (
              <span className="text-xs text-slate-400 font-mono tabular-nums">
                {activeSource.formatLabel}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Cinema stage */}
      <div
        ref={containerRef}
        onPointerMove={
          hasStarted && resolvedRuntime?.mode !== 'iframe'
            ? (e) => {
                if (e.pointerType !== 'touch') {
                  scheduleHideControls();
                }
              }
            : undefined
        }
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
                className="w-20 h-20 rounded-full bg-[#a855f7] hover:bg-[#9333ea] active:scale-95 text-white flex items-center justify-center shadow-[0_0_30px_rgba(168,85,247,0.45)] transition-transform duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#a855f7]/50 cursor-pointer"
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
        {hasStarted && resolvedRuntime?.mode === 'iframe' && !fatalError && (() => {
          const iframeProps = getIframeElementProps(resolvedRuntime.url);
          return (
            <>
              <iframe
                key={`${resolvedRuntime.slot}-${iframeReloadKey}-${resolvedRuntime.url}`}
                src={resolvedRuntime.url}
                title={title}
                onLoad={() => {
                  clearIframeLoadTimer();
                  setIframeLoaded(true);
                  setIsLoadingSource(false);
                }}
                onError={() => {
                  clearIframeLoadTimer();
                  setIsLoadingSource(false);
                  triggerFailoverRef.current(
                    resolvedRuntime.slot,
                    'Player do provedor não carregou.',
                    'iframe'
                  );
                }}
                className="w-full h-full border-0 bg-black"
                allow={iframeProps.allow}
                sandbox={iframeProps.sandbox}
                allowFullScreen
                referrerPolicy={iframeProps.referrerPolicy}
              />
              {!iframeLoaded && isLoadingSource && (
                <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/35">
                  <div className="w-10 h-10 rounded-full border-2 border-white/25 border-t-[#a855f7] animate-spin" />
                </div>
              )}
            </>
          );
        })()}

        {/* ACTIVE PLAYBACK: HTML5 Video / HLS mode */}
        {hasStarted && resolvedRuntime && resolvedRuntime.mode !== 'iframe' && !fatalError && (
          <>
            <video
              ref={videoRef}
              src={resolvedRuntime.mode === 'video' ? resolvedRuntime.url : undefined}
              poster={posterError ? undefined : posterUrl}
              playsInline
              preload="metadata"
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
              onSeeked={() => {
                const v = videoRef.current;
                if (!v) return;
                setCurrentTime(v.currentTime);
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
              className="w-full h-full object-contain bg-black"
            />

            {/* Interactive gesture layer (mouse click = Play/Pause; touch single-tap = controls; double-tap = seek/fullscreen) */}
            <div
              onPointerDown={handleStagePointerDown}
              onPointerUp={handleStagePointerUp}
              onPointerCancel={handleStagePointerCancel}
              className="absolute inset-0 z-10 cursor-pointer"
            />

            {/* Double-tap seek feedback indicator */}
            {seekFeedback && (
              <div
                key={seekFeedback.key}
                className={`pointer-events-none absolute top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-1 px-4 py-3 rounded-2xl bg-black/70 backdrop-blur-md border border-white/15 text-white shadow-xl ${
                  seekFeedback.side === 'left' ? 'left-6 sm:left-12' : 'right-6 sm:right-12'
                }`}
              >
                {seekFeedback.side === 'left' ? (
                  <RotateCcw className="w-5 h-5 text-[#a855f7]" />
                ) : (
                  <RotateCw className="w-5 h-5 text-[#a855f7]" />
                )}
                <span className="text-xs font-mono font-semibold tabular-nums">
                  {seekFeedback.side === 'left' ? `-${seekFeedback.seconds}s` : `+${seekFeedback.seconds}s`}
                </span>
              </div>
            )}

            {/* Loading spinner overlay */}
            {isLoadingSource && (
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/30">
                <div className="w-10 h-10 rounded-full border-2 border-white/25 border-t-[#a855f7] animate-spin" />
              </div>
            )}

            {/* Center Play button when paused */}
            {!isPlaying && !isLoadingSource && (
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePlayPause();
                }}
                aria-label="Continuar reprodução"
                className="absolute inset-0 m-auto z-20 w-16 h-16 rounded-full bg-black/65 hover:bg-[#a855f7] text-white flex items-center justify-center border border-white/20 backdrop-blur-md shadow-[0_8px_28px_rgba(0,0,0,0.5)] transition-all duration-150 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a855f7] cursor-pointer"
              >
                <Play className="w-7 h-7 fill-current ml-0.5" />
              </button>
            )}

            {/* Skip Opening button (HTML5 / HLS playback only) */}
            <AnimatePresence>
              {showSkipOpening && (
                <motion.button
                  key="skip-opening-button"
                  type="button"
                  initial={
                    prefersReducedMotion
                      ? { opacity: 0 }
                      : { opacity: 0, y: 10, scale: 0.95 }
                  }
                  animate={
                    prefersReducedMotion
                      ? { opacity: 1 }
                      : { opacity: 1, y: 0, scale: 1 }
                  }
                  exit={
                    prefersReducedMotion
                      ? { opacity: 0 }
                      : { opacity: 0, scale: 0.94 }
                  }
                  transition={
                    prefersReducedMotion
                      ? { duration: 0.01 }
                      : { duration: 0.24, ease: [0.22, 1, 0.36, 1] }
                  }
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSkipOpening();
                  }}
                  aria-label="Pular abertura"
                  className="absolute bottom-[88px] sm:bottom-[96px] right-3 sm:right-5 z-20 inline-flex items-center gap-2 px-3.5 py-2 sm:px-4 sm:py-2.5 rounded-xl bg-[#11151E]/90 hover:bg-[#a855f7]/25 active:scale-95 text-white text-xs sm:text-sm font-medium border border-[#a855f7]/50 hover:border-[#a855f7] backdrop-blur-md shadow-[0_0_22px_rgba(168,85,247,0.32)] hover:shadow-[0_0_28px_rgba(168,85,247,0.5)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a855f7] cursor-pointer"
                >
                  <SkipForward className="w-4 h-4 text-[#a855f7]" />
                  <span>Pular abertura</span>
                </motion.button>
              )}
            </AnimatePresence>

            {/* Floating translucent bottom controls bar */}
            <div
              onPointerEnter={(e) => {
                if (e.pointerType !== 'touch') {
                  setIsHoveringControls(true);
                }
              }}
              onPointerLeave={(e) => {
                if (e.pointerType !== 'touch') {
                  setIsHoveringControls(false);
                }
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className={`absolute inset-x-2.5 bottom-2.5 sm:inset-x-4 sm:bottom-4 z-20 rounded-2xl bg-black/70 backdrop-blur-md border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.55)] px-2.5 sm:px-4 pt-2 pb-2 transition-all duration-200 ${
                controlsVisible || !isPlaying || speedMenuOpen || isSeeking || isAdjustingVolume
                  ? 'opacity-100 translate-y-0'
                  : 'opacity-0 translate-y-2 pointer-events-none'
              }`}
            >
              {/* Scrubber with continuous pointer/mouse/touch drag & position knob */}
              <div
                ref={scrubberRef}
                role="slider"
                aria-label="Progresso do vídeo"
                aria-valuemin={0}
                aria-valuemax={Math.floor(duration) || 0}
                aria-valuenow={Math.floor(displayedTime)}
                tabIndex={0}
                onPointerDown={handleScrubberPointerDown}
                onPointerMove={handleScrubberPointerMove}
                onPointerUp={(e) => finishScrub(e, true)}
                onPointerCancel={(e) => finishScrub(e, false)}
                onPointerLeave={() => {
                  if (!isSeekingRef.current) {
                    setHoverTime(null);
                  }
                }}
                className="relative h-5 flex items-center cursor-pointer group/bar touch-none"
              >
                {hoverTime && (
                  <div
                    style={{ left: `${hoverTime.pct}%` }}
                    className={`${
                      isSeeking ? 'block' : 'hidden sm:block'
                    } absolute -top-8 -translate-x-1/2 px-2 py-0.5 rounded-md bg-black/85 backdrop-blur-sm border border-white/15 text-[11px] font-mono tabular-nums text-white pointer-events-none shadow-lg`}
                  >
                    {formatTime(hoverTime.time)}
                  </div>
                )}

                <div
                  className="w-full h-1.5 group-hover/bar:h-2 transition-all rounded-full overflow-hidden relative"
                  style={{ backgroundColor: 'rgba(255,255,255,0.16)' }}
                >
                  <div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                      width: `${bufferedPct}%`,
                      backgroundColor: 'rgba(255,255,255,0.28)',
                    }}
                  />
                  <div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                      width: `${progressPct}%`,
                      backgroundColor: '#a855f7',
                    }}
                  />
                </div>

                {/* Position indicator knob */}
                <div
                  style={{ left: `${progressPct}%`, backgroundColor: '#a855f7' }}
                  className={`pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full ring-2 ring-white shadow-[0_0_10px_rgba(168,85,247,0.85)] transition-transform duration-100 ${
                    isSeeking ? 'scale-125' : 'scale-100 sm:scale-90 sm:group-hover/bar:scale-110'
                  }`}
                />
              </div>

              {/* Control buttons row */}
              <div className="mt-1 flex items-center justify-between gap-1.5 sm:gap-2">
                <div className="flex items-center gap-1 sm:gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={togglePlayPause}
                    aria-label={isPlaying ? 'Pausar' : 'Reproduzir'}
                    className="w-9 h-9 flex items-center justify-center rounded-xl text-white hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a855f7] cursor-pointer shrink-0"
                  >
                    {isPlaying ? (
                      <Pause className="w-4 h-4 sm:w-5 sm:h-5 fill-current" />
                    ) : (
                      <Play className="w-4 h-4 sm:w-5 sm:h-5 fill-current" />
                    )}
                  </button>

                  {/* Mute + Volume slider (available on mobile and desktop) */}
                  <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={toggleMute}
                      aria-label={isMuted ? 'Ativar som' : 'Silenciar'}
                      className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-200 hover:text-white hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a855f7] cursor-pointer shrink-0"
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
                      onPointerDown={() => {
                        setIsAdjustingVolume(true);
                        clearHideControlsTimer();
                      }}
                      onPointerUp={() => setIsAdjustingVolume(false)}
                      onPointerCancel={() => setIsAdjustingVolume(false)}
                      onBlur={() => setIsAdjustingVolume(false)}
                      onChange={(e) => changeVolume(Number(e.target.value))}
                      className="w-12 sm:w-20 h-1.5 accent-[#a855f7] cursor-pointer touch-none"
                    />
                  </div>

                  {/* Timecode */}
                  <div className="ml-0.5 sm:ml-1 text-[11px] sm:text-xs font-mono tabular-nums text-slate-200 whitespace-nowrap truncate">
                    {formatTime(displayedTime)}{' '}
                    <span className="text-slate-400">/ {formatTime(duration)}</span>
                  </div>
                </div>

                {/* Right controls: Speed + Fullscreen */}
                <div className="flex items-center gap-1 relative shrink-0">
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setSpeedMenuOpen((prev) => !prev)}
                      aria-label="Velocidade de reprodução"
                      aria-expanded={speedMenuOpen}
                      className={`px-2 sm:px-2.5 h-9 rounded-xl text-xs font-mono tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a855f7] cursor-pointer whitespace-nowrap ${
                        speedMenuOpen
                          ? 'bg-[#a855f7]/25 text-white border border-[#a855f7]/50'
                          : 'text-slate-200 hover:text-white hover:bg-white/10'
                      }`}
                    >
                      {playbackRate}x
                    </button>

                    {speedMenuOpen && (
                      <div className="absolute right-0 bottom-12 bg-[#11151E]/95 backdrop-blur-md border border-white/15 rounded-xl p-1.5 shadow-2xl min-w-[82px] z-30">
                        {SPEED_OPTIONS.map((rate) => (
                          <button
                            key={rate}
                            type="button"
                            onClick={() => changePlaybackRate(rate)}
                            className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-mono tabular-nums transition-colors cursor-pointer ${
                              playbackRate === rate
                                ? 'bg-[#a855f7] text-white font-semibold'
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
                    className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-200 hover:text-white hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a855f7] cursor-pointer shrink-0"
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
          <div className="absolute inset-0 z-30 bg-[#0B0E14]/95 flex flex-col items-center justify-center p-6 text-center">
            <AlertCircle className="w-10 h-10 text-rose-400 mb-3" />
            <h3 className="text-base font-semibold text-white">
              {fatalErrorKind === 'iframe'
                ? 'Player do provedor não carregou'
                : 'Fonte indisponível'}
            </h3>
            <p className="mt-1.5 text-sm text-slate-400 max-w-md">{fatalError}</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={fatalErrorKind === 'iframe' ? reloadIframeSource : retryPlayback}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-rose-600 hover:bg-rose-500 text-white transition-colors cursor-pointer"
              >
                {fatalErrorKind === 'iframe' ? 'Recarregar fonte' : 'Tentar novamente'}
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
