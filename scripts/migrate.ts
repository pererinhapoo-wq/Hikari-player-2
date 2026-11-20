import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config();

export const EXPECTED_PROXY_COLUMNS = [
  'force_proxy',
  'force_proxy_2',
  'force_proxy_3',
  'force_proxy_4',
  'force_proxy_5',
] as const;

function matchDollarQuoteTag(sql: string, startIndex: number): string | null {
  if (sql[startIndex] !== '$') return null;
  let i = startIndex + 1;
  if (i < sql.length && sql[i] === '$') {
    return '$$';
  }
  if (i >= sql.length || !/[A-Za-z_]/.test(sql[i])) {
    return null;
  }
  i++;
  while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) {
    i++;
  }
  if (i < sql.length && sql[i] === '$') {
    return sql.slice(startIndex, i + 1);
  }
  return null;
}

export function splitSqlStatements(sqlContent: string): string[] {
  const statements: string[] = [];
  let buffer = '';
  let hasMeaningfulToken = false;
  let parenDepth = 0;
  let i = 0;

  while (i < sqlContent.length) {
    const ch = sqlContent[i];
    const next = sqlContent[i + 1] ?? '';

    // 1. Single-line comment: -- until newline (consume comment without breaking token separation)
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < sqlContent.length && sqlContent[i] !== '\n') {
        i++;
      }
      if (buffer.length > 0 && !/\s$/.test(buffer)) {
        buffer += '\n';
      }
      continue;
    }

    // 2. Block comment (supports PostgreSQL nested /* ... /* ... */ ... */)
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sqlContent.length && depth > 0) {
        if (sqlContent[i] === '/' && sqlContent[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sqlContent[i] === '*' && sqlContent[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth !== 0) {
        throw new Error('Instrução SQL incompleta: comentário de bloco /* ... */ não fechado.');
      }
      if (buffer.length > 0 && !/\s$/.test(buffer)) {
        buffer += ' ';
      }
      continue;
    }

    // 3. Escape string literal E'...' / e'...'
    if ((ch === 'E' || ch === 'e') && next === "'") {
      const prevChar = i > 0 ? sqlContent[i - 1] : '';
      const isIdentifierPart = /[A-Za-z0-9_$]/.test(prevChar);
      if (!isIdentifierPart) {
        hasMeaningfulToken = true;
        buffer += ch + next;
        i += 2;
        let closed = false;
        while (i < sqlContent.length) {
          const c = sqlContent[i];
          buffer += c;
          if (c === '\\') {
            if (i + 1 < sqlContent.length) {
              buffer += sqlContent[i + 1];
              i += 2;
              continue;
            }
            i++;
            break;
          }
          if (c === "'") {
            if (sqlContent[i + 1] === "'") {
              buffer += "'";
              i += 2;
              continue;
            }
            closed = true;
            i++;
            break;
          }
          i++;
        }
        if (!closed) {
          throw new Error('Instrução SQL incompleta: string literal E\'...\' não fechada.');
        }
        continue;
      }
    }

    // 4. Standard single-quoted string literal '...'
    if (ch === "'") {
      hasMeaningfulToken = true;
      buffer += ch;
      i++;
      let closed = false;
      while (i < sqlContent.length) {
        const c = sqlContent[i];
        buffer += c;
        if (c === "'") {
          if (sqlContent[i + 1] === "'") {
            buffer += "'";
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) {
        throw new Error('Instrução SQL incompleta: string literal \'...\' não fechada.');
      }
      continue;
    }

    // 5. Double-quoted identifier "..."
    if (ch === '"') {
      hasMeaningfulToken = true;
      buffer += ch;
      i++;
      let closed = false;
      while (i < sqlContent.length) {
        const c = sqlContent[i];
        buffer += c;
        if (c === '"') {
          if (sqlContent[i + 1] === '"') {
            buffer += '"';
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) {
        throw new Error('Instrução SQL incompleta: identificador "..." não fechado.');
      }
      continue;
    }

    // 6. PostgreSQL dollar-quoted string $tag$...$tag$
    const dollarTag = matchDollarQuoteTag(sqlContent, i);
    if (dollarTag) {
      hasMeaningfulToken = true;
      const closeIndex = sqlContent.indexOf(dollarTag, i + dollarTag.length);
      if (closeIndex === -1) {
        throw new Error(`Instrução SQL incompleta: bloco ${dollarTag}...${dollarTag} não fechado.`);
      }
      const endIndex = closeIndex + dollarTag.length;
      buffer += sqlContent.slice(i, endIndex);
      i = endIndex;
      continue;
    }

    // 7. Parentheses balance tracking
    if (ch === '(') {
      parenDepth++;
      hasMeaningfulToken = true;
      buffer += ch;
      i++;
      continue;
    }
    if (ch === ')') {
      parenDepth--;
      if (parenDepth < 0) {
        throw new Error('Instrução SQL inválida: parêntese de fechamento inesperado.');
      }
      hasMeaningfulToken = true;
      buffer += ch;
      i++;
      continue;
    }

    // 8. Statement terminator ;
    if (ch === ';') {
      if (parenDepth !== 0) {
        throw new Error('Instrução SQL incompleta: parênteses não balanceados antes de ";".');
      }
      const trimmed = buffer.trim();
      if (hasMeaningfulToken && trimmed.length > 0) {
        statements.push(trimmed);
      }
      buffer = '';
      hasMeaningfulToken = false;
      i++;
      continue;
    }

    // 9. Normal code / whitespace
    if (!/\s/.test(ch)) {
      hasMeaningfulToken = true;
    }
    if (hasMeaningfulToken) {
      buffer += ch;
    }
    i++;
  }

  if (parenDepth !== 0) {
    throw new Error('Instrução SQL incompleta: parênteses não fechados ao final do arquivo.');
  }

  const trailing = buffer.trim();
  if (hasMeaningfulToken && trailing.length > 0) {
    statements.push(trailing);
  }

  return statements;
}

export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.warn('DATABASE_URL não definida no ambiente. Migrações ignoradas no build.');
    return;
  }

  const sql = neon(databaseUrl);
  const migrationsDir = path.resolve(process.cwd(), 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.log('Pasta de migrações não encontrada.');
    return;
  }

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  console.log(`[MIGRATION RUNNER] Aplicando ${files.length} arquivo(s) de migração no Neon...`);

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    console.log(`[MIGRATION RUNNER] Executando: ${file}`);
    try {
      const statements = splitSqlStatements(content);

      for (const stmt of statements) {
        await sql.query(stmt);
      }
      console.log(`[MIGRATION RUNNER] ${file} aplicada com sucesso.`);
    } catch (err: any) {
      console.error(`[MIGRATION RUNNER] Erro ao aplicar migration ${file}:`, err?.message || err);
      throw err;
    }
  }

  // Verificação pós-migração contra information_schema
  try {
    const colRows = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'player_episodes'
    `;
    const cols = Array.isArray(colRows) ? colRows.map((r: any) => String(r.column_name)) : [];
    const presentCount = EXPECTED_PROXY_COLUMNS.filter((c) => cols.includes(c)).length;
    const missing = EXPECTED_PROXY_COLUMNS.filter((c) => !cols.includes(c));

    if (missing.length === 0) {
      console.log(`[MIGRATION RUNNER OK] 5/5 colunas force_proxy verificadas e ativas no banco Neon.`);
    } else {
      const fixSql = missing
        .map((c) => `ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS ${c} boolean DEFAULT true;`)
        .join('\n');
      console.warn(
        `[MIGRATION RUNNER WARNING] Atenção: ${presentCount}/5 colunas force_proxy presentes. Faltam: ${missing.join(', ')}\n` +
        `SQL de correção:\n${fixSql}`
      );
    }
  } catch (err: any) {
    console.warn('[MIGRATION RUNNER] Aviso ao verificar colunas no schema:', err?.message || err);
  }
}

// Execução direta via CLI (npm run db:migrate ou npm run build)
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log('[MIGRATION RUNNER] Processo de migração finalizado com sucesso.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[MIGRATION RUNNER] Falha crítica nas migrações:', err);
      // Se em ambiente onde DATABASE_URL é inválida ou inacessível durante build estático, loga e encerra
      process.exit(1);
    });
}
