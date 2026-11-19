import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import type {
  DatabaseDiagnosisCode,
  DatabaseDiagnosticResult,
  DatabaseEnvDiagnostic,
  DatabaseQueryDiagnostic,
  SanitizedDbError,
} from '@/lib/types';
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
  force_proxy: boolean | null;
  force_proxy_2: boolean | null;
  force_proxy_3: boolean | null;
  force_proxy_4: boolean | null;
  force_proxy_5: boolean | null;
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

  return {
    title,
    poster_url: posterCheck.normalizedUrl,
    video_url: primaryCheck.normalizedUrl,
    video_url_2: sanitizedOptional.video_url_2,
    video_url_3: sanitizedOptional.video_url_3,
    video_url_4: sanitizedOptional.video_url_4,
    video_url_5: sanitizedOptional.video_url_5,
    force_proxy: input.force_proxy ? true : null,
    force_proxy_2: input.force_proxy_2 ? true : null,
    force_proxy_3: input.force_proxy_3 ? true : null,
    force_proxy_4: input.force_proxy_4 ? true : null,
    force_proxy_5: input.force_proxy_5 ? true : null,
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
    force_proxy: row.force_proxy === true ? true : null,
    force_proxy_2: row.force_proxy_2 === true ? true : null,
    force_proxy_3: row.force_proxy_3 === true ? true : null,
    force_proxy_4: row.force_proxy_4 === true ? true : null,
    force_proxy_5: row.force_proxy_5 === true ? true : null,
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
  };
}

export async function listEpisodes(): Promise<PlayerEpisode[]> {
  const sql = getSql();
  try {
    const rows = await sql`
      SELECT id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
             COALESCE(force_proxy, false) AS force_proxy,
             COALESCE(force_proxy_2, false) AS force_proxy_2,
             COALESCE(force_proxy_3, false) AS force_proxy_3,
             COALESCE(force_proxy_4, false) AS force_proxy_4,
             COALESCE(force_proxy_5, false) AS force_proxy_5,
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
          force_proxy: data.force_proxy === true ? true : null,
          force_proxy_2: data.force_proxy_2 === true ? true : null,
          force_proxy_3: data.force_proxy_3 === true ? true : null,
          force_proxy_4: data.force_proxy_4 === true ? true : null,
          force_proxy_5: data.force_proxy_5 === true ? true : null,
        });
      });
    }
    throw err;
  }
}

export async function getEpisodeById(id: string): Promise<PlayerEpisode | null> {
  const cleanId = id.trim();
  if (!cleanId || cleanId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cleanId)) {
    return null;
  }

  const sql = getSql();
  try {
    const rows = await sql`
      SELECT id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
             COALESCE(force_proxy, false) AS force_proxy,
             COALESCE(force_proxy_2, false) AS force_proxy_2,
             COALESCE(force_proxy_3, false) AS force_proxy_3,
             COALESCE(force_proxy_4, false) AS force_proxy_4,
             COALESCE(force_proxy_5, false) AS force_proxy_5,
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
        force_proxy: data.force_proxy === true ? true : null,
        force_proxy_2: data.force_proxy_2 === true ? true : null,
        force_proxy_3: data.force_proxy_3 === true ? true : null,
        force_proxy_4: data.force_proxy_4 === true ? true : null,
        force_proxy_5: data.force_proxy_5 === true ? true : null,
      });
    }
    throw err;
  }
}

export async function createEpisode(rawInput: EpisodeWriteInput): Promise<PlayerEpisode> {
  const input = sanitizeEpisodeInput(rawInput);
  const id = generateEpisodeId();
  const sql = getSql();

  try {
    const rows = await sql`
      INSERT INTO public.player_episodes (
        id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
        force_proxy, force_proxy_2, force_proxy_3, force_proxy_4, force_proxy_5
      ) VALUES (
        ${id},
        ${input.title},
        ${input.poster_url},
        ${input.video_url},
        ${input.video_url_2 ?? null},
        ${input.video_url_3 ?? null},
        ${input.video_url_4 ?? null},
        ${input.video_url_5 ?? null},
        ${input.force_proxy ?? null},
        ${input.force_proxy_2 ?? null},
        ${input.force_proxy_3 ?? null},
        ${input.force_proxy_4 ?? null},
        ${input.force_proxy_5 ?? null}
      )
      RETURNING id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                COALESCE(force_proxy, false) AS force_proxy,
                COALESCE(force_proxy_2, false) AS force_proxy_2,
                COALESCE(force_proxy_3, false) AS force_proxy_3,
                COALESCE(force_proxy_4, false) AS force_proxy_4,
                COALESCE(force_proxy_5, false) AS force_proxy_5,
                created_at, updated_at
    `;
    return mapEpisodeRow((rows as Array<Record<string, unknown>>)[0]);
  } catch (err: any) {
    if (err?.code === '42703' || String(err?.message).includes('column')) {
      const rows = await sql`
        INSERT INTO public.player_episodes (
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
        RETURNING id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                  created_at, updated_at
      `;
      return mapEpisodeRow((rows as Array<Record<string, unknown>>)[0]);
    }
    throw err;
  }
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

  try {
    const rows = await sql`
      UPDATE public.player_episodes
      SET
        title = ${input.title},
        poster_url = ${input.poster_url},
        video_url = ${input.video_url},
        video_url_2 = ${input.video_url_2 ?? null},
        video_url_3 = ${input.video_url_3 ?? null},
        video_url_4 = ${input.video_url_4 ?? null},
        video_url_5 = ${input.video_url_5 ?? null},
        force_proxy = ${input.force_proxy ?? null},
        force_proxy_2 = ${input.force_proxy_2 ?? null},
        force_proxy_3 = ${input.force_proxy_3 ?? null},
        force_proxy_4 = ${input.force_proxy_4 ?? null},
        force_proxy_5 = ${input.force_proxy_5 ?? null},
        updated_at = NOW()
      WHERE id = ${cleanId}
      RETURNING id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                COALESCE(force_proxy, false) AS force_proxy,
                COALESCE(force_proxy_2, false) AS force_proxy_2,
                COALESCE(force_proxy_3, false) AS force_proxy_3,
                COALESCE(force_proxy_4, false) AS force_proxy_4,
                COALESCE(force_proxy_5, false) AS force_proxy_5,
                created_at, updated_at
    `;
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? mapEpisodeRow(row) : null;
  } catch (err: any) {
    if (err?.code === '42703' || String(err?.message).includes('column')) {
      const rows = await sql`
        UPDATE public.player_episodes
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
        RETURNING id, title, poster_url, video_url, video_url_2, video_url_3, video_url_4, video_url_5,
                  created_at, updated_at
      `;
      const row = (rows as Array<Record<string, unknown>>)[0];
      return row ? mapEpisodeRow(row) : null;
    }
    throw err;
  }
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
    ? missingColumns.map((c) => `ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS ${c} ${c.startsWith('force_proxy') ? 'boolean DEFAULT NULL' : 'TEXT'};`).join('\n')
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
          .map((c) => `ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS ${c} boolean DEFAULT NULL;`)
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

