import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';

/** 從詞庫抽取合法音節表（L2 合法性檢查用）。 */
export async function cmdSyllables(): Promise<void> {
  const file = path.join(PATHS.processed, 'lexicon.jsonl');
  const set = new Set<string>();
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line) as { readings: string[][] };
    for (const reading of e.readings) {
      for (const syl of reading) set.add(syl);
    }
  }
  await mkdir(PATHS.processed, { recursive: true });
  const out = path.join(PATHS.processed, 'syllables.json');
  const syllables = [...set].sort();
  await writeFile(out, JSON.stringify({ count: syllables.length, syllables }, null, 0), 'utf8');
  console.log(`[done] ${syllables.length} 合法音節 -> ${out}`);
}
