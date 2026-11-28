#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.warn('[slug-map] DATABASE_URL não configurada. Gerando slug-map vazio.');
  await mkdir('public/data', { recursive: true });
  await writeFile('public/data/slug-map.json', JSON.stringify({}));
  process.exit(0);
}

const sql = neon(DATABASE_URL);
await mkdir('public/data', { recursive: true });

try {
  const rows = await sql`SELECT legacy_slug AS from_slug, slug AS to_slug FROM anime WHERE legacy_slug IS NOT NULL`;
  const map = Object.fromEntries(rows.map((r) => [r.from_slug, r.to_slug]));
  await writeFile('public/data/slug-map.json', JSON.stringify(map));
  console.log(`[slug-map] ${rows.length} pares gravados em public/data/slug-map.json`);
} catch (err) {
  console.warn(`[slug-map] Aviso ao consultar slugs legados: ${err.message}. Gerando mapa vazio.`);
  await writeFile('public/data/slug-map.json', JSON.stringify({}));
}
