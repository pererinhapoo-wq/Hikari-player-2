import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import type { DatabaseDiagnosticResult, DatabaseEnvDiagnostic } from '@/lib/types';
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

export function inspectDatabaseUrlSafely(rawUrl = process.env.DATABASE_URL): DatabaseEnvDiagnostic {
  const trimmed = rawUrl?.trim() ?? '';
  const vercelEnv = process.env.VERCEL_ENV?.trim() || null;

  if (!trimmed) {
    return {
      configured: false,
      validUrl: false,
      hostname: null,
      database: null,
      username: null,
      hasPooling: false,
      vercelEnv,
    };
  }

  try {
    const parsed = new URL(trimmed);
    const isPostgres = parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:';
    if (!isPostgres) {
      return {
        configured: true,
        validUrl: false,
        hostname: null,
        database: null,
        username: null,
        hasPooling: false,
        vercelEnv,
      };
    }

    const dbName = parsed.pathname.replace(/^\/+/, '');
    const username = parsed.username ? decodeURIComponent(parsed.username) : null;
    const hasPooling =
      parsed.hostname.includes('-pooler') ||
      parsed.searchParams.has('pgbouncer') ||
      parsed.searchParams.has('pooler');

    return {
      configured: true,
      validUrl: Boolean(parsed.hostname),
      hostname: parsed.hostname || null,
      database: dbName || null,
      username,
      hasPooling,
      vercelEnv,
    };
  } catch {
    return {
      configured: true,
      validUrl: false,
      hostname: null,
      database: null,
      username: null,
      hasPooling: false,
      vercelEnv,
    };
  }
}

export function sanitizeDiagnosticError(err: unknown, rawUrl = process.env.DATABASE_URL): {
  message: string;
  code: string | null;
} {
  let message = err instanceof Error ? err.message : 'Erro desconhecido ao consultar o Neon.';
  const trimmed = rawUrl?.trim();

  if (trimmed) {
    message = message.split(trimmed).join('[REDACTED_URL]');
    try {
      const parsed = new URL(trimmed);
      if (parsed.password) {
        message = message.split(parsed.password).join('[REDACTED]');
        const decodedPassword = decodeURIComponent(parsed.password);
        if (decodedPassword) {
          message = message.split(decodedPassword).join('[REDACTED]');
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

  return { message, code };
}

export async function diagnoseDatabaseConnection(): Promise<DatabaseDiagnosticResult> {
  const checkedAt = new Date().toISOString();
  const env = inspectDatabaseUrlSafely();

  try {
    const sql = getSql();
    const rows = await sql`
      SELECT
        current_database() AS database,
        current_schema() AS schema,
        current_user AS user,
        current_setting('search_path') AS search_path,
        to_regclass('public.player_episodes') AS public_table,
        to_regclass('player_episodes') AS resolved_table,
        inet_server_addr()::text AS server_address,
        inet_server_port() AS server_port
    `;

    const row = (rows as Array<Record<string, unknown>>)[0] ?? {};
    const portVal = row.server_port;
    const serverPort =
      portVal !== null && portVal !== undefined && !Number.isNaN(Number(portVal))
        ? Number(portVal)
        : null;

    return {
      checkedAt,
      env,
      queryOk: true,
      connection: {
        database: row.database !== null && row.database !== undefined ? String(row.database) : null,
        schema: row.schema !== null && row.schema !== undefined ? String(row.schema) : null,
        user: row.user !== null && row.user !== undefined ? String(row.user) : null,
        search_path:
          row.search_path !== null && row.search_path !== undefined ? String(row.search_path) : null,
        public_table:
          row.public_table !== null && row.public_table !== undefined
            ? String(row.public_table)
            : null,
        resolved_table:
          row.resolved_table !== null && row.resolved_table !== undefined
            ? String(row.resolved_table)
            : null,
        server_address:
          row.server_address !== null && row.server_address !== undefined
            ? String(row.server_address)
            : null,
        server_port: serverPort,
      },
      queryError: null,
      queryErrorCode: null,
    };
  } catch (err) {
    const sanitized = sanitizeDiagnosticError(err);
    return {
      checkedAt,
      env,
      queryOk: false,
      connection: null,
      queryError: sanitized.message,
      queryErrorCode: sanitized.code,
    };
  }
}

