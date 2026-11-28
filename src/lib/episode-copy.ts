import type { EpisodeDto } from '@/lib/types';

export type EpisodeCopyField = 'id' | 'poster';

export type EpisodeCopyStatusKind = 'copied' | 'missing_poster' | 'clipboard_error';

export type EpisodeCopyOutcome =
  | {
      ok: true;
      episodeId: string;
      field: EpisodeCopyField;
      value: string;
      status: 'copied';
      message: string;
    }
  | {
      ok: false;
      episodeId: string;
      field: EpisodeCopyField;
      status: 'missing_poster' | 'clipboard_error';
      message: string;
    };

export interface ClipboardWriterDeps {
  writeText?: (text: string) => Promise<void>;
  execCopyFallback?: (text: string) => boolean;
}

export const COPY_ID_SUCCESS_MESSAGE = 'ID copiado!';
export const COPY_POSTER_SUCCESS_MESSAGE = 'Link da imagem copiado!';
export const COPY_POSTER_MISSING_MESSAGE = 'Nenhuma imagem disponível para este episódio.';
export const COPY_ID_MISSING_MESSAGE = 'ID do episódio indisponível.';
export const COPY_CLIPBOARD_ERROR_MESSAGE =
  'Não foi possível copiar para a área de transferência.';

export function createEpisodeCopyKey(episodeId: string, field: EpisodeCopyField): string {
  return `${episodeId}:${field}`;
}

/**
 * Extracts strictly the episode ID (the same identifier used by `/e/{episodeId}`).
 * Never falls back to `public_url`, full URLs, titles, or episode numbers.
 */
export function getEpisodeCopyId(
  episode: Pick<EpisodeDto, 'id'> | { id?: string | null }
): string | null {
  if (typeof episode.id !== 'string') return null;
  const trimmed = episode.id.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extracts strictly the registered thumbnail URL from `poster_url`.
 * Never uses `public_url`, temporary `blob:`/`data:` previews, or proxy/resized image URLs.
 */
export function getEpisodeCopyPosterUrl(
  episode: Pick<EpisodeDto, 'poster_url'> | { poster_url?: string | null }
): string | null {
  if (typeof episode.poster_url !== 'string') return null;
  const trimmed = episode.poster_url.trim();
  if (!trimmed || /^(?:blob|data):/i.test(trimmed)) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

function defaultExecCopyFallback(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';

  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

export async function writeTextToClipboard(
  text: string,
  deps?: ClipboardWriterDeps
): Promise<boolean> {
  if (deps?.writeText) {
    try {
      await deps.writeText(text);
      return true;
    } catch {
      if (deps.execCopyFallback) {
        try {
          return Boolean(deps.execCopyFallback(text));
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback in restricted iframe/mobile contexts
    }
  }

  const fallback = deps?.execCopyFallback ?? defaultExecCopyFallback;
  try {
    return Boolean(fallback(text));
  } catch {
    return false;
  }
}

export async function copyEpisodeField(
  episode: { id?: string | null; poster_url?: string | null },
  field: EpisodeCopyField,
  deps?: ClipboardWriterDeps
): Promise<EpisodeCopyOutcome> {
  const episodeId = getEpisodeCopyId(episode) ?? '';

  if (field === 'id') {
    const idValue = getEpisodeCopyId(episode);
    if (!idValue) {
      return {
        ok: false,
        episodeId,
        field: 'id',
        status: 'clipboard_error',
        message: COPY_ID_MISSING_MESSAGE,
      };
    }

    const copied = await writeTextToClipboard(idValue, deps);
    if (!copied) {
      return {
        ok: false,
        episodeId,
        field: 'id',
        status: 'clipboard_error',
        message: COPY_CLIPBOARD_ERROR_MESSAGE,
      };
    }

    return {
      ok: true,
      episodeId,
      field: 'id',
      value: idValue,
      status: 'copied',
      message: COPY_ID_SUCCESS_MESSAGE,
    };
  }

  const posterUrl = getEpisodeCopyPosterUrl(episode);
  if (!posterUrl) {
    return {
      ok: false,
      episodeId,
      field: 'poster',
      status: 'missing_poster',
      message: COPY_POSTER_MISSING_MESSAGE,
    };
  }

  const copied = await writeTextToClipboard(posterUrl, deps);
  if (!copied) {
    return {
      ok: false,
      episodeId,
      field: 'poster',
      status: 'clipboard_error',
      message: COPY_CLIPBOARD_ERROR_MESSAGE,
    };
  }

  return {
    ok: true,
    episodeId,
    field: 'poster',
    value: posterUrl,
    status: 'copied',
    message: COPY_POSTER_SUCCESS_MESSAGE,
  };
}
