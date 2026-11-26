import type { EpisodeDto } from '@/lib/types';

export const UNASSIGNED_ANIME_KEY = '__unassigned__';
export const UNASSIGNED_ANIME_LABEL = 'Sem anime associado';

export type AnimeSortMode = 'recent' | 'name';

export interface AnimeGroup {
  key: string;
  name: string;
  isUnassigned: boolean;
  episodes: EpisodeDto[];
  episodeCount: number;
  representativePosterUrl: string | null;
  latestCreatedAt: string;
  latestTimestamp: number;
}

export function sanitizeAnimeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  return cleaned.length > 0 ? cleaned : null;
}

export function sanitizeEpisodeNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  return cleaned.length > 0 ? cleaned : null;
}

export function normalizeAnimeKey(name: string | null | undefined): string {
  const cleaned = sanitizeAnimeName(name);
  if (!cleaned) return UNASSIGNED_ANIME_KEY;
  return cleaned.toLocaleLowerCase('pt-BR');
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

export function formatEpisodeDisplayTitle(ep: {
  anime_name?: string | null;
  episode_number?: string | null;
  title?: string | null;
}): string {
  const title = ep.title?.trim() ?? '';
  if (title) return title;

  const anime = sanitizeAnimeName(ep.anime_name);
  const epNum = sanitizeEpisodeNumber(ep.episode_number);

  if (anime && epNum) {
    return `${anime} · Episódio ${epNum}`;
  }
  if (anime) {
    return anime;
  }
  if (epNum) {
    return `Episódio ${epNum}`;
  }
  return 'Episódio';
}

function extractEpisodeNumericValue(raw: string): number | null {
  const direct = Number(raw.replace(',', '.'));
  if (Number.isFinite(direct)) return direct;

  const match = raw.match(/^(?:ep(?:is[oó]dio)?\.?\s*|#)?(\d+(?:[.,]\d+)?)/i);
  if (!match) return null;

  const parsed = Number(match[1].replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

export function sortAnimeEpisodes(episodes: EpisodeDto[]): EpisodeDto[] {
  return [...episodes].sort((a, b) => {
    const numA = sanitizeEpisodeNumber(a.episode_number);
    const numB = sanitizeEpisodeNumber(b.episode_number);

    if (numA && numB) {
      const parsedA = extractEpisodeNumericValue(numA);
      const parsedB = extractEpisodeNumericValue(numB);
      if (parsedA !== null && parsedB !== null) {
        if (parsedA !== parsedB) {
          return parsedA - parsedB;
        }
      } else if (parsedA !== null && parsedB === null) {
        return -1;
      } else if (parsedA === null && parsedB !== null) {
        return 1;
      }

      const cmp = numA.localeCompare(numB, 'pt-BR', { numeric: true, sensitivity: 'base' });
      if (cmp !== 0) return cmp;
    } else if (numA && !numB) {
      return -1;
    } else if (!numA && numB) {
      return 1;
    }

    const timeA = Date.parse(a.created_at) || 0;
    const timeB = Date.parse(b.created_at) || 0;
    return timeB - timeA;
  });
}

export function groupEpisodesByAnime(episodes: EpisodeDto[]): AnimeGroup[] {
  const map = new Map<
    string,
    {
      name: string;
      isUnassigned: boolean;
      episodes: EpisodeDto[];
      representativePosterUrl: string | null;
      latestCreatedAt: string;
      latestTimestamp: number;
    }
  >();

  for (const ep of episodes) {
    const cleanName = sanitizeAnimeName(ep.anime_name);
    const isUnassigned = !cleanName;
    const key = isUnassigned ? UNASSIGNED_ANIME_KEY : cleanName.toLocaleLowerCase('pt-BR');
    const epTimestamp = Date.parse(ep.created_at) || 0;
    const posterCandidate = ep.poster_url?.trim() || null;

    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        name: cleanName ?? UNASSIGNED_ANIME_LABEL,
        isUnassigned,
        episodes: [ep],
        representativePosterUrl: posterCandidate,
        latestCreatedAt: ep.created_at,
        latestTimestamp: epTimestamp,
      });
      continue;
    }

    existing.episodes.push(ep);
    if (!existing.representativePosterUrl && posterCandidate) {
      existing.representativePosterUrl = posterCandidate;
    }
    if (epTimestamp >= existing.latestTimestamp) {
      existing.latestTimestamp = epTimestamp;
      existing.latestCreatedAt = ep.created_at;
      if (cleanName) {
        existing.name = cleanName;
      }
    }
  }

  return Array.from(map.entries()).map(([key, group]) => ({
    key,
    name: group.name,
    isUnassigned: group.isUnassigned,
    episodes: sortAnimeEpisodes(group.episodes),
    episodeCount: group.episodes.length,
    representativePosterUrl: group.representativePosterUrl,
    latestCreatedAt: group.latestCreatedAt,
    latestTimestamp: group.latestTimestamp,
  }));
}

function sortGroups(groups: AnimeGroup[], sortBy: AnimeSortMode): AnimeGroup[] {
  return [...groups].sort((a, b) => {
    if (a.isUnassigned !== b.isUnassigned) {
      return a.isUnassigned ? 1 : -1;
    }

    if (sortBy === 'name') {
      return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base', numeric: true });
    }

    if (b.latestTimestamp !== a.latestTimestamp) {
      return b.latestTimestamp - a.latestTimestamp;
    }

    return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base', numeric: true });
  });
}

export function filterAndSortAnimeGroups(
  groups: AnimeGroup[],
  query: string,
  sortBy: AnimeSortMode
): AnimeGroup[] {
  const normalizedQuery = normalizeSearchText(query);

  const filtered = normalizedQuery
    ? groups.filter((group) => normalizeSearchText(group.name).includes(normalizedQuery))
    : [...groups];

  return sortGroups(filtered, sortBy);
}

export function searchAndSortAnimeGroups(
  groups: AnimeGroup[],
  query: string,
  sortBy: AnimeSortMode
): AnimeGroup[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return sortGroups(groups, sortBy);
  }

  const matched: AnimeGroup[] = [];
  for (const group of groups) {
    if (normalizeSearchText(group.name).includes(normalizedQuery)) {
      matched.push(group);
      continue;
    }

    const matchingEpisodes = group.episodes.filter((ep) => {
      const candidates = [
        ep.title,
        ep.episode_number,
        ep.id,
        formatEpisodeDisplayTitle(ep),
      ];
      return candidates.some((field) =>
        field ? normalizeSearchText(field).includes(normalizedQuery) : false
      );
    });

    if (matchingEpisodes.length > 0) {
      matched.push({
        ...group,
        episodes: matchingEpisodes,
        episodeCount: matchingEpisodes.length,
      });
    }
  }

  return sortGroups(matched, sortBy);
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  totalPages: number;
  totalItems: number;
  startIndex: number;
  endIndex: number;
}

export function paginateItems<T>(
  items: T[],
  requestedPage: number,
  pageSize: number
): PaginatedResult<T> {
  const safeSize = Math.max(1, Math.floor(pageSize));
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safeSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), totalPages);
  const startIndex = (page - 1) * safeSize;
  const endIndex = Math.min(startIndex + safeSize, totalItems);
  return {
    items: items.slice(startIndex, endIndex),
    page,
    totalPages,
    totalItems,
    startIndex,
    endIndex,
  };
}

export function countEpisodeSources(ep: Pick<
  EpisodeDto,
  'video_url' | 'video_url_2' | 'video_url_3' | 'video_url_4' | 'video_url_5'
>): number {
  return [
    ep.video_url,
    ep.video_url_2,
    ep.video_url_3,
    ep.video_url_4,
    ep.video_url_5,
  ].filter((u) => Boolean(u && u.trim())).length;
}
