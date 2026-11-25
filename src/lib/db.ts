import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { sanitizeAnimeName, sanitizeEpisodeNumber } from '@/lib/anime-library';
import { validateOpeningSecondsPair } from '@/lib/opening-skip';
import type {
  DatabaseDiagnosisCode,
  DatabaseDiagnosticResult,
  DatabaseEnvDiagnostic,
  DatabaseQueryDiagnostic,
  SanitizedDbError,
} from '@/lib/types';
import { planEpisodeSlotInsertion } from '@/lib/batch-import';
import {
  deriveKindFromExtension,
  type ExplicitSourceKind,
  isDirectMediaUrl,
  isVercelBlobUrl,
  normalizeExplicitSourceKind,
  validateHttpUrl,
} from '@/lib/video-sources';
import { resolveVideoInputUrl } from '@/lib/r2-resolver';

export interface PlayerEpisode {
  id: string;
  anime_name: string | null;
  episode_number: string | null;
  opening_start_seconds: number | null;
  opening_end_seconds: number | null;
  title: string;
  poster_url: string;
  video_url: string;
  video_url_2: string | null;
  video_url_3: string | null;
  video_url_4: string | null;
  video_url_5: string | null;
  source_kind: ExplicitSourceKind | null;
  source_kind_2: ExplicitSourceKind | null;
  source_kind_3: ExplicitSourceKind | null;
  source_kind_4: ExplicitSourceKind | null;
  source_kind_5: ExplicitSourceKind | null;
  force_proxy: boolean | null;
  force_proxy_2: boolean | null;
  force_proxy_3: boolean | null;
  force_proxy_4: boolean | null;
  force_proxy_5: boolean | null;
  is_mirror: boolean | null;
  is_mirror_2: boolean | null;
  is_mirror_3: boolean | null;
  is_mirror_4: boolean | null;
  is_mirror_5: boolean | null;
  created_at: string;
  updated_at: string;
}

export interface EpisodeWriteInput {
  anime_name?: string | null;
  episode_number?: string | null;
  opening_start_seconds?: number | null;
  opening_end_seconds?: number | null;
  title: string;
  poster_url: string;
  video_url: string;
  video_url_2?: string | null;
  video_url_3?: string | null;
  video_url_4?: string | null;
  video_url_5?: string | null;
  source_kind?: ExplicitSourceKind | '' | null;
  source_kind_2?: ExplicitSourceKind | '' | null;
  source_kind_3?: ExplicitSourceKind | '' | null;
  source_kind_4?: ExplicitSourceKind | '' | null;
  source_kind_5?: ExplicitSourceKind | '' | null;
  force_proxy?: boolean | null;
  force_proxy_2?: boolean | null;
  force_proxy_3?: boolean | null;
  force_proxy_4?: boolean | null;
  force_proxy_5?: boolean | null;
}

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super('DATABASE_URL do Neon não está configurada no ambiente do servidor.');
    this.name = 'DatabaseNotConfiguredError';
  }
}

export function isDatabaseConfigured(): boolean {
  const url = process.env.DATABASE_URL?.trim();
  return Boolean(url && /^postgres(?:ql)?:\/\//i.test(url));
}

function getSql() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new DatabaseNotConfiguredError();
  }
  return neon(databaseUrl);
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export function generateEpisodeId(length = 21): string {
  const bytes = crypto.randomBytes(length);
  let id = '';
  for (let i = 0; i < length; i++) {
    id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return id;
}

export function sanitizeEpisodeInput(input: EpisodeWriteInput): EpisodeWriteInput {
  const animeName = sanitizeAnimeName(input.anime_name);
  if (animeName && animeName.length > 160) {
    throw new Error('O nome do anime deve ter no máximo 160 caracteres.');
  }

  const episodeNumber = sanitizeEpisodeNumber(input.episode_number);
  if (episodeNumber && episodeNumber.length > 32) {
    throw new Error('O número do episódio deve ter no máximo 32 caracteres.');
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length > 200) {
    throw new Error('O título do episódio deve ter no máximo 200 caracteres.');
  }
  if (!title && !animeName) {
    throw new Error('Informe o nome do anime ou o título do episódio.');
  }

  const openingRange = validateOpeningSecondsPair(
    input.opening_start_seconds,
    input.opening_end_seconds
  );

  const posterCheck = validateHttpUrl(input.poster_url ?? '');
  if (!posterCheck.valid || !posterCheck.normalizedUrl) {
    throw new Error(`Imagem de capa inválida: ${posterCheck.error}`);
  }

  const primaryCheck = validateHttpUrl(input.video_url ?? '');
  if (!primaryCheck.valid || !primaryCheck.normalizedUrl) {
    throw new Error(`Player 1 inválido: ${primaryCheck.error}`);
  }

  const optionalSlots: Array<[keyof EpisodeWriteInput, string]> = [
    ['video_url_2', 'Player 2'],
    ['video_url_3', 'Player 3'],
    ['video_url_4', 'Player 4'],
    ['video_url_5', 'Player 5'],
  ];

  const sanitizedOptional: Record<string, string | null | undefined> = {};
  for (const [key, label] of optionalSlots) {
    const raw = input[key];
    if (raw === undefined) {
      sanitizedOptional[key] = undefined;
      continue;
    }
    if (!raw || typeof raw !== 'string' || !raw.trim()) {
      sanitizedOptional[key] = null;
      continue;
    }
    const check = validateHttpUrl(raw);
    if (!check.valid || !check.normalizedUrl) {
      throw new Error(`${label} inválido: ${check.error}`);
    }
    sanitizedOptional[key] = check.normalizedUrl;
  }

  const resolveSlotKind = (
    url: string | null | undefined,
    rawKind: ExplicitSourceKind | '' | null | undefined
  ): ExplicitSourceKind | null | undefined => {
    if (url && (isDirectMediaUrl(url) || isVercelBlobUrl(url))) {
      return deriveKindFromExtension(url);
    }
    return rawKind === undefined ? undefined : normalizeExplicitSourceKind(rawKind);
  };

  const resolveSlotForceProxy = (
    url: string | null | undefined,
    rawForceProxy: boolean | null | undefined
  ): boolean | undefined => {
    if (url && (isDirectMediaUrl(url) || isVercelBlobUrl(url))) {
      return false;
    }
    return rawForceProxy === undefined
      ? undefined
      : typeof rawForceProxy === 'boolean'
        ? rawForceProxy
        : true;
  };

  return {
    anime_name: animeName,
    episode_number: episodeNumber,
    opening_start_seconds: openingRange.opening_start_seconds,
    opening_end_seconds: openingRange.opening_end_seconds,
    title,
    poster_url: posterCheck.normalizedUrl,
    video_url: primaryCheck.normalizedUrl,
    video_url_2: sanitizedOptional.video_url_2,
    video_url_3: sanitizedOptional.video_url_3,
    video_url_4: sanitizedOptional.video_url_4,
    video_url_5: sanitizedOptional.video_url_5,
    source_kind: resolveSlotKind(primaryCheck.normalizedUrl, input.source_kind) ?? null,
    source_kind_2: resolveSlotKind(sanitizedOptional.video_url_2, input.source_kind_2),
    source_kind_3: resolveSlotKind(sanitizedOptional.video_url_3, input.source_kind_3),
    source_kind_4: resolveSlotKind(sanitizedOptional.video_url_4, input.source_kind_4),
    source_kind_5: resolveSlotKind(sanitizedOptional.video_url_5, input.source_kind_5),
    force_proxy: resolveSlotForceProxy(primaryCheck.normalizedUrl, input.force_proxy ?? true) ?? true,
    force_proxy_2: resolveSlotForceProxy(sanitizedOptional.video_url_2, input.force_proxy_2),
    force_proxy_3: resolveSlotForceProxy(sanitizedOptional.video_url_3, input.force_proxy_3),
    force_proxy_4: resolveSlotForceProxy(sanitizedOptional.video_url_4, input.force_proxy_4),
    force_proxy_5: resolveSlotForceProxy(sanitizedOptional.video_url_5, input.force_proxy_5),
  };
}

function normalizeOptionalSeconds(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.floor(num);
}

function mapEpisodeRow(row: Record<string, unknown>): PlayerEpisode {
  return {
    id: String(row.id),
    anime_name: sanitizeAnimeName(row.anime_name),
    episode_number: sanitizeEpisodeNumber(row.episode_number),
    opening_start_seconds: normalizeOptionalSeconds(row.opening_start_seconds),
    opening_end_seconds: normalizeOptionalSeconds(row.opening_end_seconds),
    title: typeof row.title === 'string' ? row.title : String(row.title ?? ''),
    poster_url: String(row.poster_url),
    video_url: String(row.video_url),
    video_url_2: row.video_url_2 ? String(row.video_url_2) : null,
    video_url_3: row.video_url_3 ? String(row.video_url_3) : null,
    video_url_4: row.video_url_4 ? String(row.video_url_4) : null,
    video_url_5: row.video_url_5 ? String(row.video_url_5) : null,
    source_kind: normalizeExplicitSourceKind(row.source_kind),
    source_kind_2: normalizeExplicitSourceKind(row.source_kind_2),
    source_kind_3: normalizeExplicitSourceKind(row.source_kind_3),
    source_kind_4: normalizeExplicitSourceKind(row.source_kind_4),
    source_kind_5: normalizeExplicitSourceKind(row.source_kind_5),
    force_proxy: row.force_proxy === false ? false : true,
    force_proxy_2: row.force_proxy_2 === false ? false : true,
    force_proxy_3: row.force_proxy_3 === false ? false : true,
    force_proxy_4: row.force_proxy_4 === false ? false : true,
    force_proxy_5: row.force_proxy_5 === false ? false : true,
    is_mirror: Boolean(row.is_mirror),
    is_mirror_2: Boolean(row.is_mirror_2),
    is_mirror_3: Boolean(row.is_mirror_3),
    is_mirror_4: Boolean(row.is_mirror_4),
    is_mirror_5: Boolean(row.is_mirror_5),
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
  };
}

export async function listEpisodes(): Promise<PlayerEpisode[]> {
  const sql = getSql();
  try {
    const rows = await sql`
      SELECT id, anime_name, episode_number, opening_start_seconds, opening_end_seconds,
             title, poster_url,
             video_url, video_url_2, video_url_3, video_url_4, video_url_5,
             source_kind, source_kind_2, source_kind_3, source_kind_4, source_kind_5,
             COALESCE(force_proxy, true) AS force_proxy,
             COALESCE(force_proxy_2, true) AS force_proxy_2,
             COALESCE(force_proxy_3, true) AS force_proxy_3,
             COALESCE(force_proxy_4, true) AS force_proxy_4,
             COALESCE(force_proxy_5, true) AS force_proxy_5,
             COALESCE(is_mirror, false) AS is_mirror,
             COALESCE(is_mirror_2, false) AS is_mirror_2,
             COALESCE(is_mirror_3, false) AS is_mirror_3,
             COALESCE(is_mirror_4, false) AS is_mirror_4,
             COALESCE(is_mirror_5, false) AS is_mirror_5,
             created_at, updated_at
      FROM public.player_episodes
      ORDER BY created_at DESC
    `;
    if (!Array.isArray(rows)) {
      throw new Error('Formato inesperado de resposta retornado pelo driver Neon ao listar episódios.');
    }
    return (rows as Array<Record<string, unknown>>).map(mapEpisodeRow);
  } catch (err: any) {
    if (err?.code === '42703' || String(err?.message).includes('column')) {
      const rows = await sql`
        SELECT id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
               created_at, updated_at,
               to_jsonb(p) AS row_data
        FROM public.player_episodes p
        ORDER BY created_at DESC
      `;
      if (!Array.isArray(rows)) {
        throw new Error('Formato inesperado de resposta retornado pelo driver Neon ao listar episódios.');
      }
      return (rows as Array<Record<string, unknown>>).map((row) => {
        const data = (row.row_data as Record<string, unknown>) ?? row;
        return mapEpisodeRow({
          ...row,
          anime_name: data.anime_name ?? null,
          episode_number: data.episode_number ?? null,
          opening_start_seconds: data.opening_start_seconds ?? null,
          opening_end_seconds: data.opening_end_seconds ?? null,
          source_kind: data.source_kind ?? null,
          source_kind_2: data.source_kind_2 ?? null,
          source_kind_3: data.source_kind_3 ?? null,
          source_kind_4: data.source_kind_4 ?? null,
          source_kind_5: data.source_kind_5 ?? null,
          force_proxy: data.force_proxy === false ? false : true,
          force_proxy_2: data.force_proxy_2 === false ? false : true,
          force_proxy_3: data.force_proxy_3 === false ? false : true,
          force_proxy_4: data.force_proxy_4 === false ? false : true,
          force_proxy_5: data.force_proxy_5 === false ? false : true,
          is_mirror: Boolean(data.is_mirror),
          is_mirror_2: Boolean(data.is_mirror_2),
          is_mirror_3: Boolean(data.is_mirror_3),
          is_mirror_4: Boolean(data.is_mirror_4),
          is_mirror_5: Boolean(data.is_mirror_5),
        });
      });
    }
    throw err;
  }
}

export async function getEpisodeById(
  id: string,
  sqlOverride?: DiagnosticSqlTag
): Promise<PlayerEpisode | null> {
  const cleanId = id.trim();
  if (!cleanId || cleanId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cleanId)) {
    return null;
  }

  const sql = sqlOverride ?? (getSql() as unknown as DiagnosticSqlTag);
  try {
    const rows = await sql`
      SELECT id, anime_name, episode_number, opening_start_seconds, opening_end_seconds,
             title, poster_url,
             video_url, video_url_2, video_url_3, video_url_4, video_url_5,
             source_kind, source_kind_2, source_kind_3, source_kind_4, source_kind_5,
             COALESCE(force_proxy, true) AS force_proxy,
             COALESCE(force_proxy_2, true) AS force_proxy_2,
             COALESCE(force_proxy_3, true) AS force_proxy_3,
             COALESCE(force_proxy_4, true) AS force_proxy_4,
             COALESCE(force_proxy_5, true) AS force_proxy_5,
             COALESCE(is_mirror, false) AS is_mirror,
             COALESCE(is_mirror_2, false) AS is_mirror_2,
             COALESCE(is_mirror_3, false) AS is_mirror_3,
             COALESCE(is_mirror_4, false) AS is_mirror_4,
             COALESCE(is_mirror_5, false) AS is_mirror_5,
             created_at, updated_at
      FROM public.player_episodes
      WHERE id = ${cleanId}
      LIMIT 1
    `;
    const row = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>)[0] : undefined;
    return row ? mapEpisodeRow(row) : null;
  } catch (err: any) {
    if (err?.code === '42703' || String(err?.message).includes('column')) {
      const rows = await sql`
        SELECT id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
               created_at, updated_at,
               to_jsonb(p) AS row_data
        FROM public.player_episodes p
        WHERE id = ${cleanId}
        LIMIT 1
      `;
      const row = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>)[0] : undefined;
      if (!row) return null;
      const data = (row.row_data as Record<string, unknown>) ?? row;
      return mapEpisodeRow({
        ...row,
        anime_name: data.anime_name ?? null,
        episode_number: data.episode_number ?? null,
        opening_start_seconds: data.opening_start_seconds ?? null,
        opening_end_seconds: data.opening_end_seconds ?? null,
        source_kind: data.source_kind ?? null,
        source_kind_2: data.source_kind_2 ?? null,
        source_kind_3: data.source_kind_3 ?? null,
        source_kind_4: data.source_kind_4 ?? null,
        source_kind_5: data.source_kind_5 ?? null,
        force_proxy: data.force_proxy === false ? false : true,
        force_proxy_2: data.force_proxy_2 === false ? false : true,
        force_proxy_3: data.force_proxy_3 === false ? false : true,
        force_proxy_4: data.force_proxy_4 === false ? false : true,
        force_proxy_5: data.force_proxy_5 === false ? false : true,
        is_mirror: Boolean(data.is_mirror),
        is_mirror_2: Boolean(data.is_mirror_2),
        is_mirror_3: Boolean(data.is_mirror_3),
        is_mirror_4: Boolean(data.is_mirror_4),
        is_mirror_5: Boolean(data.is_mirror_5),
      });
    }
    throw err;
  }
}

function isUndefinedColumnError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === '42703') {
    return true;
  }
  const message = String((err as { message?: unknown } | null)?.message ?? '');
  return /column\s+.+\s+does\s+not\s+exist/i.test(message);
}

function assertOpeningFieldsPersisted(
  input: EpisodeWriteInput,
  persisted: PlayerEpisode
): void {
  const expectedStart = input.opening_start_seconds ?? null;
  const expectedEnd = input.opening_end_seconds ?? null;

  if (expectedStart !== null && persisted.opening_start_seconds !== expectedStart) {
    throw new Error(
      'Os horários da opening não foram persistidos no banco de dados (opening_start_seconds ausente).'
    );
  }

  if (expectedEnd !== null && persisted.opening_end_seconds !== expectedEnd) {
    throw new Error(
      'Os horários da opening não foram persistidos no banco de dados (opening_end_seconds ausente).'
    );
  }
}

export async function createEpisode(
  rawInput: EpisodeWriteInput,
  sqlOverride?: DiagnosticSqlTag
): Promise<PlayerEpisode> {
  const resolvedRaw = await resolveEpisodeInputUrls(rawInput);
  const input = sanitizeEpisodeInput(resolvedRaw);
  const id = generateEpisodeId();
  const sql = sqlOverride ?? (getSql() as unknown as DiagnosticSqlTag);
  const hasOpeningTimes =
    input.opening_start_seconds !== null &&
    input.opening_start_seconds !== undefined &&
    input.opening_end_seconds !== null &&
    input.opening_end_seconds !== undefined;

  const finalizeCreated = (row: Record<string, unknown> | undefined): PlayerEpisode => {
    if (!row) {
      throw new Error('Falha ao confirmar a gravação do episódio no banco de dados.');
    }
    const mapped = mapEpisodeRow(row);
    assertOpeningFieldsPersisted(input, mapped);
    return mapped;
  };

  try {
    const rows = await sql`
      INSERT INTO public.player_episodes (
        id, anime_name, episode_number, opening_start_seconds, opening_end_seconds,
        title, poster_url,
        video_url, video_url_2, video_url_3, video_url_4, video_url_5,
        source_kind, source_kind_2, source_kind_3, source_kind_4, source_kind_5,
        force_proxy, force_proxy_2, force_proxy_3, force_proxy_4, force_proxy_5
      ) VALUES (
        ${id},
        ${input.anime_name ?? null},
        ${input.episode_number ?? null},
        ${input.opening_start_seconds ?? null},
        ${input.opening_end_seconds ?? null},
        ${input.title},
        ${input.poster_url},
        ${input.video_url},
        ${input.video_url_2 ?? null},
        ${input.video_url_3 ?? null},
        ${input.video_url_4 ?? null},
        ${input.video_url_5 ?? null},
        ${input.source_kind ?? null},
        ${input.source_kind_2 ?? null},
        ${input.source_kind_3 ?? null},
        ${input.source_kind_4 ?? null},
        ${input.source_kind_5 ?? null},
        ${input.force_proxy ?? true},
        ${input.force_proxy_2 ?? true},
        ${input.force_proxy_3 ?? true},
        ${input.force_proxy_4 ?? true},
        ${input.force_proxy_5 ?? true}
      )
      RETURNING id, anime_name, episode_number, opening_start_seconds, opening_end_seconds,
                title, poster_url,
                video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                source_kind, source_kind_2, source_kind_3, source_kind_4, source_kind_5,
                COALESCE(force_proxy, true) AS force_proxy,
                COALESCE(force_proxy_2, true) AS force_proxy_2,
                COALESCE(force_proxy_3, true) AS force_proxy_3,
                COALESCE(force_proxy_4, true) AS force_proxy_4,
                COALESCE(force_proxy_5, true) AS force_proxy_5,
                created_at, updated_at
    `;
    return finalizeCreated((rows as Array<Record<string, unknown>>)[0]);
  } catch (err: unknown) {
    if (!isUndefinedColumnError(err)) {
      throw err;
    }

    // Fallback 1: schema sem anime_name / episode_number (migration 0004 pendente), mas com 0002, 0003 e 0005
    try {
      const rows = await sql`
        INSERT INTO public.player_episodes (
          id, opening_start_seconds, opening_end_seconds,
          title, poster_url,
          video_url, video_url_2, video_url_3, video_url_4, video_url_5,
          source_kind, source_kind_2, source_kind_3, source_kind_4, source_kind_5,
          force_proxy, force_proxy_2, force_proxy_3, force_proxy_4, force_proxy_5
        ) VALUES (
          ${id},
          ${input.opening_start_seconds ?? null},
          ${input.opening_end_seconds ?? null},
          ${input.title || input.anime_name || 'Episódio'},
          ${input.poster_url},
          ${input.video_url},
          ${input.video_url_2 ?? null},
          ${input.video_url_3 ?? null},
          ${input.video_url_4 ?? null},
          ${input.video_url_5 ?? null},
          ${input.source_kind ?? null},
          ${input.source_kind_2 ?? null},
          ${input.source_kind_3 ?? null},
          ${input.source_kind_4 ?? null},
          ${input.source_kind_5 ?? null},
          ${input.force_proxy ?? true},
          ${input.force_proxy_2 ?? true},
          ${input.force_proxy_3 ?? true},
          ${input.force_proxy_4 ?? true},
          ${input.force_proxy_5 ?? true}
        )
        RETURNING id, opening_start_seconds, opening_end_seconds,
                  title, poster_url,
                  video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                  source_kind, source_kind_2, source_kind_3, source_kind_4, source_kind_5,
                  COALESCE(force_proxy, true) AS force_proxy,
                  COALESCE(force_proxy_2, true) AS force_proxy_2,
                  COALESCE(force_proxy_3, true) AS force_proxy_3,
                  COALESCE(force_proxy_4, true) AS force_proxy_4,
                  COALESCE(force_proxy_5, true) AS force_proxy_5,
                  created_at, updated_at
      `;
      return finalizeCreated((rows as Array<Record<string, unknown>>)[0]);
    } catch (err2: unknown) {
      if (!isUndefinedColumnError(err2)) {
        throw err2;
      }

      // Fallback 2: schema básico (0001) + colunas de opening (0005), sem force_proxy/source_kind/anime_name
      try {
        const rows = await sql`
          INSERT INTO public.player_episodes (
            id, opening_start_seconds, opening_end_seconds,
            title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5
          ) VALUES (
            ${id},
            ${input.opening_start_seconds ?? null},
            ${input.opening_end_seconds ?? null},
            ${input.title || input.anime_name || 'Episódio'},
            ${input.poster_url},
            ${input.video_url},
            ${input.video_url_2 ?? null},
            ${input.video_url_3 ?? null},
            ${input.video_url_4 ?? null},
            ${input.video_url_5 ?? null}
          )
          RETURNING id, opening_start_seconds, opening_end_seconds,
                    title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                    created_at, updated_at
        `;
        return finalizeCreated((rows as Array<Record<string, unknown>>)[0]);
      } catch (err3: unknown) {
        if (!isUndefinedColumnError(err3)) {
          throw err3;
        }
        if (hasOpeningTimes) {
          throw new Error(
            'Não foi possível salvar os horários da opening porque as colunas opening_start_seconds/opening_end_seconds ainda não existem no banco de dados.'
          );
        }

        // Fallback 3: schema legado mínimo (0001) apenas quando não há horários de opening para gravar
        const rows = await sql`
          INSERT INTO public.player_episodes (
            id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5
          ) VALUES (
            ${id},
            ${input.title || input.anime_name || 'Episódio'},
            ${input.poster_url},
            ${input.video_url},
            ${input.video_url_2 ?? null},
            ${input.video_url_3 ?? null},
            ${input.video_url_4 ?? null},
            ${input.video_url_5 ?? null}
          )
          RETURNING id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                    created_at, updated_at
        `;
        return finalizeCreated((rows as Array<Record<string, unknown>>)[0]);
      }
    }
  }
}

async function resolveEpisodeInputUrls(rawInput: EpisodeWriteInput): Promise<EpisodeWriteInput> {
  const videoUrl = rawInput.video_url ? (await resolveVideoInputUrl(rawInput.video_url)).finalUrl : rawInput.video_url;
  const videoUrl2 = rawInput.video_url_2 ? (await resolveVideoInputUrl(rawInput.video_url_2)).finalUrl : rawInput.video_url_2;
  const videoUrl3 = rawInput.video_url_3 ? (await resolveVideoInputUrl(rawInput.video_url_3)).finalUrl : rawInput.video_url_3;
  const videoUrl4 = rawInput.video_url_4 ? (await resolveVideoInputUrl(rawInput.video_url_4)).finalUrl : rawInput.video_url_4;
  const videoUrl5 = rawInput.video_url_5 ? (await resolveVideoInputUrl(rawInput.video_url_5)).finalUrl : rawInput.video_url_5;

  return {
    ...rawInput,
    video_url: videoUrl ?? rawInput.video_url,
    video_url_2: videoUrl2,
    video_url_3: videoUrl3,
    video_url_4: videoUrl4,
    video_url_5: videoUrl5,
  };
}

export async function updateEpisode(
  id: string,
  rawInput: EpisodeWriteInput,
  sqlOverride?: DiagnosticSqlTag
): Promise<PlayerEpisode | null> {
  const cleanId = id.trim();
  if (!cleanId || !/^[A-Za-z0-9_-]+$/.test(cleanId)) {
    return null;
  }

  const resolvedRaw = await resolveEpisodeInputUrls(rawInput);
  const input = sanitizeEpisodeInput(resolvedRaw);
  const sql = sqlOverride ?? (getSql() as unknown as DiagnosticSqlTag);
  const preserveAdditionalSources =
    rawInput.video_url_2 === undefined &&
    rawInput.video_url_3 === undefined &&
    rawInput.video_url_4 === undefined &&
    rawInput.video_url_5 === undefined &&
    rawInput.source_kind_2 === undefined &&
    rawInput.source_kind_3 === undefined &&
    rawInput.source_kind_4 === undefined &&
    rawInput.source_kind_5 === undefined &&
    rawInput.force_proxy_2 === undefined &&
    rawInput.force_proxy_3 === undefined &&
    rawInput.force_proxy_4 === undefined &&
    rawInput.force_proxy_5 === undefined;
  const hasOpeningTimes =
    input.opening_start_seconds !== null &&
    input.opening_start_seconds !== undefined &&
    input.opening_end_seconds !== null &&
    input.opening_end_seconds !== undefined;

  const finalizeUpdated = (row: Record<string, unknown> | undefined): PlayerEpisode | null => {
    if (!row) return null;
    const mapped = mapEpisodeRow(row);
    assertOpeningFieldsPersisted(input, mapped);
    return mapped;
  };

  try {
    const rows = preserveAdditionalSources
      ? await sql`
          UPDATE public.player_episodes
          SET
            anime_name = ${input.anime_name ?? null},
            episode_number = ${input.episode_number ?? null},
            opening_start_seconds = ${input.opening_start_seconds ?? null},
            opening_end_seconds = ${input.opening_end_seconds ?? null},
            title = ${input.title},
            poster_url = ${input.poster_url},
            video_url = ${input.video_url},
            source_kind = ${input.source_kind ?? null},
            force_proxy = ${input.force_proxy ?? true},
            updated_at = NOW()
          WHERE id = ${cleanId}
          RETURNING id, anime_name, episode_number, opening_start_seconds, opening_end_seconds,
                    title, poster_url,
                    video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                    source_kind, source_kind_2, source_kind_3, source_kind_4, source_kind_5,
                    COALESCE(force_proxy, true) AS force_proxy,
                    COALESCE(force_proxy_2, true) AS force_proxy_2,
                    COALESCE(force_proxy_3, true) AS force_proxy_3,
                    COALESCE(force_proxy_4, true) AS force_proxy_4,
                    COALESCE(force_proxy_5, true) AS force_proxy_5,
                    created_at, updated_at
        `
      : await sql`
          UPDATE public.player_episodes
          SET
            anime_name = ${input.anime_name ?? null},
            episode_number = ${input.episode_number ?? null},
            opening_start_seconds = ${input.opening_start_seconds ?? null},
            opening_end_seconds = ${input.opening_end_seconds ?? null},
            title = ${input.title},
            poster_url = ${input.poster_url},
            video_url = ${input.video_url},
            video_url_2 = ${input.video_url_2 ?? null},
            video_url_3 = ${input.video_url_3 ?? null},
            video_url_4 = ${input.video_url_4 ?? null},
            video_url_5 = ${input.video_url_5 ?? null},
            source_kind = ${input.source_kind ?? null},
            source_kind_2 = ${input.source_kind_2 ?? null},
            source_kind_3 = ${input.source_kind_3 ?? null},
            source_kind_4 = ${input.source_kind_4 ?? null},
            source_kind_5 = ${input.source_kind_5 ?? null},
            force_proxy = ${input.force_proxy ?? true},
            force_proxy_2 = ${input.force_proxy_2 ?? true},
            force_proxy_3 = ${input.force_proxy_3 ?? true},
            force_proxy_4 = ${input.force_proxy_4 ?? true},
            force_proxy_5 = ${input.force_proxy_5 ?? true},
            updated_at = NOW()
          WHERE id = ${cleanId}
          RETURNING id, anime_name, episode_number, opening_start_seconds, opening_end_seconds,
                    title, poster_url,
                    video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                    source_kind, source_kind_2, source_kind_3, source_kind_4, source_kind_5,
                    COALESCE(force_proxy, true) AS force_proxy,
                    COALESCE(force_proxy_2, true) AS force_proxy_2,
                    COALESCE(force_proxy_3, true) AS force_proxy_3,
                    COALESCE(force_proxy_4, true) AS force_proxy_4,
                    COALESCE(force_proxy_5, true) AS force_proxy_5,
                    created_at, updated_at
        `;
    return finalizeUpdated((rows as Array<Record<string, unknown>>)[0]);
  } catch (err: unknown) {
    if (!isUndefinedColumnError(err)) {
      throw err;
    }

    // Fallback 1: schema sem anime_name / episode_number (migration 0004 pendente), mas com 0002, 0003 e 0005
    try {
      const rows = preserveAdditionalSources
        ? await sql`
            UPDATE public.player_episodes
            SET
              opening_start_seconds = ${input.opening_start_seconds ?? null},
              opening_end_seconds = ${input.opening_end_seconds ?? null},
              title = ${input.title || input.anime_name || 'Episódio'},
              poster_url = ${input.poster_url},
              video_url = ${input.video_url},
              source_kind = ${input.source_kind ?? null},
              force_proxy = ${input.force_proxy ?? true},
              updated_at = NOW()
            WHERE id = ${cleanId}
            RETURNING id, opening_start_seconds, opening_end_seconds,
                      title, poster_url,
                      video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                      source_kind, source_kind_2, source_kind_3, source_kind_4, source_kind_5,
                      COALESCE(force_proxy, true) AS force_proxy,
                      COALESCE(force_proxy_2, true) AS force_proxy_2,
                      COALESCE(force_proxy_3, true) AS force_proxy_3,
                      COALESCE(force_proxy_4, true) AS force_proxy_4,
                      COALESCE(force_proxy_5, true) AS force_proxy_5,
                      created_at, updated_at
          `
        : await sql`
            UPDATE public.player_episodes
            SET
              opening_start_seconds = ${input.opening_start_seconds ?? null},
              opening_end_seconds = ${input.opening_end_seconds ?? null},
              title = ${input.title || input.anime_name || 'Episódio'},
              poster_url = ${input.poster_url},
              video_url = ${input.video_url},
              video_url_2 = ${input.video_url_2 ?? null},
              video_url_3 = ${input.video_url_3 ?? null},
              video_url_4 = ${input.video_url_4 ?? null},
              video_url_5 = ${input.video_url_5 ?? null},
              source_kind = ${input.source_kind ?? null},
              source_kind_2 = ${input.source_kind_2 ?? null},
              source_kind_3 = ${input.source_kind_3 ?? null},
              source_kind_4 = ${input.source_kind_4 ?? null},
              source_kind_5 = ${input.source_kind_5 ?? null},
              force_proxy = ${input.force_proxy ?? true},
              force_proxy_2 = ${input.force_proxy_2 ?? true},
              force_proxy_3 = ${input.force_proxy_3 ?? true},
              force_proxy_4 = ${input.force_proxy_4 ?? true},
              force_proxy_5 = ${input.force_proxy_5 ?? true},
              updated_at = NOW()
            WHERE id = ${cleanId}
            RETURNING id, opening_start_seconds, opening_end_seconds,
                      title, poster_url,
                      video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                      source_kind, source_kind_2, source_kind_3, source_kind_4, source_kind_5,
                      COALESCE(force_proxy, true) AS force_proxy,
                      COALESCE(force_proxy_2, true) AS force_proxy_2,
                      COALESCE(force_proxy_3, true) AS force_proxy_3,
                      COALESCE(force_proxy_4, true) AS force_proxy_4,
                      COALESCE(force_proxy_5, true) AS force_proxy_5,
                      created_at, updated_at
          `;
      return finalizeUpdated((rows as Array<Record<string, unknown>>)[0]);
    } catch (err2: unknown) {
      if (!isUndefinedColumnError(err2)) {
        throw err2;
      }

      // Fallback 2: schema básico (0001) + colunas de opening (0005)
      try {
        const rows = preserveAdditionalSources
          ? await sql`
              UPDATE public.player_episodes
              SET
                opening_start_seconds = ${input.opening_start_seconds ?? null},
                opening_end_seconds = ${input.opening_end_seconds ?? null},
                title = ${input.title || input.anime_name || 'Episódio'},
                poster_url = ${input.poster_url},
                video_url = ${input.video_url},
                updated_at = NOW()
              WHERE id = ${cleanId}
              RETURNING id, opening_start_seconds, opening_end_seconds,
                        title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                        created_at, updated_at
            `
          : await sql`
              UPDATE public.player_episodes
              SET
                opening_start_seconds = ${input.opening_start_seconds ?? null},
                opening_end_seconds = ${input.opening_end_seconds ?? null},
                title = ${input.title || input.anime_name || 'Episódio'},
                poster_url = ${input.poster_url},
                video_url = ${input.video_url},
                video_url_2 = ${input.video_url_2 ?? null},
                video_url_3 = ${input.video_url_3 ?? null},
                video_url_4 = ${input.video_url_4 ?? null},
                video_url_5 = ${input.video_url_5 ?? null},
                updated_at = NOW()
              WHERE id = ${cleanId}
              RETURNING id, opening_start_seconds, opening_end_seconds,
                        title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                        created_at, updated_at
            `;
        return finalizeUpdated((rows as Array<Record<string, unknown>>)[0]);
      } catch (err3: unknown) {
        if (!isUndefinedColumnError(err3)) {
          throw err3;
        }
        if (hasOpeningTimes) {
          throw new Error(
            'Não foi possível salvar os horários da opening porque as colunas opening_start_seconds/opening_end_seconds ainda não existem no banco de dados.'
          );
        }

        // Fallback 3: schema legado mínimo (0001) apenas quando não há horários de opening para gravar
        const rows = preserveAdditionalSources
          ? await sql`
              UPDATE public.player_episodes
              SET
                title = ${input.title || input.anime_name || 'Episódio'},
                poster_url = ${input.poster_url},
                video_url = ${input.video_url},
                updated_at = NOW()
              WHERE id = ${cleanId}
              RETURNING id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                        created_at, updated_at
            `
          : await sql`
              UPDATE public.player_episodes
              SET
                title = ${input.title || input.anime_name || 'Episódio'},
                poster_url = ${input.poster_url},
                video_url = ${input.video_url},
                video_url_2 = ${input.video_url_2 ?? null},
                video_url_3 = ${input.video_url_3 ?? null},
                video_url_4 = ${input.video_url_4 ?? null},
                video_url_5 = ${input.video_url_5 ?? null},
                updated_at = NOW()
              WHERE id = ${cleanId}
              RETURNING id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                        created_at, updated_at
            `;
        return finalizeUpdated((rows as Array<Record<string, unknown>>)[0]);
      }
    }
  }
}

export async function appendEpisodeIframeSource(
  episodeId: string,
  normalizedUrl: string,
  sqlOverride?: DiagnosticSqlTag
): Promise<{
  saved: boolean;
  slot: 1 | 2 | 3 | 4 | 5 | null;
  reason: string;
}> {
  const episode = await getEpisodeById(episodeId);
  if (!episode) {
    return {
      saved: false,
      slot: null,
      reason: 'Episódio não encontrado no banco de dados.',
    };
  }

  const plan = planEpisodeSlotInsertion(episode, normalizedUrl, 'iframe');
  if (plan.action === 'skip') {
    return {
      saved: false,
      slot: null,
      reason: plan.reason,
    };
  }

  const updated = await updateEpisode(
    episode.id,
    {
      anime_name: episode.anime_name,
      episode_number: episode.episode_number,
      opening_start_seconds: episode.opening_start_seconds,
      opening_end_seconds: episode.opening_end_seconds,
      title: episode.title,
      poster_url: episode.poster_url,
      video_url: plan.patch.video_url ?? episode.video_url,
      video_url_2: plan.patch.video_url_2 !== undefined ? plan.patch.video_url_2 : episode.video_url_2,
      video_url_3: plan.patch.video_url_3 !== undefined ? plan.patch.video_url_3 : episode.video_url_3,
      video_url_4: plan.patch.video_url_4 !== undefined ? plan.patch.video_url_4 : episode.video_url_4,
      video_url_5: plan.patch.video_url_5 !== undefined ? plan.patch.video_url_5 : episode.video_url_5,
      source_kind: plan.patch.source_kind !== undefined ? plan.patch.source_kind : episode.source_kind,
      source_kind_2: plan.patch.source_kind_2 !== undefined ? plan.patch.source_kind_2 : episode.source_kind_2,
      source_kind_3: plan.patch.source_kind_3 !== undefined ? plan.patch.source_kind_3 : episode.source_kind_3,
      source_kind_4: plan.patch.source_kind_4 !== undefined ? plan.patch.source_kind_4 : episode.source_kind_4,
      source_kind_5: plan.patch.source_kind_5 !== undefined ? plan.patch.source_kind_5 : episode.source_kind_5,
      force_proxy: episode.force_proxy,
      force_proxy_2: episode.force_proxy_2,
      force_proxy_3: episode.force_proxy_3,
      force_proxy_4: episode.force_proxy_4,
      force_proxy_5: episode.force_proxy_5,
    },
    sqlOverride
  );

  if (!updated) {
    return {
      saved: false,
      slot: null,
      reason: 'Episódio não encontrado ao confirmar gravação.',
    };
  }

  return {
    saved: true,
    slot: plan.slot,
    reason: plan.reason,
  };
}

export function findEpisodeMirrorSlot(episode: Pick<
  PlayerEpisode,
  | 'video_url'
  | 'video_url_2'
  | 'video_url_3'
  | 'video_url_4'
  | 'video_url_5'
  | 'is_mirror'
  | 'is_mirror_2'
  | 'is_mirror_3'
  | 'is_mirror_4'
  | 'is_mirror_5'
>): 1 | 2 | 3 | 4 | 5 | null {
  const slots: Array<{ slot: 1 | 2 | 3 | 4 | 5; url: string | null; flag: boolean | null | undefined }> = [
    { slot: 1, url: episode.video_url, flag: episode.is_mirror },
    { slot: 2, url: episode.video_url_2, flag: episode.is_mirror_2 },
    { slot: 3, url: episode.video_url_3, flag: episode.is_mirror_3 },
    { slot: 4, url: episode.video_url_4, flag: episode.is_mirror_4 },
    { slot: 5, url: episode.video_url_5, flag: episode.is_mirror_5 },
  ];

  for (const item of slots) {
    if (!item.url?.trim()) continue;
    if (item.flag === true || isVercelBlobUrl(item.url)) {
      return item.slot;
    }
  }
  return null;
}

export function findNextFreeMirrorSlot(episode: Pick<
  PlayerEpisode,
  'video_url' | 'video_url_2' | 'video_url_3' | 'video_url_4' | 'video_url_5'
>): 1 | 2 | 3 | 4 | 5 | null {
  if (!episode.video_url?.trim()) return 1;
  if (!episode.video_url_2?.trim()) return 2;
  if (!episode.video_url_3?.trim()) return 3;
  if (!episode.video_url_4?.trim()) return 4;
  if (!episode.video_url_5?.trim()) return 5;
  return null;
}

export async function saveEpisodeMirrorSource(
  episodeId: string,
  blobUrl: string,
  options: {
    force?: boolean;
    kind?: ExplicitSourceKind;
    forceProxy?: boolean;
    sqlOverride?: DiagnosticSqlTag;
  } = {}
): Promise<{
  episode: PlayerEpisode;
  slot: 1 | 2 | 3 | 4 | 5;
}> {
  const urlCheck = validateHttpUrl(blobUrl);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    throw new Error(`URL do espelho inválida: ${urlCheck.error ?? 'URL malformada'}`);
  }
  const normalizedBlobUrl = urlCheck.normalizedUrl;
  const derivedKind =
    normalizeExplicitSourceKind(options.kind) ?? deriveKindFromExtension(normalizedBlobUrl);
  const sql = options.sqlOverride ?? (getSql() as unknown as DiagnosticSqlTag);
  const episode = await getEpisodeById(episodeId, options.sqlOverride);

  if (!episode) {
    throw new Error('Episódio não encontrado.');
  }

  const existingMirrorSlot = findEpisodeMirrorSlot(episode);
  if (existingMirrorSlot && !options.force) {
    throw new Error('Este episódio já possui um espelho salvo. Marque "forçar refazer" para substituir.');
  }

  const targetSlot = existingMirrorSlot ?? findNextFreeMirrorSlot(episode);
  if (!targetSlot) {
    throw new Error('Todos os 5 slots de fontes deste episódio já estão preenchidos.');
  }

  const runSlotUpdate = async (withMirrorColumn: boolean): Promise<Record<string, unknown> | undefined> => {
    if (targetSlot === 1) {
      const rows = withMirrorColumn
        ? await sql`
            UPDATE public.player_episodes
            SET video_url = ${normalizedBlobUrl}, source_kind = ${derivedKind}, force_proxy = false, is_mirror = true, updated_at = NOW()
            WHERE id = ${episode.id}
            RETURNING *
          `
        : await sql`
            UPDATE public.player_episodes
            SET video_url = ${normalizedBlobUrl}, source_kind = ${derivedKind}, force_proxy = false, updated_at = NOW()
            WHERE id = ${episode.id}
            RETURNING *
          `;
      return (rows as Array<Record<string, unknown>>)[0];
    }
    if (targetSlot === 2) {
      const rows = withMirrorColumn
        ? await sql`
            UPDATE public.player_episodes
            SET video_url_2 = ${normalizedBlobUrl}, source_kind_2 = ${derivedKind}, force_proxy_2 = false, is_mirror_2 = true, updated_at = NOW()
            WHERE id = ${episode.id}
            RETURNING *
          `
        : await sql`
            UPDATE public.player_episodes
            SET video_url_2 = ${normalizedBlobUrl}, source_kind_2 = ${derivedKind}, force_proxy_2 = false, updated_at = NOW()
            WHERE id = ${episode.id}
            RETURNING *
          `;
      return (rows as Array<Record<string, unknown>>)[0];
    }
    if (targetSlot === 3) {
      const rows = withMirrorColumn
        ? await sql`
            UPDATE public.player_episodes
            SET video_url_3 = ${normalizedBlobUrl}, source_kind_3 = ${derivedKind}, force_proxy_3 = false, is_mirror_3 = true, updated_at = NOW()
            WHERE id = ${episode.id}
            RETURNING *
          `
        : await sql`
            UPDATE public.player_episodes
            SET video_url_3 = ${normalizedBlobUrl}, source_kind_3 = ${derivedKind}, force_proxy_3 = false, updated_at = NOW()
            WHERE id = ${episode.id}
            RETURNING *
          `;
      return (rows as Array<Record<string, unknown>>)[0];
    }
    if (targetSlot === 4) {
      const rows = withMirrorColumn
        ? await sql`
            UPDATE public.player_episodes
            SET video_url_4 = ${normalizedBlobUrl}, source_kind_4 = ${derivedKind}, force_proxy_4 = false, is_mirror_4 = true, updated_at = NOW()
            WHERE id = ${episode.id}
            RETURNING *
          `
        : await sql`
            UPDATE public.player_episodes
            SET video_url_4 = ${normalizedBlobUrl}, source_kind_4 = ${derivedKind}, force_proxy_4 = false, updated_at = NOW()
            WHERE id = ${episode.id}
            RETURNING *
          `;
      return (rows as Array<Record<string, unknown>>)[0];
    }
    const rows = withMirrorColumn
      ? await sql`
          UPDATE public.player_episodes
          SET video_url_5 = ${normalizedBlobUrl}, source_kind_5 = ${derivedKind}, force_proxy_5 = false, is_mirror_5 = true, updated_at = NOW()
          WHERE id = ${episode.id}
          RETURNING *
        `
      : await sql`
          UPDATE public.player_episodes
          SET video_url_5 = ${normalizedBlobUrl}, source_kind_5 = ${derivedKind}, force_proxy_5 = false, updated_at = NOW()
          WHERE id = ${episode.id}
          RETURNING *
        `;
    return (rows as Array<Record<string, unknown>>)[0];
  };

  let row: Record<string, unknown> | undefined;
  try {
    row = await runSlotUpdate(true);
  } catch (err) {
    if (!isUndefinedColumnError(err)) {
      throw err;
    }
    row = await runSlotUpdate(false);
  }

  if (!row) {
    throw new Error('Episódio não encontrado ao gravar espelho.');
  }

  const mapped = mapEpisodeRow(row);
  if (targetSlot === 1) mapped.is_mirror = true;
  if (targetSlot === 2) mapped.is_mirror_2 = true;
  if (targetSlot === 3) mapped.is_mirror_3 = true;
  if (targetSlot === 4) mapped.is_mirror_4 = true;
  if (targetSlot === 5) mapped.is_mirror_5 = true;

  return {
    episode: mapped,
    slot: targetSlot,
  };
}

export async function deleteEpisode(id: string): Promise<boolean> {
  const cleanId = id.trim();
  if (!cleanId || !/^[A-Za-z0-9_-]+$/.test(cleanId)) {
    return false;
  }

  const sql = getSql();
  const rows = await sql`
    DELETE FROM public.player_episodes
    WHERE id = ${cleanId}
    RETURNING id
  `;
  return (rows as Array<Record<string, unknown>>).length > 0;
}

export function inspectDatabaseUrlSafely(rawUrl = process.env.DATABASE_URL): DatabaseEnvDiagnostic {
  const trimmed = rawUrl?.trim() ?? '';
  const vercelEnv = process.env.VERCEL_ENV?.trim() || null;
  const nodeEnv = process.env.NODE_ENV?.trim() || null;

  if (!trimmed) {
    return {
      configured: false,
      validUrl: false,
      parseError: 'DATABASE_URL não definida no ambiente do servidor.',
      hostname: null,
      database: null,
      hasUserInUrl: false,
      hasPasswordInUrl: false,
      hasPooling: false,
      vercelEnv,
      nodeEnv,
    };
  }

  let parsed: URL;
  let scheme: string;
  try {
    const rawParsed = new URL(trimmed);
    scheme = rawParsed.protocol.toLowerCase();
    // Parse with http: mirror just like @neondatabase/serverless so special-scheme rules apply consistently.
    parsed = new URL(`http:${trimmed.slice(rawParsed.protocol.length)}`);
  } catch {
    return {
      configured: true,
      validUrl: false,
      parseError:
        'DATABASE_URL não possui formato de URL válido (verifique se não há aspas extras, prefixo "psql" ou caracteres não escapados).',
      hostname: null,
      database: null,
      hasUserInUrl: false,
      hasPasswordInUrl: false,
      hasPooling: false,
      vercelEnv,
      nodeEnv,
    };
  }

  const isPostgres = scheme === 'postgres:' || scheme === 'postgresql:';
  if (!isPostgres) {
    return {
      configured: true,
      validUrl: false,
      parseError: `Esquema inválido na DATABASE_URL (${scheme}); esperado postgres:// ou postgresql://.`,
      hostname: null,
      database: null,
      hasUserInUrl: false,
      hasPasswordInUrl: false,
      hasPooling: false,
      vercelEnv,
      nodeEnv,
    };
  }

  const hostname = parsed.hostname && parsed.hostname !== '-' ? parsed.hostname : null;
  const dbName = parsed.pathname.replace(/^\/+/, '') || null;
  const hasUserInUrl = Boolean(parsed.username);
  const hasPasswordInUrl = Boolean(parsed.password);
  const hasPooling =
    Boolean(hostname?.includes('-pooler')) ||
    parsed.searchParams.has('pgbouncer') ||
    parsed.searchParams.has('pooler');

  const missingParts: string[] = [];
  if (!hostname) missingParts.push('hostname');
  if (!hasUserInUrl) missingParts.push('usuário');
  if (!dbName) missingParts.push('nome do banco (/neondb)');

  const validUrl = missingParts.length === 0;
  const parseError = validUrl
    ? null
    : `DATABASE_URL incompleta: ausente ${missingParts.join(', ')}.`;

  return {
    configured: true,
    validUrl,
    parseError,
    hostname,
    database: dbName,
    hasUserInUrl,
    hasPasswordInUrl,
    hasPooling,
    vercelEnv,
    nodeEnv,
  };
}

export function sanitizeDiagnosticError(
  err: unknown,
  rawUrl = process.env.DATABASE_URL
): SanitizedDbError {
  const name =
    err instanceof Error && err.name ? err.name : 'DatabaseError';
  let message =
    err instanceof Error && err.message
      ? err.message
      : 'Erro desconhecido ao consultar o Neon.';
  const trimmed = rawUrl?.trim();

  if (trimmed) {
    message = message.split(trimmed).join('[REDACTED_URL]');
    try {
      const rawParsed = new URL(trimmed);
      const parsed = new URL(`http:${trimmed.slice(rawParsed.protocol.length)}`);

      if (parsed.password) {
        message = message.split(parsed.password).join('[REDACTED]');
        try {
          const decodedPassword = decodeURIComponent(parsed.password);
          if (decodedPassword) {
            message = message.split(decodedPassword).join('[REDACTED]');
          }
        } catch {
          // Ignore invalid percent-encoding
        }
      }

      if (parsed.username) {
        message = message.split(parsed.username).join('[REDACTED_USER]');
        try {
          const decodedUser = decodeURIComponent(parsed.username);
          if (decodedUser) {
            message = message.split(decodedUser).join('[REDACTED_USER]');
          }
        } catch {
          // Ignore invalid percent-encoding
        }
      }
    } catch {
      // Ignore malformed URL during redaction
    }
  }

  message = message.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '[REDACTED_POSTGRES_URL]');

  const rawCode =
    err && typeof err === 'object' && 'code' in err
      ? (err as { code?: unknown }).code
      : null;
  const code = typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim() : null;

  return { name, code, message };
}

export type DiagnosticSqlTag = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown>;

function describeDriverShape(rows: unknown): string {
  if (Array.isArray(rows)) {
    const first = rows[0];
    const keys =
      first && typeof first === 'object' ? Object.keys(first as Record<string, unknown>) : [];
    return `array(${rows.length})${keys.length ? ` [${keys.join(', ')}]` : ''}`;
  }
  if (rows && typeof rows === 'object') {
    return `object(${Object.keys(rows as Record<string, unknown>).join(', ')})`;
  }
  return typeof rows;
}

export async function runDiagnosticWithSql(
  sql: DiagnosticSqlTag | null,
  env: DatabaseEnvDiagnostic,
  checkedAt = new Date().toISOString(),
  rawUrl = process.env.DATABASE_URL
): Promise<DatabaseDiagnosticResult> {
  if (!env.configured) {
    return {
      checkedAt,
      diagnosisCode: 'env_missing',
      diagnosisSummary: 'DATABASE_URL não está configurada no ambiente do servidor.',
      env,
      connectionEstablished: false,
      diagnosticQueryExecuted: false,
      rawResultShape: null,
      connectionError: {
        name: 'DatabaseNotConfiguredError',
        code: null,
        message: 'DATABASE_URL do Neon não está configurada no ambiente do servidor.',
      },
      connection: null,
      diagnosticQueryError: null,
      tableReadExecuted: false,
      episodeCount: null,
      tableReadError: null,
      unqualifiedTableReadOk: null,
      unqualifiedTableReadError: null,
      expectedColumns: [],
      missingColumns: [],
      forceProxyColumnsCount: 0,
      forceProxyColumnsTotal: 5,
      correctionSql: null,
    };
  }

  if (!env.validUrl || !sql) {
    return {
      checkedAt,
      diagnosisCode: 'env_invalid',
      diagnosisSummary:
        env.parseError ?? 'DATABASE_URL está configurada, mas não pôde ser interpretada.',
      env,
      connectionEstablished: false,
      diagnosticQueryExecuted: false,
      rawResultShape: null,
      connectionError: {
        name: 'InvalidDatabaseUrlError',
        code: null,
        message: env.parseError ?? 'Formato inválido de DATABASE_URL.',
      },
      connection: null,
      diagnosticQueryError: null,
      tableReadExecuted: false,
      episodeCount: null,
      tableReadError: null,
      unqualifiedTableReadOk: null,
      unqualifiedTableReadError: null,
      expectedColumns: [],
      missingColumns: [],
      forceProxyColumnsCount: 0,
      forceProxyColumnsTotal: 5,
      correctionSql: null,
    };
  }

  let currentDb: string | null = null;
  let currentSchema: string | null = null;
  let currentUser: string | null = null;
  let searchPath: string | null = null;
  let rawResultShape: string | null = null;

  // Etapa 2: Validar conexão e contexto da sessão no Neon
  try {
    const sessionRows = await sql`
      SELECT
        current_database() AS current_database,
        current_schema() AS current_schema,
        current_user AS current_user,
        current_setting('search_path') AS search_path
    `;
    rawResultShape = describeDriverShape(sessionRows);

    if (!Array.isArray(sessionRows) || sessionRows.length === 0 || typeof sessionRows[0] !== 'object' || sessionRows[0] === null) {
      return {
        checkedAt,
        diagnosisCode: 'result_interpretation_error',
        diagnosisSummary: `Conexão respondeu, mas o driver Neon retornou um formato inesperado (${rawResultShape}).`,
        env,
        connectionEstablished: true,
        diagnosticQueryExecuted: true,
        rawResultShape,
        connectionError: null,
        connection: null,
        diagnosticQueryError: {
          name: 'UnexpectedDriverResultError',
          code: null,
          message: `Esperado array não vazio de linhas do Neon; recebido: ${rawResultShape}.`,
        },
        tableReadExecuted: false,
        episodeCount: null,
        tableReadError: null,
        unqualifiedTableReadOk: null,
        unqualifiedTableReadError: null,
        expectedColumns: [],
        missingColumns: [],
        forceProxyColumnsCount: 0,
        forceProxyColumnsTotal: 5,
        correctionSql: null,
      };
    }

    const row = sessionRows[0] as Record<string, unknown>;
    currentDb = row.current_database !== null && row.current_database !== undefined ? String(row.current_database) : null;
    currentSchema = row.current_schema !== null && row.current_schema !== undefined ? String(row.current_schema) : null;
    currentUser = row.current_user !== null && row.current_user !== undefined ? String(row.current_user) : null;
    searchPath = row.search_path !== null && row.search_path !== undefined ? String(row.search_path) : null;
  } catch (err) {
    const connectionError = sanitizeDiagnosticError(err, rawUrl);
    return {
      checkedAt,
      diagnosisCode: 'connection_failed',
      diagnosisSummary: `DATABASE_URL está configurada (host ${env.hostname ?? 'desconhecido'}), mas a conexão/consulta inicial ao Neon falhou: ${connectionError.message}`,
      env,
      connectionEstablished: false,
      diagnosticQueryExecuted: false,
      rawResultShape,
      connectionError,
      connection: null,
      diagnosticQueryError: null,
      tableReadExecuted: false,
      episodeCount: null,
      tableReadError: null,
      unqualifiedTableReadOk: null,
      unqualifiedTableReadError: null,
      expectedColumns: [],
      missingColumns: [],
      forceProxyColumnsCount: 0,
      forceProxyColumnsTotal: 5,
      correctionSql: null,
    };
  }

  // Etapa 3: Verificar existência da tabela em public e no search_path
  let publicTable: string | null = null;
  let resolvedTable: string | null = null;
  let diagnosticQueryExecuted = false;
  let diagnosticQueryError: SanitizedDbError | null = null;

  try {
    const regRows = await sql`
      SELECT
        to_regclass('public.player_episodes')::text AS public_table,
        to_regclass('player_episodes')::text AS resolved_table
    `;
    diagnosticQueryExecuted = true;
    if (Array.isArray(regRows) && regRows[0] && typeof regRows[0] === 'object') {
      const regRow = regRows[0] as Record<string, unknown>;
      publicTable =
        regRow.public_table !== null && regRow.public_table !== undefined
          ? String(regRow.public_table)
          : null;
      resolvedTable =
        regRow.resolved_table !== null && regRow.resolved_table !== undefined
          ? String(regRow.resolved_table)
          : null;
    }
  } catch (err) {
    diagnosticQueryError = sanitizeDiagnosticError(err, rawUrl);
  }

  const connection: DatabaseQueryDiagnostic = {
    current_database: currentDb,
    current_schema: currentSchema,
    current_user: currentUser,
    search_path: searchPath,
    public_table: publicTable,
    resolved_table: resolvedTable,
  };

  // Etapa 4: Consulta simples somente leitura à tabela public.player_episodes e player_episodes
  let tableReadExecuted = false;
  let episodeCount: number | null = null;
  let tableReadError: SanitizedDbError | null = null;

  try {
    const countRows = await sql`
      SELECT COUNT(*)::int AS episode_count
      FROM public.player_episodes
    `;
    tableReadExecuted = true;
    if (Array.isArray(countRows) && countRows[0] && typeof countRows[0] === 'object') {
      const val = (countRows[0] as Record<string, unknown>).episode_count;
      episodeCount = val !== null && val !== undefined && !Number.isNaN(Number(val)) ? Number(val) : null;
    }
  } catch (err) {
    tableReadError = sanitizeDiagnosticError(err, rawUrl);
  }

  let unqualifiedTableReadOk: boolean | null = null;
  let unqualifiedTableReadError: SanitizedDbError | null = null;

  try {
    await sql`
      SELECT COUNT(*)::int AS episode_count
      FROM player_episodes
    `;
    unqualifiedTableReadOk = true;
  } catch (err) {
    unqualifiedTableReadOk = false;
    unqualifiedTableReadError = sanitizeDiagnosticError(err, rawUrl);
  }

  let diagnosisCode: DatabaseDiagnosisCode = 'ok';
  let diagnosisSummary = `Conexão ativa no banco "${currentDb ?? '?'}" (schema "${currentSchema ?? '?'}") e leitura de public.player_episodes bem-sucedida (${episodeCount ?? 0} registro(s)).`;

  const expectedColumns = [
    'id',
    'title',
    'poster_url',
    'video_url',
    'video_url_2',
    'video_url_3',
    'video_url_4',
    'video_url_5',
    'force_proxy',
    'force_proxy_2',
    'force_proxy_3',
    'force_proxy_4',
    'force_proxy_5',
    'created_at',
    'updated_at',
  ];
  let existingColumns: string[] = [];
  try {
    const colRows = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'player_episodes'
    `;
    if (Array.isArray(colRows)) {
      existingColumns = colRows.map((r: any) => String(r.column_name));
    }
  } catch {}

  const expectedProxyColumns = [
    'force_proxy',
    'force_proxy_2',
    'force_proxy_3',
    'force_proxy_4',
    'force_proxy_5',
  ];
  const forceProxyColumnsCount = expectedProxyColumns.filter((c) => existingColumns.includes(c)).length;
  const forceProxyColumnsTotal = 5;

  const missingColumns = expectedColumns.filter((c) => !existingColumns.includes(c));
  const correctionSql = missingColumns.length > 0
    ? missingColumns.map((c) => `ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS ${c} ${c.startsWith('force_proxy') ? 'boolean DEFAULT true' : 'TEXT'};`).join('\n')
    : null;

  if (missingColumns.length > 0 && diagnosisCode === 'ok') {
    diagnosisCode = 'query_failed';
    diagnosisSummary = `Tabela public.player_episodes encontrada, mas faltam colunas essenciais: ${missingColumns.join(', ')}. Aplique o SQL de correção abaixo.`;
  }

  if (diagnosticQueryError) {
    diagnosisCode = 'query_failed';
    diagnosisSummary = `Conexão estabelecida no banco "${currentDb ?? '?'}", mas a consulta de metadados falhou: ${diagnosticQueryError.message}`;
  } else if (!publicTable) {
    diagnosisCode = 'table_missing_in_public';
    diagnosisSummary = `Conexão estabelecida no banco "${currentDb ?? '?'}" (host "${env.hostname ?? '?'}"), mas public.player_episodes retornou NULL. Isso indica que o ambiente está conectado a outro banco, projeto ou branch do Neon onde a migration não foi aplicada.`;
  } else if (tableReadError) {
    diagnosisCode = 'query_failed';
    diagnosisSummary = `Tabela public.player_episodes encontrada (${publicTable}), mas SELECT COUNT(*) falhou: ${tableReadError.message}`;
  } else if (unqualifiedTableReadOk === false || !resolvedTable) {
    diagnosisCode = 'search_path_mismatch';
    diagnosisSummary = `Tabela public.player_episodes acessível (${episodeCount ?? 0} registro(s)), porém a consulta sem schema ("player_episodes") falhou com search_path="${searchPath ?? 'desconhecido'}".`;
  }

  return {
    checkedAt,
    diagnosisCode,
    diagnosisSummary,
    env,
    connectionEstablished: true,
    diagnosticQueryExecuted,
    rawResultShape,
    connectionError: null,
    connection,
    diagnosticQueryError,
    tableReadExecuted,
    episodeCount,
    tableReadError,
    unqualifiedTableReadOk,
    unqualifiedTableReadError,
    expectedColumns,
    missingColumns,
    forceProxyColumnsCount,
    forceProxyColumnsTotal,
    correctionSql,
  };
}

export async function diagnoseDatabaseConnection(): Promise<DatabaseDiagnosticResult> {
  const checkedAt = new Date().toISOString();
  const env = inspectDatabaseUrlSafely();

  if (!env.configured || !env.validUrl) {
    return runDiagnosticWithSql(null, env, checkedAt);
  }

  let sql: DiagnosticSqlTag;
  try {
    sql = getSql() as unknown as DiagnosticSqlTag;
  } catch (err) {
    const connectionError = sanitizeDiagnosticError(err);
    return {
      checkedAt,
      diagnosisCode: env.configured ? 'connection_failed' : 'env_missing',
      diagnosisSummary: connectionError.message,
      env,
      connectionEstablished: false,
      diagnosticQueryExecuted: false,
      rawResultShape: null,
      connectionError,
      connection: null,
      diagnosticQueryError: null,
      tableReadExecuted: false,
      episodeCount: null,
      tableReadError: null,
      unqualifiedTableReadOk: null,
      unqualifiedTableReadError: null,
      expectedColumns: [],
      missingColumns: [],
      forceProxyColumnsCount: 0,
      forceProxyColumnsTotal: 5,
      correctionSql: null,
    };
  }

  return runDiagnosticWithSql(sql, env, checkedAt);
}

export const EXPECTED_PROXY_COLUMNS = [
  'force_proxy',
  'force_proxy_2',
  'force_proxy_3',
  'force_proxy_4',
  'force_proxy_5',
] as const;

export async function verifySchemaOnBoot(): Promise<{
  existingColumns: string[];
  missingColumns: string[];
  forceProxyColumnsCount: number;
  correctionSql: string | null;
}> {
  if (!isDatabaseConfigured()) {
    return {
      existingColumns: [],
      missingColumns: [],
      forceProxyColumnsCount: 0,
      correctionSql: null,
    };
  }

  try {
    const sql = getSql();
    const colRows = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'player_episodes'
    `;
    const existing = Array.isArray(colRows) ? colRows.map((r: any) => String(r.column_name)) : [];
    const missing = EXPECTED_PROXY_COLUMNS.filter((c) => !existing.includes(c));
    const forceProxyColumnsCount = EXPECTED_PROXY_COLUMNS.filter((c) => existing.includes(c)).length;

    const correctionSql = missing.length > 0
      ? missing
          .map((c) => `ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS ${c} boolean DEFAULT true;`)
          .join('\n')
      : null;

    if (missing.length > 0) {
      console.warn(
        `[BOOT SCHEMA WARNING] Colunas force_proxy ausentes (${forceProxyColumnsCount}/5 presentes): ${missing.join(', ')}\n` +
        `SQL pronto para aplicar no Neon:\n${correctionSql}`
      );
    } else {
      console.log(`[BOOT SCHEMA OK] 5/5 colunas force_proxy verificadas em player_episodes.`);
    }

    return {
      existingColumns: existing,
      missingColumns: missing,
      forceProxyColumnsCount,
      correctionSql,
    };
  } catch (err: any) {
    console.warn('[BOOT SCHEMA ERROR] Não foi possível verificar colunas no boot:', err?.message || err);
    return {
      existingColumns: [],
      missingColumns: [],
      forceProxyColumnsCount: 0,
      correctionSql: null,
    };
  }
}

// Inicia verificação no boot do servidor caso esteja em ambiente Node/Server
if (typeof window === 'undefined' && isDatabaseConfigured()) {
  void verifySchemaOnBoot();
}

