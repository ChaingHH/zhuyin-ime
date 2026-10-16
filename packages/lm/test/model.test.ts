import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HashTable, PerfectTable } from '../src/hashtable.js';
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

  it('凍結量化後查得到原值（小值精確、大值近似）', () => {
    const t = new HashTable(2);
    for (let i = 0; i < 5000; i++) t.add(`k${i}`, 0, i);
    t.add('big', 1, 1e8);
    t.freeze(16);
    expect(t.size).toBe(5001);
    expect(t.get('k4095')).toBe(4095);
    expect(t.get('k4999') / 4999).toBeCloseTo(1, 3);
    expect(t.get('big', 1) / 1e8).toBeCloseTo(1, 3);
    expect(t.get('missing')).toBe(0);
    expect(() => t.add('x', 0, 1)).toThrow();
  });

  it('40-bit 指紋、0.9 載入率凍結後 dump／restore 查得到原值', () => {
    const t = new HashTable(1);
    for (let i = 0; i < 5000; i++) t.add(`k${i}`, 0, i % 200);
    t.freeze(8, 0.9, 40);
    const { bits, size, arrays } = t.dump();
    expect(arrays[1]).toBeInstanceOf(Uint8Array);
    const r = HashTable.restore(1, bits, size, arrays);
    for (const i of [0, 15, 199, 4999]) expect(r.get(`k${i}`)).toBeCloseTo(i % 200, -1);
    expect(r.get('k15')).toBe(15);
    expect(r.get('missing')).toBe(0);
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

    // 剪掉 count<2 的二元（a c）：a 的總量仍是 3，剪掉的 1 併入退回權重
    const pruned = await LanguageModel.load(file, { minBi: 2 });
    const p0 = 0.9 / 3 + (0.1 * 2.5) / 6;
    const pb = 1.25 / 3 + ((0.75 * 1 + 1) / 3) * p0;
    expect(pruned.wordLogProb('b', 'x', 'a')).toBeCloseTo(Math.log(pb), 10);
  });
});

describe('LanguageModel .bin', () => {
  it.each([false, true])(
    '存檔再載入與原模型機率相同（剪枝＋量化，含 BOS 空字串鍵；mph=%s）',
    async (mph) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'lm-'));
      const lines = ['#meta\t{"wordTokens":9,"charTokens":0,"trainedAt":"x","sources":[]}'];
      const words = ['', 'a', 'b', 'c', 'd'];
      for (const w of words) lines.push(`wu\t${w.length + 3}\t${w}`);
      for (const x of words)
        for (const y of words) lines.push(`wb\t${(x.length * 3 + y.length) % 4}\t${x} ${y}`);
      for (const x of words)
        for (const y of words)
          for (const z of words) lines.push(`wt\t${(x + y + z).length}\t${x} ${y}\t${z}`);
      for (let i = 0; i < 300; i++)
        lines.push(`cu\t${i + 1}\t字${i}`, `cb\t${i * 97}\t字${i} 字${i + 1}`);
      writeFileSync(path.join(dir, 'lm.tsv'), lines.join('\n'));
      const opts = { minBi: 2, minTri: 2, quant: 8, mph } as const;
      const a = await LanguageModel.load(path.join(dir, 'lm.tsv'), opts);
      await a.save(path.join(dir, 'lm.bin'));
      const b = await LanguageModel.load(path.join(dir, 'lm.bin'));
      expect(b.meta).toEqual(a.meta);
      expect(b.word.bi.size).toBe(a.word.bi.size);
      for (const w of words)
        for (const x of words)
          for (const y of words) expect(b.wordLogProb(w, x, y)).toBe(a.wordLogProb(w, x, y));
      for (let i = 0; i < 300; i++)
        expect(b.charLogProb(`字${i + 1}`, '', `字${i}`)).toBe(
          a.charLogProb(`字${i + 1}`, '', `字${i}`),
        );
      // 完美雜湊與開放定址表給出相同機率（小資料下 1/65536 誤中不會發生）
      const h = await LanguageModel.load(path.join(dir, 'lm.tsv'), { ...opts, mph: false });
      for (const w of words)
        for (const x of words)
          for (const y of words) expect(b.wordLogProb(w, x, y)).toBe(h.wordLogProb(w, x, y));
    },
  );
});

describe('分段雜湊', () => {
  it('get2／get3 與組好字串的 get 結果相同（兩種表、含空字串）', () => {
    const t = new HashTable(1);
    const words = ['', 'a', '我們', '𠀀字', 'b c'];
    for (const x of words)
      for (const y of words) {
        t.add(`${x} ${y}`, 0, x.length + 1);
        for (const z of words) t.add(`${x} ${y}\t${z}`, 0, z.length + 2);
      }
    const p = t.toPerfect(8);
    for (const tb of [t, p])
      for (const x of words)
        for (const y of words) {
          expect(tb.get2(x, y)).toBe(tb.get(`${x} ${y}`));
          for (const z of words) expect(tb.get3(x, y, z)).toBe(tb.get(`${x} ${y}\t${z}`));
        }
  });
});

describe('PerfectTable', () => {
  it('每個鍵拿到自己的值、查不到回 0、dump／restore 一致', () => {
    const t = new HashTable(2);
    for (let i = 0; i < 20000; i++) {
      t.add(`k${i}`, 0, i % 300);
      t.add(`k${i}`, 1, 7);
    }
    const p = t.toPerfect(8);
    expect(p.size).toBe(20000);
    for (let i = 0; i < 20000; i += 37)
      expect(Math.abs(p.get(`k${i}`) - (i % 300))).toBeLessThanOrEqual((i % 300) * 0.05);
    expect(p.get('k15')).toBe(15);
    expect(p.get('k15', 1)).toBe(7);
    let hits = 0;
    for (let i = 0; i < 20000; i++) if (p.get(`missing${i}`)) hits++;
    expect(hits).toBeLessThan(5);
    const d = p.dump();
    const r = PerfectTable.restore(2, d.bits, d.seed, d.size, d.arrays);
    for (let i = 0; i < 20000; i += 101) expect(r.get(`k${i}`)).toBe(p.get(`k${i}`));
  });
});
