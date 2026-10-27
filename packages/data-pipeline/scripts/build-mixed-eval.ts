/**
 * 中英夾雜評測集 eval/mixed.jsonl：取自 build-big-corpus.ts（CORPUS_EN=1）留下的 mixed-heldout.txt
 * （這些片段沒進訓練）。中文串用評測集同一套貪婪分詞給讀音；一段英文（可含空白）是一個原樣 token，
 * 解碼器原樣輸出、LM 當 EN_CLASS 看。text 拿掉中英之間的空白（使用者切英文前不會打空白）。
 * 用法：npx tsx packages/data-pipeline/scripts/build-mixed-eval.ts <mixed-heldout.txt> [N=1000] [out=mixed.jsonl]
 * 科技評測集：build-mixed-eval.ts eval/tech.txt 1000 tech.jsonl（不要求含英文、不洗牌）
 * X2 評測（x2-new、x2-habit）：一行 split、詞、句以 tab 分隔，split 與 word 原樣帶進 JSON；# 開頭是註解
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LexiconEntry } from '@zhuyin/core';
import { segment } from '../src/build/evalset.js';
import { PATHS } from '../src/config.js';

const [src, nArg = '1000', outName = 'mixed.jsonl'] = process.argv.slice(2);
const mixed = outName === 'mixed.jsonl';
if (!src) throw new Error('用法: build-mixed-eval.ts <mixed-heldout.txt> [N]');
const N = Number(nArg);

const lexicon = new Map<string, LexiconEntry>();
for (const line of (await readFile(path.join(PATHS.processed, 'lexicon.jsonl'), 'utf8')).split(
  '\n',
)) {
  if (!line) continue;
  const e = JSON.parse(line) as LexiconEntry;
  // 評測讀音只用原詞典（不含挖出來的詞），和 colloquial/written 一致
  if (!e.provenance.every((p) => p === 'mined')) lexicon.set(e.word, e);
}

// 和 evalset.ts 同一個 LCG 洗牌，可重現
let s = 20261017;
const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
const lines = [
  ...new Set((await readFile(src, 'utf8')).split('\n').filter((l) => l && !l.startsWith('#'))),
];
for (let i = mixed ? lines.length - 1 : 0; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [lines[i], lines[j]] = [lines[j]!, lines[i]!];
}

const out: string[] = [];
for (const raw of lines) {
  if (out.length >= N) break;
  const [split, word, line] = raw.includes('\t') ? raw.split('\t') : [undefined, undefined, raw];
  const parts = line.match(/[㐀-鿿]+|[A-Za-z0-9]+(?: +[A-Za-z0-9]+)*/g) ?? [];
  let text = '';
  const syllables: string[] = [];
  let han = 0;
  let ok = true;
  for (const p of parts) {
    text += p;
    if (/[A-Za-z0-9]/.test(p)) {
      syllables.push(p);
      continue;
    }
    const seg = segment(p, lexicon, 6, 1);
    if (!seg) {
      ok = false;
      break;
    }
    han += p.length;
    syllables.push(...seg.syllables);
  }
  if (ok && han >= 4 && (!mixed || syllables.length > han))
    out.push(JSON.stringify({ text, syllables, split, word }));
}
const meta = JSON.stringify({ seed: 20261017, n: out.length, source: path.basename(src) });
const file = path.join(PATHS.eval, outName);
await writeFile(file, `${meta}\n${out.join('\n')}\n`, 'utf8');
console.log(`[eval:${outName}] ${out.length} 句 → ${file}`);
