#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DIST = process.env.DIST_DIR || 'dist';
const MAX = Number(process.env.MAX_FILES || 18000);

async function count(dir) {
  let n = 0;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) n += await count(join(dir, entry.name));
      else n += 1;
    }
  } catch {
    // Se o diretório dist não existir na simulação, retorna 0 com segurança
    return 0;
  }
  return n;
}

try {
  const total = await count(DIST);
  console.log(`Total files to deploy: ${total} (threshold: ${MAX})`);
  if (total > MAX) {
    console.error(`[BUDGET ERROR] Limit exceeded: ${total} files found (Max: ${MAX}). Build aborted.`);
    process.exit(1);
  }
  console.log('STATUS: OK');
} catch (err) {
  console.error(`[BUDGET ERROR] ${err.message}`);
  process.exit(1);
}
