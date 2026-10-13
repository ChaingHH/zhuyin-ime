import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HashTable } from '../src/hashtable.js';
import { LanguageModel } from '../src/model.js';

describe('HashTable', () => {
  it('擴容後計數不遺失', () => {
    const t = new HashTable(2, 4);
    for (let i = 0; i < 5000; i++) t.add(`k${i}`, 0, i);
    t.add('k7', 1, 3);
    t.add('k7', 1, 4);
    expect(t.size).toBe(5000);
    expect(t.get('k4999')).toBe(4999);
    expect(t.get('k7', 1)).toBe(7);
    expect(t.get('missing')).toBe(0);
    expect(t.has('k0')).toBe(true);
  });
});

describe('LanguageModel KN', () => {
  it('與手算一致', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'lm-')), 'lm.tsv');
    writeFileSync(
      file,
      [
        '#meta\t{}',
        'wu\t3\ta',
        'wu\t2\tb',
        'wu\t1\tc',
        'wb\t2\ta b',
        'wb\t1\ta c',
        'wb\t2\tb a',
        'wt\t2\tb a\tb',
      ].join('\n'),
    );
    const lm = await LanguageModel.load(file);
    // 一元 0.9·(1/3) + 0.1·(2.5/6)；二元 (2−.75)/3 + (.75·2/3)·p；三元 1.25/2 + (.75/2)·p
    let p = 0.9 / 3 + (0.1 * 2.5) / 6;
    p = 1.25 / 3 + 0.5 * p;
    p = 1.25 / 2 + 0.375 * p;
    expect(lm.wordLogProb('b', 'b', 'a')).toBeCloseTo(Math.log(p), 10);
    // stupid backoff：三元命中 → c/ctx 總和
    lm.smoothing = 'sb';
    expect(lm.wordLogProb('b', 'b', 'a')).toBeCloseTo(Math.log(1), 10);
    // 三元未命中 → 二元以最近的詞 a 為上下文：0.4·c(a c)/c(a *)；用 b 的話會落到一元
    expect(lm.wordLogProb('c', 'b', 'a')).toBeCloseTo(Math.log((0.4 * 1) / 3), 10);
  });
});
