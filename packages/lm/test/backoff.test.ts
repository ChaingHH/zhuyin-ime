import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LanguageModel } from '../src/model.js';
import { BackoffLM, buildBackoff, scoreNgrams } from '../src/backoff.js';
import { floatBits, logCodebook } from '../src/hashtable.js';

const TSV = [
  '#meta\t{}',
  'wu\t5\ta',
  'wu\t3\tb',
  'wu\t2\tc',
  'wu\t1\td',
  'wb\t2\ta b',
  'wb\t1\ta c',
  'wb\t2\tb a',
  'wb\t1\tc a',
  'wb\t1\ta d',
  // 句尾符只當過後接詞（不在一元計數裡，也不當上下文）
  'wb\t2\td \u0003',
  'wb\t1\tc \u0003',
  'wt\t2\tb a\tb',
  'wt\t1\ta b\ta',
  'wt\t1\tb a\tc',
  'cu\t4\tx',
  'cu\t2\ty',
  'cb\t2\tx y',
  'cb\t1\ty x',
  'ct\t1\tx y\tx',
].join('\n');

const WORDS = ['a', 'b', 'c', 'd', 'zz', ''];
const CTX = ['', 'a', 'b', 'c', 'd', 'zz'];

async function fixture(): Promise<{ tsv: string; full: LanguageModel; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bo-'));
  const tsv = path.join(dir, 'lm.tsv');
  writeFileSync(tsv, TSV);
  return { tsv, full: await LanguageModel.load(tsv, { minBi: 1, minTri: 1 }), dir };
}

describe('logCodebook', () => {
  it('機率欄接近 0 的值不會量化成 0（0 代表沒存）；有 0 的欄保留精確的 0', () => {
    const col = (vals: number[]) => Uint32Array.from(vals, floatBits);
    const prob = logCodebook(col([-20, -0.003, -0.0001, -5]), 8);
    for (const v of [-0.003, -0.0001]) expect(prob.lut[prob.encode(floatBits(v))]).toBeLessThan(0);
    const alpha = logCodebook(col([0, -3, -0.02]), 8);
    expect(alpha.lut[alpha.encode(floatBits(0))]).toBe(0);
  });
});

describe('BackoffLM', () => {
  it('不剪枝（θ=0）時與 KN 計數模型相同，存讀檔後也相同', async () => {
    const { tsv, full, dir } = await fixture();
    const scores = await scoreNgrams(full, tsv);
    const bo = await buildBackoff(full, tsv, scores, { theta: 0, bits: 16 });
    const file = path.join(dir, 'lm.bo.bin');
    await bo.save(file);
    const re = await BackoffLM.load(file);
    for (const m of [bo, re])
      for (const w of WORDS)
        for (const c1 of CTX)
          for (const c2 of CTX) {
            // 只差 16 位元均勻量化（每格約 1e-4）
            expect(m.wordLogProb(w, c1, c2)).toBeCloseTo(full.wordLogProb(w, c1, c2), 3);
          }
    expect(re.charSequenceLogProb('xyx', ['', ''])).toBeCloseTo(
      full.charSequenceLogProb('xyx', ['', '']),
      3,
    );
  });

  it('剪枝後每個上下文的機率總和仍為 1', async () => {
    const { tsv, full } = await fixture();
    const scores = await scoreNgrams(full, tsv);
    const bo = await buildBackoff(full, tsv, scores, { theta: 0.05, bits: 16 });
    expect(bo.sizes[1]! + bo.sizes[2]!).toBeLessThan(8);
    // 詞彙內的詞總和 = 1 − 詞彙外的質量（未剪枝模型同一上下文的總和當基準）
    for (const [c1, c2] of [
      ['b', 'a'],
      ['', 'a'],
      ['zz', 'b'],
    ] as const) {
      const sum = (m: { wordLogProb: (w: string, a: string, b: string) => number }) =>
        ['a', 'b', 'c', 'd'].reduce((s, w) => s + Math.exp(m.wordLogProb(w, c1, c2)), 0);
      expect(sum(bo)).toBeCloseTo(sum(full), 2);
    }
  });
});
