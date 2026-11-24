import { validateHttpUrl } from '@/lib/video-sources';

export const KNOWN_PREFIXES = ['apphd', 'appsd', 'appdub', 'appleg', 'appduble', 'appfull'] as const;

const r2PrefixCache = new Map<string, string>();

export function isR2SignedUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const isR2Host = host.includes('r2.cloudflarestorage.com') || host.endsWith('.r2.cloudflarestorage.com');
    if (!isR2Host) return false;

    for (const key of parsed.searchParams.keys()) {
      if (key.toLowerCase().startsWith('x-amz-')) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function cleanR2SignedUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    const paramsToDelete: string[] = [];
    for (const key of parsed.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (lower.startsWith('x-amz-') || lower.startsWith('response-')) {
        paramsToDelete.push(key);
      }
    }
    for (const k of paramsToDelete) {
      parsed.searchParams.delete(k);
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function extractFilenameFromPath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

export function extractPrefixFromPlayerricasName(nameParam: string | null): string | null {
  if (!nameParam) return null;
  const trimmed = nameParam.trim();
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx === -1) return null;
  const prefix = trimmed.slice(0, slashIdx).toLowerCase();
  return KNOWN_PREFIXES.includes(prefix as any) ? prefix : null;
}

export interface R2ResolutionResult {
  finalUrl: string;
  prefix: string | null;
  isAttempt: boolean;
  isConfirmed: boolean;
  cleanR2Url?: string;
}

export async function resolveVideoInputUrl(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<R2ResolutionResult> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { finalUrl: trimmed, prefix: null, isAttempt: false, isConfirmed: true };
  }

  // 4) Se o texto colado for a URL do playerricas.php, usar o parse direto, sem tentativa
  if (trimmed.toLowerCase().includes('playerricas.php')) {
    let prefix: string | null = null;
    let isConfirmed = !trimmed.includes('unconfirmed=1');
    try {
      const parsed = new URL(trimmed);
      const nameParam = parsed.searchParams.get('name');
      prefix = extractPrefixFromPlayerricasName(nameParam);
      if (parsed.searchParams.get('unconfirmed') === '1') {
        isConfirmed = false;
      }
    } catch {
      // ignore
    }
    return { finalUrl: trimmed, prefix, isAttempt: false, isConfirmed };
  }

  // 1) Cadastro por URL assinada do R2
  if (isR2SignedUrl(trimmed)) {
    const cleanUrl = cleanR2SignedUrl(trimmed);
    let r2Host = '';
    let filename = '';
    try {
      const parsedClean = new URL(cleanUrl);
      r2Host = parsedClean.hostname.toLowerCase();
      filename = extractFilenameFromPath(parsedClean.pathname);
    } catch {
      throw new Error('URL assinada do R2 inválida.');
    }

    if (!filename) {
      throw new Error('Nome do arquivo não encontrado na URL do R2.');
    }

    const cachedPrefix = r2PrefixCache.get(r2Host);
    const candidates: string[] = [];
    if (cachedPrefix && KNOWN_PREFIXES.includes(cachedPrefix as any)) {
      candidates.push(cachedPrefix);
    }
    for (const p of KNOWN_PREFIXES) {
      if (!candidates.includes(p)) {
        candidates.push(p);
      }
    }

    let winningPrefix: string | null = null;
    let winningPlayerricasUrl = '';
    let isConfirmed = false;
    let attemptsCount = 0;

    // 1) A tentativa só aprova com HTTP 200 e corpo contendo "player" ou "EXTM3U".
    // 403, 401, 429 e timeout não aprovam nem reprovam — a tentativa é descartada e passa para o próximo prefixo.
    for (const prefix of candidates) {
      if (attemptsCount >= 6) break;
      attemptsCount++;

      const candidateName = `${prefix}/${filename}`;
      const candidatePlayerricasUrl = `https://anitube22.vip/playerricas.php?name=${encodeURIComponent(candidateName)}&url=${encodeURIComponent(cleanUrl)}`;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetchImpl(candidatePlayerricasUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (res.status === 200) {
          const text = await res.text();
          const lowerText = text.toLowerCase();
          const hasDeleted = lowerText.includes('deleted') || lowerText.includes('not found');
          const hasPlayerOrM3u = lowerText.includes('player') || lowerText.includes('extm3u');

          if (text.trim().length > 0 && !hasDeleted && hasPlayerOrM3u) {
            winningPrefix = prefix;
            winningPlayerricasUrl = candidatePlayerricasUrl;
            isConfirmed = true;
            r2PrefixCache.set(r2Host, prefix);
            break;
          }
        }
        // Se 403, 401, 429, 404, ou 200 sem player/EXTM3U: descarta e continua para o próximo
      } catch {
        // Timeout ou erro de rede: descarta e continua para o próximo
      }
    }

    // 2) Se nenhuma tentativa der 200, não gravar prefixo por dedução. Salvar a fonte assim mesmo, marcada como "prefixo não confirmado".
    if (!winningPrefix || !winningPlayerricasUrl) {
      const fallbackPrefix = cachedPrefix && KNOWN_PREFIXES.includes(cachedPrefix as any) ? cachedPrefix : 'apphd';
      const fallbackName = `${fallbackPrefix}/${filename}`;
      winningPlayerricasUrl = `https://anitube22.vip/playerricas.php?name=${encodeURIComponent(fallbackName)}&url=${encodeURIComponent(cleanUrl)}&unconfirmed=1`;
      winningPrefix = fallbackPrefix;
      isConfirmed = false;
    }

    return {
      finalUrl: winningPlayerricasUrl,
      prefix: winningPrefix,
      isAttempt: true,
      isConfirmed,
      cleanR2Url: cleanUrl,
    };
  }

  const check = validateHttpUrl(trimmed);
  if (!check.valid || !check.normalizedUrl) {
    throw new Error(check.error ?? 'URL inválida.');
  }

  return { finalUrl: check.normalizedUrl, prefix: null, isAttempt: false, isConfirmed: true };
}
