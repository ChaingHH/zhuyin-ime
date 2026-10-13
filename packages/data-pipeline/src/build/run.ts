import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { loadMoedict } from '../sources/moedict.js';
import {
  ensureLibchewingCsv,
  parseLibchewingCsv,
  type LibchewingFile,
} from '../sources/libchewing.js';
import { libchewingToDrafts, mergeDrafts, moedictToDrafts } from '../build/lexicon.js';

export async function cmdDownload(): Promise<void> {
  await loadMoedict();
  for (const f of ['word.csv', 'tsi.csv'] as const satisfies readonly LibchewingFile[]) {
    await ensureLibchewingCsv(f);
  }
  console.log('[done] 所有詞庫原始檔就緒');
}

export async function cmdLexicon(): Promise<void> {
  console.log('[1/4] 載入萌典…');
  const moedict = await loadMoedict();
  const mo = moedictToDrafts(moedict);
  console.log(`      ${mo.drafts.length} 詞（跳過不可解析讀音 ${mo.skippedReadings}）`);

  console.log('[2/4] 載入 libchewing tsi+word…');
  const rows: ReturnType<typeof parseLibchewingCsv> = [];
  for (const f of ['word.csv', 'tsi.csv'] as const satisfies readonly LibchewingFile[]) {
    const file = await ensureLibchewingCsv(f);
    for (const row of parseLibchewingCsv(await readFile(file, 'utf8'))) {
      rows.push(row);
    }
  }
  const lc = libchewingToDrafts(rows);
  console.log(`      ${lc.drafts.length} 詞（跳過不可解析讀音 ${lc.skippedReadings}）`);

  console.log('[3/4] 合併去重…');
  const { entries, stats } = mergeDrafts([mo.drafts, lc.drafts]);

  console.log('[4/4] 寫出 lexicon.jsonl + stats');
  await mkdir(PATHS.processed, { recursive: true });
  const out = path.join(PATHS.processed, 'lexicon.jsonl');
  const lines = entries.map((e) => JSON.stringify(e));
  await writeFile(out, lines.join('\n') + '\n', 'utf8');

  const statsFile = path.join(PATHS.processed, 'lexicon.stats.json');
  await writeFile(statsFile, JSON.stringify(stats, null, 2), 'utf8');
  console.log(`[done] ${out}`);
  console.table(stats);
}
