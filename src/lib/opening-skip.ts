export interface OpeningRangeSeconds {
  opening_start_seconds: number | null;
  opening_end_seconds: number | null;
}

export function parseOpeningTimestamp(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Horário vazio.');
  }

  const mmSsMatch = trimmed.match(/^(\d{1,3}):([0-5]\d)$/);
  if (mmSsMatch) {
    const minutes = Number(mmSsMatch[1]);
    const seconds = Number(mmSsMatch[2]);
    return minutes * 60 + seconds;
  }

  const hhMmSsMatch = trimmed.match(/^(\d{1,2}):([0-5]\d):([0-5]\d)$/);
  if (hhMmSsMatch) {
    const hours = Number(hhMmSsMatch[1]);
    const minutes = Number(hhMmSsMatch[2]);
    const seconds = Number(hhMmSsMatch[3]);
    return hours * 3600 + minutes * 60 + seconds;
  }

  throw new Error(
    `Formato inválido ("${trimmed}"). Use MM:SS (ex.: 01:30) ou HH:MM:SS.`
  );
}

export function parseOpeningRange(
  rawStart: string | null | undefined,
  rawEnd: string | null | undefined
): OpeningRangeSeconds {
  const startText = typeof rawStart === 'string' ? rawStart.trim() : '';
  const endText = typeof rawEnd === 'string' ? rawEnd.trim() : '';

  if (!startText && !endText) {
    return {
      opening_start_seconds: null,
      opening_end_seconds: null,
    };
  }

  if (!startText || !endText) {
    throw new Error(
      'Informe tanto o início quanto o fim da opening, ou deixe ambos vazios.'
    );
  }

  const startSeconds = parseOpeningTimestamp(startText);
  const endSeconds = parseOpeningTimestamp(endText);

  if (endSeconds <= startSeconds) {
    throw new Error('O fim da opening deve ser maior que o início.');
  }

  return {
    opening_start_seconds: startSeconds,
    opening_end_seconds: endSeconds,
  };
}

export function validateOpeningSecondsPair(
  rawStart: unknown,
  rawEnd: unknown
): OpeningRangeSeconds {
  const hasStart = rawStart !== null && rawStart !== undefined && rawStart !== '';
  const hasEnd = rawEnd !== null && rawEnd !== undefined && rawEnd !== '';

  if (!hasStart && !hasEnd) {
    return {
      opening_start_seconds: null,
      opening_end_seconds: null,
    };
  }

  if (!hasStart || !hasEnd) {
    throw new Error(
      'Informe tanto o início quanto o fim da opening, ou deixe ambos vazios.'
    );
  }

  const startSeconds = Number(rawStart);
  const endSeconds = Number(rawEnd);

  if (
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    startSeconds < 0 ||
    endSeconds < 0
  ) {
    throw new Error('Os tempos da opening devem ser valores numéricos válidos em segundos.');
  }

  const normalizedStart = Math.floor(startSeconds);
  const normalizedEnd = Math.floor(endSeconds);

  if (normalizedEnd <= normalizedStart) {
    throw new Error('O fim da opening deve ser maior que o início.');
  }

  return {
    opening_start_seconds: normalizedStart,
    opening_end_seconds: normalizedEnd,
  };
}

export function formatOpeningTimestamp(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '';
  }

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');

  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  }

  return `${pad(minutes)}:${pad(secs)}`;
}

export function isOpeningSkipVisible(params: {
  currentTime: number;
  openingStartSeconds?: number | null;
  openingEndSeconds?: number | null;
  hasStarted: boolean;
  isIframeMode: boolean;
  fatalError: boolean;
}): boolean {
  const {
    currentTime,
    openingStartSeconds,
    openingEndSeconds,
    hasStarted,
    isIframeMode,
    fatalError,
  } = params;

  if (!hasStarted || isIframeMode || fatalError) {
    return false;
  }

  if (
    typeof openingStartSeconds !== 'number' ||
    typeof openingEndSeconds !== 'number' ||
    !Number.isFinite(openingStartSeconds) ||
    !Number.isFinite(openingEndSeconds) ||
    openingStartSeconds < 0 ||
    openingEndSeconds <= openingStartSeconds
  ) {
    return false;
  }

  if (!Number.isFinite(currentTime) || currentTime < 0) {
    return false;
  }

  return currentTime >= openingStartSeconds && currentTime < openingEndSeconds;
}
