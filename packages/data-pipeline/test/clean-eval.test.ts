import { describe, it, expect } from 'vitest';
import { cleanSentence, splitSentences } from '../src/build/clean.js';
import { segment } from '../src/build/evalset.js';
import type { LexiconEntry } from '@zhuyin/core';

describe('清洗與切句', () => {
  it('簡體轉台灣正體＋用詞', () => {
    const out = cleanSentence('这个软件支持鼠标操作');
    expect(out).toContain('軟體');
    expect(out).toContain('滑鼠');
  });

  it('NFKC：相容表意字轉統一碼、全形標點轉半形、全形英數與半形一樣不收', () => {
    expect(cleanSentence('今天\uF9D1點天氣真好')).toBe('今天六點天氣真好');
    expect(cleanSentence('今天天氣真好，出去走走')).toBe('今天天氣真好,出去走走');
    expect(cleanSentence('ＡＢ今天天氣真好啊')).toBeNull();
  });

  it('過濾非中文主體與過短句', () => {
    expect(cleanSentence('hello world 12345')).toBeNull();
    expect(cleanSentence('你好')).toBeNull();
    expect(cleanSentence('今天天氣真好')).not.toBeNull();
  });

  it('切句', () => {
    const parts = splitSentences('今天天氣很好！我們出去玩。');
    expect(parts).toEqual(['今天天氣很好', '我們出去玩']);
  });
});

const LEX = new Map<string, LexiconEntry>([
  ['今天', { word: '今天', readings: [['ㄐㄧㄣ', 'ㄊㄧㄢ']], provenance: ['moedict'] }],
  [
    '天氣',
    {
      word: '天氣',
      readings: [
        ['ㄊㄧㄢ', 'ㄑㄧˋ'],
        ['ㄊㄧㄢ', 'ㄑㄧ'],
      ],
      provenance: ['libchewing'],
    },
  ],
]);

describe('貪婪最長匹配分詞', () => {
  it('完整覆蓋並輸出音節（多讀音取首組）', () => {
    const seg = segment('今天天氣', LEX)!;
    expect(seg.tokens).toEqual(['今天', '天氣']);
    expect(seg.syllables).toEqual(['ㄐㄧㄣ', 'ㄊㄧㄢ', 'ㄊㄧㄢ', 'ㄑㄧˋ']);
  });

  it('無法覆蓋回 null', () => {
    expect(segment('Hello今天', LEX)).toBeNull();
  });
});
