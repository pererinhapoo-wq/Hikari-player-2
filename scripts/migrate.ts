import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config();

export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.warn('DATABASE_URL não definida. Migrações ignoradas.');
    return;
  }

  const sql = neon(databaseUrl);
  const migrationsDir = path.resolve(process.cwd(), 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.log('Pasta de migrações não encontrada.');
    return;
  }

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  console.log(`Aplicando ${files.length} migrações do Neon...`);

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    console.log(`Executando migration: ${file}`);
    try {
      // Split by statement or execute raw content via sql
      const statements = content
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('--'));

      for (const stmt of statements) {
        await sql`${sql.unsafe(stmt)}`;
      }
      console.log(`Migration ${file} aplicada com sucesso.`);
    } catch (err) {
      console.error(`Erro ao aplicar migration ${file}:`, err);
      throw err;
    }
  }
}

// Se executado diretamente via CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log('Migrações concluídas.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Falha nas migrações:', err);
      process.exit(1);
    });
}
