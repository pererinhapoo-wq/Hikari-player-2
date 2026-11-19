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
      const statements = content
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('--'));

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
        .map((c) => `ALTER TABLE player_episodes ADD COLUMN IF NOT EXISTS ${c} boolean DEFAULT NULL;`)
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
