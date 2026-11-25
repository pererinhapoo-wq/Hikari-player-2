import {
  buildThumbnailTimestamps,
  formatThumbnailTimeLabel,
  type GeneratedThumbnailCandidate,
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

function waitForVideoMetadata(
  video: HTMLVideoElement,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<number> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);

    const checkReady = () => {
      if (
        video.readyState >= 1 &&
        Number.isFinite(video.duration) &&
        video.duration > 0 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        cleanup();
        resolve(video.duration);
        return true;
      }
      return false;
    };

    const onLoaded = () => {
      if (checkReady()) return;
      if (video.readyState >= 1 && (!Number.isFinite(video.duration) || video.duration <= 0)) {
        cleanup();
        reject(new Error('Duração do vídeo indisponível ou transmissão ao vivo (sem duração fixa).'));
      }
    };

    const onError = () => {
      cleanup();
      reject(new Error('Não foi possível carregar os metadados deste vídeo para gerar thumbnails.'));
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Operação cancelada.', 'AbortError'));
    };

    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Tempo limite ao carregar metadados do vídeo.'));
    }, timeoutMs);

    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('canplay', onLoaded);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };

    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('canplay', onLoaded);
    video.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });

    void checkReady();
  });
}

function seekVideoTo(
  video: HTMLVideoElement,
  targetTime: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);

    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
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
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';

  let hlsInstance: { destroy: () => void } | null = null;
  const candidates: GeneratedThumbnailCandidate[] = [];

  try {
    throwIfAborted(signal);

    if (mode === 'hls') {
      const HlsModule = await import('hls.js');
      const Hls = HlsModule.default;
      throwIfAborted(signal);

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          maxBufferLength: 8,
          maxMaxBufferLength: 16,
        });
        hlsInstance = hls;

        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            cleanup();
            reject(new DOMException('Operação cancelada.', 'AbortError'));
          };
          const timer = window.setTimeout(() => {
            cleanup();
            reject(new Error('Tempo limite ao carregar manifesto HLS para thumbnails.'));
          }, 15000);

          const onManifest = () => {
            cleanup();
            resolve();
          };

          const onHlsError = (_evt: unknown, data: { fatal?: boolean; details?: string }) => {
            if (!data?.fatal) return;
            cleanup();
            reject(
              new Error(
                `Não foi possível carregar o fluxo HLS para capturar imagens (${data.details || 'erro fatal'}).`
              )
            );
          };

          const cleanup = () => {
            window.clearTimeout(timer);
            hls.off(Hls.Events.MANIFEST_PARSED, onManifest);
            hls.off(Hls.Events.ERROR, onHlsError);
            signal?.removeEventListener('abort', onAbort);
          };

          hls.on(Hls.Events.MANIFEST_PARSED, onManifest);
          hls.on(Hls.Events.ERROR, onHlsError);
          signal?.addEventListener('abort', onAbort, { once: true });

          hls.loadSource(sourceUrl);
          hls.attachMedia(video);
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = sourceUrl;
        video.load();
      } else {
        throw new Error('Este navegador não oferece suporte a HLS para extração de thumbnails.');
      }
    } else {
      video.src = sourceUrl;
      video.load();
    }

    const duration = await waitForVideoMetadata(video, 18000, signal);
    const timestamps = buildThumbnailTimestamps(duration, count);
    if (timestamps.length === 0) {
      throw new Error('Não foi possível calcular posições válidas no vídeo.');
    }

    for (let i = 0; i < timestamps.length; i++) {
      throwIfAborted(signal);
      const t = timestamps[i];
      try {
        await seekVideoTo(video, t, 12000, signal);
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
        // Continua para o próximo timestamp caso um único frame falhe
      }
    }

    if (candidates.length === 0) {
      throw new Error(
        'Nenhum frame pôde ser capturado deste vídeo (restrição CORS, codec incompatível ou link expirado).'
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
    if (plan.proxyUrl) attempts.push({ url: plan.proxyUrl, viaProxy: true });
    if (plan.directUrl && plan.directUrl !== plan.proxyUrl) {
      attempts.push({ url: plan.directUrl, viaProxy: false });
    }
  } else if (plan.blobPreferred) {
    // Vercel Blob: tenta URL direta primeiro; se faltar CORS, faz fallback para o proxy interno
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
