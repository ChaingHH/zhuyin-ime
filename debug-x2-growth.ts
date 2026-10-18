// X2 長期使用模擬：從語料取不同的句子（不是評測句重打），產生重播事件給 zhuyin-native replay
// （或 debug-native-parity.ts replay）。每句打完送出；約 5% 的句子先開選字視窗選第 2 個候選
// （會存成使用者詞）；時鐘每句前進一天的 1/每日句數；每 checkpoint 句放一個 `s` 事件（量檔案大小與延遲）。
// ZHUYIN_DATA=<data> npx tsx debug-x2-growth.ts <out> [句數=30000] [每日句數=200] [checkpoint=2000]
import { readFileSync, writeFileSync } from 'node:fs';
import { syllableToKeyCodes, type LexiconEntry } from '@zhuyin/core';
import { segment } from './packages/data-pipeline/src/build/evalset.js';
import { rng } from './packages/cli/src/noise.js';

const DATA = process.env['ZHUYIN_DATA'] ?? 'data';
const [out, nArg, perDayArg, cpArg] = process.argv.slice(2);
const n = Number(nArg ?? 30000);
const perDay = Number(perDayArg ?? 200);
const checkpoint = Number(cpArg ?? 2000);
const T0 = 1792200000000;

const lex = new Map<string, LexiconEntry>();
for (const l of readFileSync(`${DATA}/processed/lexicon.jsonl`, 'utf8').split('\n'))
  if (l) {
    const e = JSON.parse(l) as LexiconEntry;
    lex.set(e.word, e);
  }
const evalText = new Set(
  ['colloquial', 'written'].flatMap((f) =>
    readFileSync(`eval/${f}.jsonl`, 'utf8')
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { text: string }).text),
  ),
);
// 兩份語料交錯取「連續中文字片段」（4–20 字）
const corpora = ['colloquial', 'written'].map((f) =>
  readFileSync(`${DATA}/processed/corpus/${f}.txt`, 'utf8').split('\n'),
);
const r = rng(7);
const ev: string[] = [];
let done = 0;
for (let i = 0; done < n; i++) {
  const line = corpora[i % 2]![Math.floor(i / 2)];
  if (line === undefined) break;
  for (const clause of line.split(/[^一-鿿]+/)) {
    if (done >= n) break;
    if ([...clause].length < 4 || [...clause].length > 20 || evalText.has(clause)) continue;
    const seg = segment(clause, lex, 6, 1);
    if (!seg) continue;
    ev.push(`t\t${Math.round(T0 + (done * 86_400_000) / perDay)}`);
    for (const syl of seg.syllables) for (const c of syllableToKeyCodes(syl)) ev.push(`k\t${c}\t`);
    if (r() < 0.05) {
      // 選字：游標往回 0–2 個字、開視窗、選第 2 個
      for (let k = Math.floor(r() * 3); k > 0; k--) ev.push('k\tArrowLeft\t');
      ev.push('k\tArrowDown\t', 'k\tDigit2\t', 'k\tEnd\t');
    }
    ev.push('c\t0');
    done++;
    if (done % checkpoint === 0) ev.push('s');
  }
}
writeFileSync(out!, ev.join('\n'));
console.log(`${done} 句、${ev.length} 個事件 -> ${out}`);
