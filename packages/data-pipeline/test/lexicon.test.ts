import { describe, it, expect } from 'vitest';
import { libchewingToDrafts, mergeDrafts } from '../src/build/lexicon.js';
import { parseLibchewingCsv } from '../src/sources/libchewing.js';
import type { LexiconDraft } from '../src/types.js';

const CSV_FIXTURE = `# dc:title,內建詞庫,
# dc:rights,Copyright (c) 2025 libchewing Core Team,
# dc:license,LGPL-2.1-or-later,
ˇ,1,ˇ
ㄅ,0,ㄅ
今天,25469,ㄐㄧㄣ ㄊㄧㄢ
什麼,20445,ㄕㄜˊ ㄇㄛˊ
什麼,20445,ㄕㄣˊ ㄇㄜ˙
`;

describe('libchewing 解析', () => {
  const rows = parseLibchewingCsv(CSV_FIXTURE);

  it('跳過授權頭與符號列', () => {
    expect(rows.map((r) => r.word)).toEqual(['今天', '什麼', '什麼']);
  });

  it('同詞多讀音合併、頻率取最大', () => {
    const { drafts } = libchewingToDrafts(rows);
    const shenme = drafts.find((d) => d.word === '什麼')!;
    expect(shenme.readings).toHaveLength(2);
    expect(shenme.freq).toBe(20445);
  });
});

describe('雙源合併', () => {
  it('同詞同讀音去重且 provenance 聯集', () => {
    const mo: LexiconDraft[] = [
      {
        word: '今天',
        readings: [{ canonical: 'ㄐㄧㄣ ㄊㄧㄢ', syllables: [] as never }],
        provenance: ['moedict'],
      },
    ];
    const lc: LexiconDraft[] = [
      {
        word: '今天',
        readings: [{ canonical: 'ㄐㄧㄣ ㄊㄧㄢ', syllables: [] as never }],
        freq: 25469,
        provenance: ['libchewing'],
      },
    ];
    const { entries, stats } = mergeDrafts([mo, lc]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.provenance).toEqual(['libchewing', 'moedict']);
    expect(entries[0]!.freq).toBe(25469);
    expect(stats.totalReadings).toBe(1);
  });

  it('不同讀音保留為多讀音條目', () => {
    const mo: LexiconDraft[] = [
      {
        word: '垃圾',
        readings: [{ canonical: 'ㄌㄜˋ ㄙㄜˋ', syllables: [] as never }],
        provenance: ['moedict'],
      },
    ];
    const lc: LexiconDraft[] = [
      {
        word: '垃圾',
        readings: [{ canonical: 'ㄌㄜˋ ㄐㄧ', syllables: [] as never }],
        provenance: ['libchewing'],
      },
    ];
    const { entries, stats } = mergeDrafts([mo, lc]);
    expect(entries[0]!.readings).toHaveLength(2);
    expect(stats.multiReadingWords).toBe(1);
  });
});
