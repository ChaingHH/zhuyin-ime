import { describe, it, expect } from 'vitest';
import { LexiconIndex, type LexiconEntry } from '../src/index.js';

const ENTRIES: LexiconEntry[] = [
  { word: '一', readings: [['ㄧ'], ['ㄧˋ']], freq: 9, provenance: ['moedict'] },
  { word: '衣', readings: [['ㄧ']], freq: 20, provenance: ['moedict'] },
  { word: '一定', readings: [['ㄧˊ', 'ㄉㄧㄥˋ']], freq: 5, provenance: ['moedict'] },
  { word: '依', readings: [['ㄧ']], provenance: ['moedict'] },
];

const list = (lex: LexiconIndex, r: string[], cap = Infinity): string[] => {
  const out: string[] = [];
  lex.each(r, cap, (w) => out.push(w));
  return out;
};

describe('LexiconIndex', () => {
  it('高頻在前、存讀後相同、新增的詞接在後面', () => {
    for (const lex of [
      LexiconIndex.build(ENTRIES, 10),
      // 用 Buffer：readFile 回傳的就是它，它的 slice 不複製
      LexiconIndex.fromBytes(Buffer.from(LexiconIndex.build(ENTRIES, 10).toBytes())),
    ]) {
      expect(list(lex, ['ㄧ'])).toEqual(['衣', '一', '依']);
      expect(list(lex, ['ㄧ'], 2)).toEqual(['衣', '一']);
      expect(list(lex, ['ㄧˊ', 'ㄉㄧㄥˋ'])).toEqual(['一定']);
      expect(list(lex, ['ㄉㄧㄥˋ'])).toEqual([]);
      expect(list(lex, ['ㄅㄚ'])).toEqual([]);
      expect([...lex.polySingle]).toEqual(['一']);
      expect(lex.maxSpan).toBe(2);

      lex.add(['ㄧ'], '醫');
      lex.add(['ㄧ'], '衣');
      lex.add(['ㄅㄚ', 'ㄅㄚ'], '爸爸');
      expect(list(lex, ['ㄧ'])).toEqual(['衣', '一', '依', '醫']);
      expect(list(lex, ['ㄅㄚ', 'ㄅㄚ'])).toEqual(['爸爸']);
      expect(lex.has(['ㄅㄚ', 'ㄅㄚ'], '爸爸')).toBe(true);
      expect(lex.size).toBe(4);
    }
  });

  it('截斷的索引檔丟例外（runtime 才會改從 jsonl 重建）', () => {
    const bytes = LexiconIndex.build(ENTRIES, 10).toBytes();
    // 截掉 4 位元組：仍對齊，typed array 本身不會丟
    expect(() => LexiconIndex.fromBytes(bytes.subarray(0, bytes.length - 4))).toThrow();
    expect(() => LexiconIndex.fromBytes(new Uint8Array(4))).toThrow();
  });
});
