/**
 * 中英夾雜評測集 eval/mixed.jsonl：取自 build-big-corpus.ts（CORPUS_EN=1）留下的 mixed-heldout.txt
 * （這些片段沒進訓練）。中文串用評測集同一套貪婪分詞給讀音；一段英文（可含空白）是一個原樣 token，
 * 解碼器原樣輸出、LM 當 EN_CLASS 看。text 拿掉中英之間的空白（使用者切英文前不會打空白）。
 * 用法：npx tsx packages/data-pipeline/scripts/build-mixed-eval.ts <mixed-heldout.txt> [N=1000]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LexiconEntry } from '@zhuyin/core';
import { segment } from '../src/build/evalset.js';
import { PATHS } from '../src/config.js';

const [src, nArg = '1000'] = process.argv.slice(2);
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
const lines = [...new Set((await readFile(src, 'utf8')).split('\n').filter(Boolean))];
for (let i = lines.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [lines[i], lines[j]] = [lines[j]!, lines[i]!];
}

const out: string[] = [];
for (const line of lines) {
  if (out.length >= N) break;
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
  if (ok && han >= 4 && syllables.length > han) out.push(JSON.stringify({ text, syllables }));
}
const meta = JSON.stringify({ seed: 20261017, n: out.length, source: path.basename(src) });
const file = path.join(PATHS.eval, 'mixed.jsonl');
await writeFile(file, `${meta}\n${out.join('\n')}\n`, 'utf8');
console.log(`[eval:mixed] ${out.length} 句 → ${file}`);
