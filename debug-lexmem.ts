// 詞典＋解碼器記憶體逐步拆解（不載 LM，用假 Scorer）。
// node --expose-gc --import tsx debug-lexmem.ts
import { readFileSync } from 'node:fs';
import { Decoder, type LexiconEntry } from '@zhuyin/core';

const gc = (globalThis as { gc?: () => void }).gc ?? ((): void => {});
const mb = (b: number): string => `${(b / 2 ** 20).toFixed(0)}MB`;
const snap = (label: string): void => {
  gc();
  gc();
  const m = process.memoryUsage();
  console.log(`${label.padEnd(16)} rss ${mb(m.rss)}  heapUsed ${mb(m.heapUsed)}  heapTotal ${mb(m.heapTotal)}`);
};

snap('node');
let raw: string | null = readFileSync('data/processed/lexicon.jsonl', 'utf8');
snap('讀檔（字串）');
let entries: LexiconEntry[] | null = raw
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as LexiconEntry);
raw = null;
snap('解析成物件');
console.log(`  詞條 ${entries.length}，讀音 ${entries.reduce((s, e) => s + e.readings.length, 0)}`);
const dec = new Decoder({ wordLogProb: () => 0, charSequenceLogProb: () => 0 });
dec.loadLexicon(entries);
snap('建索引');
entries = null;
snap('丟掉詞條陣列');
console.log(dec ? '' : '');
for (const flavor of ['regular', 'last-resort']) {
  (globalThis as { gc?: (o: object) => void }).gc?.({ type: 'major', execution: 'sync', flavor });
  const m = process.memoryUsage();
  console.log(`gc ${flavor.padEnd(12)} rss ${mb(m.rss)}  heapUsed ${mb(m.heapUsed)}  heapTotal ${mb(m.heapTotal)}`);
}
