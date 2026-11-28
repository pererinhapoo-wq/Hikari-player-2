#!/usr/bin/env node
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.warn('[export] DATABASE_URL não configurada. Gerando estrutura de dados vazia/mock para build estático.');
  const OUT = 'public/data';
  await rm(OUT, { recursive: true, force: true });
  await mkdir(`${OUT}/episodes`, { recursive: true });
  await mkdir(`${OUT}/search`, { recursive: true });
  await writeFile(`${OUT}/animes.json`, JSON.stringify([]));
  await writeFile(`${OUT}/search/a.json`, JSON.stringify([]));
  console.log('[export] Exportação estática concluída (modo sem DB).');
  process.exit(0);
}

const sql = neon(DATABASE_URL);
const OUT = 'public/data';
const SHARDS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('').concat('_');

await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/episodes`, { recursive: true });
await mkdir(`${OUT}/search`, { recursive: true });

const animes = await sql`
  SELECT id, slug, title, title_romaji, cover_url, year, genres
  FROM anime ORDER BY id
`;

const shard = (t) => {
  const c = (t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')[0]?.toLowerCase();
  return c && SHARDS.includes(c) ? c : '_';
};

const index = new Map(SHARDS.map((s) => [s, []]));

for (const a of animes) {
  index.get(shard(a.title)).push({
    id: a.id, s: a.slug, t: a.title, r: a.title_romaji, c: a.cover_url, y: a.year, g: a.genres,
  });

  const eps = await sql`SELECT n FROM episode WHERE anime_id = ${a.id} ORDER BY n`;
  await writeFile(`${OUT}/episodes/${a.id}.json`, JSON.stringify(eps.map((e) => ({ n: e.n }))));
}

await writeFile(`${OUT}/animes.json`, JSON.stringify(animes));
for (const [s, rows] of index) await writeFile(`${OUT}/search/${s}.json`, JSON.stringify(rows));

console.log(`[export] ${animes.length} animes exportados para ${OUT}`);
