import { createReadStream } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanSentence, splitSentences } from '../src/build/clean.js';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(thisDir, '..', '..', '..');
const DUMP = path.join(REPO, 'data', 'raw', 'wiki', 'wiki_dump.jsonl');
const OUT = path.join(REPO, 'data', 'processed', 'corpus', 'written.txt');

const TARGET_NEW = Number.parseInt(process.argv[2] ?? '400000', 10);

const existing = new Set(
  (await readFile(OUT, 'utf8')).split('\n').filter(Boolean),
);
console.log(`[existing] ${existing.size} 句`);

const rl = createInterface({ input: createReadStream(DUMP, 'utf8') });
let added = 0;
let scanned = 0;
const batch: string[] = [];

for await (const line of rl) {
  scanned++;
  let text = '';
  try {
    text = (JSON.parse(line) as { text?: string }).text ?? '';
  } catch {
    continue;
  }
  for (const s of splitSentences(text)) {
    const clean = cleanSentence(s);
    if (clean && !existing.has(clean)) {
      existing.add(clean);
      batch.push(clean);
      added++;
    }
  }
  if (added >= TARGET_NEW) break;
}
rl.close();

await appendFile(OUT, batch.join('\n') + '\n', 'utf8');
console.log(`[done] 掃描 ${scanned} 篇，新增 ${added} 句 -> ${OUT}`);
