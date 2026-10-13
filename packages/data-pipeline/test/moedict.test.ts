import { describe, it, expect } from 'vitest';
import { moedictToDrafts } from '../src/build/lexicon.js';
import type { MoedictEntry } from '../src/sources/moedict.js';

const FIXTURE: MoedictEntry[] = [
  {
    title: '今天',
    heteronyms: [{ bopomofo: 'ㄐㄧㄣ ㄊㄧㄢ', pinyin: 'jīn tiān' }],
  },
  {
    title: '得',
    heteronyms: [
      { bopomofo: '˙ㄉㄜ' },
      { bopomofo: 'ㄉㄜˊ' },
      { bopomofo: 'ㄉㄞˇ' },
      { bopomofo: 'ㄉㄟˇ' },
    ],
  },
  { title: '{[8ff0]}', heteronyms: [{ bopomofo: 'ㄓㄨㄤˋ' }] },
  { title: '壞詞', heteronyms: [{ bopomofo: 'ㄅㄆㄚ' }] },
];

describe('萌典解析', () => {
  const { drafts, skippedReadings } = moedictToDrafts(FIXTURE);

  it('glyph 參照標題被丟棄', () => {
    expect(drafts.map((d) => d.word)).toEqual(['今天', '得']);
  });

  it('破音字展開為多讀音', () => {
    const de = drafts.find((d) => d.word === '得')!;
    expect(de.readings).toHaveLength(4);
    expect(de.readings.map((r) => r.canonical).sort()).toEqual([
      'ㄉㄜˊ',
      'ㄉㄜ˙',
      'ㄉㄞˇ',
      'ㄉㄟˇ',
    ]);
  });

  it('不可解析讀音計數', () => {
    expect(skippedReadings).toBe(1);
  });

  it('provenance 標記 moedict', () => {
    expect(drafts[0]!.provenance).toEqual(['moedict']);
  });
});
