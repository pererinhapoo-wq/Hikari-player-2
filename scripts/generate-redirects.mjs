#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const LEGACY = 'data/legacy-slugs.json'; // [{ from: "/anime/213457", to: "/anime/anilist-213457" }]
const OUT = 'public/_redirects';
const MAX_RULES = 1900;
const NEW_DOMAIN = process.env.NEW_DOMAIN || 'hikaritv.com';

const rules = [
  // domínios legados primeiro (mais específico antes)
  `https://hikaritv.cc.cd/* https://${NEW_DOMAIN}/:splat 301`,
  `https://hikariplayer.cc.cd/* https://${NEW_DOMAIN}/:splat 301`,
  // episódios antigos -> player por hash
  '/watch/:id/ep-:n /e/:id#ep-:n 301',
  '/watch/:id /e/:id 301',
];

let legacy = [];
try {
  legacy = JSON.parse(await readFile(LEGACY, 'utf8'));
} catch {
  console.warn(`[redirects] ${LEGACY} ausente, seguindo sem slugs legados`);
}

for (const r of legacy) rules.push(`${r.from} ${r.to} 301`);

if (rules.length > MAX_RULES) {
  console.error(`[redirects] ${rules.length} regras, acima do teto de ${MAX_RULES}. Migre para Worker.`);
  process.exit(1);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, rules.join('\n') + '\n');
console.log(`[redirects] ${rules.length} regras escritas em ${OUT}`);
