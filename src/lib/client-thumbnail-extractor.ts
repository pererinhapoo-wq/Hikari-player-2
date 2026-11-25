import {
  buildThumbnailTimestamps,
  classifyHlsThumbnailError,
  formatThumbnailTimeLabel,
  type GeneratedThumbnailCandidate,
  pickPreferredHlsLevelIndex,
  THUMBNAIL_DEFAULT_COUNT,
  type ThumbnailSourcePlan,
} from '@/lib/thumbnail-utils';

export interface ExtractThumbnailsOptions {
  plan: ThumbnailSourcePlan;
  count?: number;
  maxWidth?: number;
  signal?: AbortSignal;
  onProgress?: (info: {
    completed: number;
    total: number;
    candidate?: GeneratedThumbnailCandidate;
  }) => void;
}

export interface ExtractThumbnailsResult {
  ok: boolean;
  candidates: GeneratedThumbnailCandidate[];
  usedProxy: boolean;
  error?: string;
}

class CanvasTaintedError extends Error {
  constructor() {
    super('O vídeo bloqueou a captura de imagem por política CORS.');
    this.name = 'CanvasTaintedError';
  }
}

export function revokeThumbnailCandidates(
  candidates: ReadonlyArray<{ previewUrl: string }>
): void {
  for (const item of candidates) {
    if (item.previewUrl && item.previewUrl.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(item.previewUrl);
      } catch {
        // Ignora erro ao liberar ObjectURL
      }
    }
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 16);
    }
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Operação cancelada.', 'AbortError');
  }
}

function describeNativeMediaError(video: HTMLVideoElement, mode: 'direct' | 'hls'): string {
  const code = video.error?.code;
  if (mode === 'hls') {
    if (code === 2) {
      return 'Falha de rede ao carregar a playlist ou os segmentos M3U8.';
    }
    if (code === 3) {
      return 'Erro de decodificação no stream M3U8 (codec ou segmento inválido).';
    }
    if (code === 4) {
      return 'Stream M3U8 ou formato de vídeo não suportado pelo navegador.';
    }
    return 'Não foi possível carregar os metadados deste stream M3U8.';
  }
  return 'Não foi possível carregar os metadados deste vídeo para gerar thumbnails.';
}

function waitForVideoMetadata(
  video: HTMLVideoElement,
  timeoutMs: number,
  mode: 'direct' | 'hls',
  signal?: AbortSignal,
  registerExternalReject?: (cb: ((err: Error) => void) | null) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);

    let settled = false;
    const finish = (err?: Error, duration?: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(duration!);
    };

    const checkReady = () => {
      if (
        video.readyState >= 1 &&
        Number.isFinite(video.duration) &&
        video.duration > 0 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        finish(undefined, video.duration);
        return true;
      }
      return false;
    };

    const onLoaded = () => {
      if (checkReady()) return;
      if (
        video.readyState >= 1 &&
        video.duration === Number.POSITIVE_INFINITY
      ) {
        finish(
          new Error(
            'Este stream não possui duração fixa (transmissão ao vivo ou metadados indisponíveis).'
          )
        );
      }
    };

    const onError = () => {
      finish(new Error(describeNativeMediaError(video, mode)));
    };

    const onAbort = () => {
      finish(new DOMException('Operação cancelada.', 'AbortError'));
    };

    const timer = window.setTimeout(() => {
      finish(
        new Error(
          mode === 'hls'
            ? 'Tempo limite ao carregar metadados e primeiro segmento do stream M3U8.'
            : 'Tempo limite ao carregar metadados do vídeo.'
        )
      );
    }, timeoutMs);

    const cleanup = () => {
      window.clearTimeout(timer);
      registerExternalReject?.(null);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('durationchange', onLoaded);
      video.removeEventListener('canplay', onLoaded);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };

    registerExternalReject?.((err) => finish(err));

    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('durationchange', onLoaded);
    video.addEventListener('canplay', onLoaded);
    video.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });

    void checkReady();
  });
}

function waitForFrameData(
  video: HTMLVideoElement,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (video.readyState >= 2) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };

    const onReady = () => {
      if (video.readyState >= 2) {
        finish();
      }
    };

    const onError = () => {
      finish(new Error('Erro ao decodificar o frame após posicionar o vídeo.'));
    };

    const onAbort = () => {
      finish(new DOMException('Operação cancelada.', 'AbortError'));
    };

    const timer = window.setTimeout(() => {
      finish(new Error('Tempo limite aguardando dados do frame após busca de posição.'));
    }, timeoutMs);

    video.addEventListener('loadeddata', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function seekVideoTo(
  video: HTMLVideoElement,
  targetTime: number,
  timeoutMs: number,
  signal?: AbortSignal,
  registerExternalReject?: (cb: ((err: Error) => void) | null) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);

    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      registerExternalReject?.(null);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };

    const onSeeked = () => {
      finish();
    };

    const onError = () => {
      finish(new Error('Erro de decodificação ao buscar posição do vídeo.'));
    };

    const onAbort = () => {
      finish(new DOMException('Operação cancelada.', 'AbortError'));
    };

    const timer = window.setTimeout(() => {
      finish(new Error('Tempo limite ao buscar frame do vídeo.'));
    }, timeoutMs);

    registerExternalReject?.((err) => finish(err));

    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      video.currentTime = targetTime;
    } catch (err) {
      finish(err instanceof Error ? err : new Error('Falha ao posicionar vídeo.'));
    }
  });
}

async function captureVideoFrameBlob(
  video: HTMLVideoElement,
  maxWidth: number
): Promise<{ blob: Blob; width: number; height: number }> {
  const srcWidth = video.videoWidth;
  const srcHeight = video.videoHeight;
  if (!srcWidth || !srcHeight) {
    throw new Error('Dimensões de vídeo inválidas durante a captura.');
  }

  const targetWidth = Math.min(maxWidth, srcWidth);
  const targetHeight = Math.max(1, Math.round((srcHeight / srcWidth) * targetWidth));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Contexto de imagem Canvas 2D indisponível no navegador.');
  }

  ctx.drawImage(video, 0, 0, targetWidth, targetHeight);

  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (!blob || blob.size === 0) {
            reject(new Error('Falha ao codificar frame capturado em JPEG.'));
            return;
          }
          resolve({ blob, width: targetWidth, height: targetHeight });
        },
        'image/jpeg',
        0.84
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'SecurityError') {
        reject(new CanvasTaintedError());
        return;
      }
      reject(err instanceof Error ? err : new Error('Erro ao exportar imagem do canvas.'));
    }
  });
}

async function runSingleCaptureAttempt(params: {
  sourceUrl: string;
  mode: 'direct' | 'hls';
  count: number;
  maxWidth: number;
  signal?: AbortSignal;
  onProgress?: ExtractThumbnailsOptions['onProgress'];
}): Promise<GeneratedThumbnailCandidate[]> {
  const { sourceUrl, mode, count, maxWidth, signal, onProgress } = params;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = mode === 'hls' ? 'auto' : 'metadata';

  let hlsInstance: { destroy: () => void } | null = null;
  let activeFatalReject: ((err: Error) => void) | null = null;
  let persistentFatalError: Error | null = null;
  const candidates: GeneratedThumbnailCandidate[] = [];

  const registerExternalReject = (cb: ((err: Error) => void) | null) => {
    activeFatalReject = cb;
    if (cb && persistentFatalError) {
      cb(persistentFatalError);
    }
  };

  const notifyFatalError = (err: Error) => {
    persistentFatalError = err;
    activeFatalReject?.(err);
  };

  try {
    throwIfAborted(signal);

    if (mode === 'hls') {
      let HlsModule: typeof import('hls.js');
      try {
        HlsModule = await import('hls.js');
      } catch {
        throw new Error('Falha ao inicializar o motor HLS.js no navegador.');
      }
      const Hls = HlsModule.default;
      throwIfAborted(signal);

      if (Hls.isSupported()) {
        // MSE com blob: local não precisa de crossOrigin no elemento <video>;
        // manter sem crossOrigin evita rejeições em Safari ManagedMediaSource.
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          startLevel: -1,
          startFragPrefetch: false,
          maxBufferLength: 2,
          maxMaxBufferLength: 6,
          maxBufferSize: 25 * 1000 * 1000,
          manifestLoadingTimeOut: 15000,
          levelLoadingTimeOut: 15000,
          fragLoadingTimeOut: 25000,
        });
        hlsInstance = hls;

        let mediaRecoveries = 0;
        let networkRetries = 0;
        let offsetFallbackUsed = false;
        let knownLevelDuration = 0;

        hls.on(Hls.Events.LEVEL_LOADED, (_evt, data) => {
          const details = data?.details;
          if (!details) return;
          if (details.live) {
            notifyFatalError(
              new Error(
                'Este stream M3U8 é uma transmissão ao vivo (sem duração fixa) e não permite buscar frames.'
              )
            );
            return;
          }
          if (typeof details.totalduration === 'number' && Number.isFinite(details.totalduration) && details.totalduration > 0) {
            knownLevelDuration = details.totalduration;
          }
        });

        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (!data?.fatal) return;

          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 1) {
            mediaRecoveries += 1;
            hls.recoverMediaError();
            return;
          }

          if (
            !offsetFallbackUsed &&
            knownLevelDuration >= 30 &&
            (data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
              data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT)
          ) {
            offsetFallbackUsed = true;
            hls.startLoad(Math.max(1, knownLevelDuration * 0.1));
            return;
          }

          if (
            data.type === Hls.ErrorTypes.NETWORK_ERROR &&
            !data.response?.code &&
            networkRetries < 1 &&
            (data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
              data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT)
          ) {
            networkRetries += 1;
            hls.startLoad();
            return;
          }

          const message = classifyHlsThumbnailError({
            type: data.type,
            details: data.details,
            httpCode: data.response?.code,
          });
          notifyFatalError(new Error(message));
        });

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            activeFatalReject = null;
            hls.off(Hls.Events.MEDIA_ATTACHED, onAttached);
            hls.off(Hls.Events.MANIFEST_PARSED, onManifest);
            signal?.removeEventListener('abort', onAbort);
            if (err) reject(err);
            else resolve();
          };

          activeFatalReject = (err) => finish(err);

          const onAbort = () => {
            finish(new DOMException('Operação cancelada.', 'AbortError'));
          };

          const timer = window.setTimeout(() => {
            finish(new Error('Tempo limite ao carregar a playlist M3U8.'));
          }, 20000);

          const onAttached = () => {
            hls.loadSource(sourceUrl);
          };

          const onManifest = (_evt: unknown, data: { levels?: Array<{ height?: number; width?: number; bitrate?: number; videoCodec?: string }> }) => {
            const levels = data?.levels ?? [];
            if (levels.length === 0) {
              finish(new Error('Playlist M3U8 não contém nenhum fluxo de vídeo compatível.'));
              return;
            }
            if (levels.length > 1) {
              const preferredIdx = pickPreferredHlsLevelIndex(levels);
              if (preferredIdx >= 0) {
                hls.currentLevel = preferredIdx;
                hls.loadLevel = preferredIdx;
              }
            }
            finish();
          };

          hls.on(Hls.Events.MEDIA_ATTACHED, onAttached);
          hls.on(Hls.Events.MANIFEST_PARSED, onManifest);
          signal?.addEventListener('abort', onAbort, { once: true });

          hls.attachMedia(video);
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.crossOrigin = 'anonymous';
        video.src = sourceUrl;
        video.load();
      } else {
        throw new Error('Este navegador não oferece suporte a HLS para extração de thumbnails.');
      }
    } else {
      video.crossOrigin = 'anonymous';
      video.src = sourceUrl;
      video.load();
    }

    const duration = await waitForVideoMetadata(
      video,
      mode === 'hls' ? 35000 : 18000,
      mode,
      signal,
      registerExternalReject
    );
    const timestamps = buildThumbnailTimestamps(duration, count);
    if (timestamps.length === 0) {
      throw new Error('Este vídeo não possui duração válida para calcular posições de captura.');
    }

    for (let i = 0; i < timestamps.length; i++) {
      throwIfAborted(signal);
      if (persistentFatalError) {
        if (candidates.length > 0) break;
        throw persistentFatalError;
      }

      const t = timestamps[i];
      try {
        await seekVideoTo(
          video,
          t,
          mode === 'hls' ? 25000 : 12000,
          signal,
          registerExternalReject
        );
        await waitForFrameData(video, mode === 'hls' ? 10000 : 5000, signal);
        await nextAnimationFrame();
        throwIfAborted(signal);

        const captured = await captureVideoFrameBlob(video, maxWidth);
        const previewUrl = URL.createObjectURL(captured.blob);
        const candidate: GeneratedThumbnailCandidate = {
          id: `thumb-${i + 1}-${Math.round(t * 100)}`,
          timestampSeconds: t,
          timestampLabel: formatThumbnailTimeLabel(t),
          blob: captured.blob,
          previewUrl,
          width: captured.width,
          height: captured.height,
        };
        candidates.push(candidate);
        onProgress?.({
          completed: candidates.length,
          total: timestamps.length,
          candidate,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err;
        }
        if (err instanceof CanvasTaintedError) {
          throw err;
        }
        // Continua tentando os demais timestamps caso uma posição isolada falhe
      }
    }

    if (candidates.length === 0) {
      if (persistentFatalError) {
        throw persistentFatalError;
      }
      throw new Error(
        mode === 'hls'
          ? 'Nenhum frame pôde ser capturado do stream M3U8 (falha nos segmentos ou formato incompatível).'
          : 'Nenhum frame pôde ser capturado deste vídeo (restrição CORS, codec incompatível ou link expirado).'
      );
    }

    return candidates;
  } catch (err) {
    revokeThumbnailCandidates(candidates);
    throw err;
  } finally {
    if (hlsInstance) {
      try {
        hlsInstance.destroy();
      } catch {
        // Ignora erro ao destruir instância HLS
      }
    }
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      // Ignora erro ao limpar elemento de vídeo
    }
  }
}

export async function extractVideoThumbnails(
  options: ExtractThumbnailsOptions
): Promise<ExtractThumbnailsResult> {
  const {
    plan,
    count = THUMBNAIL_DEFAULT_COUNT,
    maxWidth = 640,
    signal,
    onProgress,
  } = options;

  if (!plan.ok || plan.mode === 'incompatible') {
    return {
      ok: false,
      candidates: [],
      usedProxy: false,
      error:
        plan.reason ||
        'Esta fonte não permite extração de thumbnails no navegador. Preencha a capa manualmente.',
    };
  }

  const attempts: Array<{ url: string; viaProxy: boolean }> = [];
  if (plan.mode === 'hls') {
    // Para HLS externo, prioriza o proxy assinado (que remove bloqueio de Origin e adiciona CORS);
    // evita sobrescrever o erro real do proxy com uma tentativa direta sem CORS.
    if (plan.proxyUrl) {
      attempts.push({ url: plan.proxyUrl, viaProxy: true });
    } else if (plan.directUrl) {
      attempts.push({ url: plan.directUrl, viaProxy: false });
    }
  } else if (plan.blobPreferred) {
    // Vercel Blob: preserva fluxo validado — tenta URL direta primeiro; fallback para proxy interno se faltar CORS
    if (plan.directUrl) attempts.push({ url: plan.directUrl, viaProxy: false });
    if (plan.proxyUrl && plan.proxyUrl !== plan.directUrl) {
      attempts.push({ url: plan.proxyUrl, viaProxy: true });
    }
  } else {
    // MP4/WebM externos normalmente exigem proxy para headers CORS/Referer
    if (plan.proxyUrl) attempts.push({ url: plan.proxyUrl, viaProxy: true });
    if (plan.directUrl && plan.directUrl !== plan.proxyUrl) {
      attempts.push({ url: plan.directUrl, viaProxy: false });
    }
  }

  let lastError = 'Não foi possível capturar frames deste vídeo.';

  for (const attempt of attempts) {
    try {
      throwIfAborted(signal);
      const candidates = await runSingleCaptureAttempt({
        sourceUrl: attempt.url,
        mode: plan.mode,
        count,
        maxWidth,
        signal,
        onProgress,
      });
      return {
        ok: true,
        candidates,
        usedProxy: attempt.viaProxy,
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return {
          ok: false,
          candidates: [],
          usedProxy: attempt.viaProxy,
          error: 'Geração de thumbnails cancelada.',
        };
      }
      lastError = err instanceof Error ? err.message : 'Falha ao extrair frames do vídeo.';
    }
  }

  return {
    ok: false,
    candidates: [],
    usedProxy: false,
    error: lastError,
  };
}
