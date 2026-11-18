import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { validateHttpUrl } from '@/lib/video-sources';

export interface PlayerEpisode {
  id: string;
  title: string;
  poster_url: string;
  video_url: string;
  video_url_2: string | null;
  video_url_3: string | null;
  video_url_4: string | null;
  video_url_5: string | null;
  created_at: string;
  updated_at: string;
}

export interface EpisodeWriteInput {
  title: string;
  poster_url: string;
  video_url: string;
  video_url_2?: string | null;
  video_url_3?: string | null;
  video_url_4?: string | null;
  video_url_5?: string | null;
}

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super('DATABASE_URL do Neon não está configurada no ambiente do servidor.');
    this.name = 'DatabaseNotConfiguredError';
  }
}

export function isDatabaseConfigured(): boolean {
  const url = process.env.DATABASE_URL?.trim();
  return Boolean(url && url.startsWith('postgres'));
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
  const title = input.title?.trim() ?? '';
  if (!title || title.length > 200) {
    throw new Error('O título do episódio é obrigatório (máximo 200 caracteres).');
  }

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

  const sanitizedOptional: Record<string, string | null> = {};
  for (const [key, label] of optionalSlots) {
    const raw = input[key];
    if (!raw || !raw.trim()) {
      sanitizedOptional[key] = null;
      continue;
    }
    const check = validateHttpUrl(raw);
    if (!check.valid || !check.normalizedUrl) {
      throw new Error(`${label} inválido: ${check.error}`);
    }
    sanitizedOptional[key] = check.normalizedUrl;
  }

  return {
    title,
    poster_url: posterCheck.normalizedUrl,
    video_url: primaryCheck.normalizedUrl,
    video_url_2: sanitizedOptional.video_url_2,
    video_url_3: sanitizedOptional.video_url_3,
    video_url_4: sanitizedOptional.video_url_4,
    video_url_5: sanitizedOptional.video_url_5,
  };
}

function mapEpisodeRow(row: Record<string, unknown>): PlayerEpisode {
  return {
    id: String(row.id),
    title: String(row.title),
    poster_url: String(row.poster_url),
    video_url: String(row.video_url),
    video_url_2: row.video_url_2 ? String(row.video_url_2) : null,
    video_url_3: row.video_url_3 ? String(row.video_url_3) : null,
    video_url_4: row.video_url_4 ? String(row.video_url_4) : null,
    video_url_5: row.video_url_5 ? String(row.video_url_5) : null,
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
  };
}

export async function listEpisodes(): Promise<PlayerEpisode[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5, created_at, updated_at
    FROM player_episodes
    ORDER BY created_at DESC
  `;
  return (rows as Array<Record<string, unknown>>).map(mapEpisodeRow);
}

export async function getEpisodeById(id: string): Promise<PlayerEpisode | null> {
  const cleanId = id.trim();
  if (!cleanId || cleanId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cleanId)) {
    return null;
  }

  const sql = getSql();
  const rows = await sql`
    SELECT id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5, created_at, updated_at
    FROM player_episodes
    WHERE id = ${cleanId}
    LIMIT 1
  `;
  const row = (rows as Array<Record<string, unknown>>)[0];
  return row ? mapEpisodeRow(row) : null;
}

export async function createEpisode(rawInput: EpisodeWriteInput): Promise<PlayerEpisode> {
  const input = sanitizeEpisodeInput(rawInput);
  const id = generateEpisodeId();
  const sql = getSql();

  const rows = await sql`
    INSERT INTO player_episodes (
      id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5
    ) VALUES (
      ${id},
      ${input.title},
      ${input.poster_url},
      ${input.video_url},
      ${input.video_url_2 ?? null},
      ${input.video_url_3 ?? null},
      ${input.video_url_4 ?? null},
      ${input.video_url_5 ?? null}
    )
    RETURNING id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5, created_at, updated_at
  `;

  return mapEpisodeRow((rows as Array<Record<string, unknown>>)[0]);
}

export async function updateEpisode(
  id: string,
  rawInput: EpisodeWriteInput
): Promise<PlayerEpisode | null> {
  const cleanId = id.trim();
  if (!cleanId || !/^[A-Za-z0-9_-]+$/.test(cleanId)) {
    return null;
  }

  const input = sanitizeEpisodeInput(rawInput);
  const sql = getSql();

  const rows = await sql`
    UPDATE player_episodes
    SET
      title = ${input.title},
      poster_url = ${input.poster_url},
      video_url = ${input.video_url},
      video_url_2 = ${input.video_url_2 ?? null},
      video_url_3 = ${input.video_url_3 ?? null},
      video_url_4 = ${input.video_url_4 ?? null},
      video_url_5 = ${input.video_url_5 ?? null},
      updated_at = NOW()
    WHERE id = ${cleanId}
    RETURNING id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5, created_at, updated_at
  `;

  const row = (rows as Array<Record<string, unknown>>)[0];
  return row ? mapEpisodeRow(row) : null;
}

export async function deleteEpisode(id: string): Promise<boolean> {
  const cleanId = id.trim();
  if (!cleanId || !/^[A-Za-z0-9_-]+$/.test(cleanId)) {
    return false;
  }

  const sql = getSql();
  const rows = await sql`
    DELETE FROM player_episodes
    WHERE id = ${cleanId}
    RETURNING id
  `;
  return (rows as Array<Record<string, unknown>>).length > 0;
}
