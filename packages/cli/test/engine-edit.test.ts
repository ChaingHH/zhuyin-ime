import { describe, it, expect } from 'vitest';
import { Decoder, UserAdapter, syllableToKeyCodes, type LexiconEntry } from '@zhuyin/core';
import { ImeEngine } from '../src/engine.js';

const LEX: LexiconEntry[] = [
  { word: '經驗', readings: [['ㄐㄧㄥ', 'ㄧㄢˋ']], provenance: ['moedict'] },
  { word: '經', readings: [['ㄐㄧㄥ']], provenance: ['moedict'] },
  { word: '驗', readings: [['ㄧㄢˋ']], provenance: ['moedict'] },
  { word: '燕', readings: [['ㄧㄢˋ']], provenance: ['moedict'] },
  { word: '他', readings: [['ㄊㄚ']], provenance: ['moedict'] },
  { word: '她', readings: [['ㄊㄚ']], provenance: ['moedict'] },
  { word: '亞里斯多', readings: [['ㄧㄚˇ', 'ㄌㄧˇ', 'ㄙ', 'ㄉㄨㄛ']], provenance: ['moedict'] },
  { word: '得', readings: [['ㄉㄜˊ']], provenance: ['moedict'] },
  { word: '德', readings: [['ㄉㄜˊ']], provenance: ['moedict'] },
];
const COMMON = new Set(['經驗', '他', '亞里斯多', '得']);
const SCORER = {
  wordLogProb: (w: string): number => (COMMON.has(w) ? -2 : -10),
  charSequenceLogProb: (): number => 0,
};

const NAME = ['ㄧㄚˇ', 'ㄌㄧˇ', 'ㄙ', 'ㄉㄨㄛ', 'ㄉㄜˊ'];
function setup(...syls: string[]): ImeEngine {
  return setupWith(undefined, ...syls);
}
function setupWith(adapter: UserAdapter | undefined, ...syls: string[]): ImeEngine {
  const decoder = new Decoder(SCORER);
  decoder.loadLexicon(LEX);
  const e = new ImeEngine(decoder, ['ㄐㄧㄥ', 'ㄧㄢˋ', 'ㄊㄚ', ...NAME], undefined, adapter);
  for (const s of syls) for (const code of syllableToKeyCodes(s)) key(e, code);
  return e;
}
const key = (e: ImeEngine, code: string) => e.onKey({ code, timestampMs: 0 });
/** 開選字視窗，選指定的字 */
function pick(e: ImeEngine, word: string) {
  const items = key(e, 'ArrowDown').menu!.items;
  return key(e, `Digit${items.indexOf(word) + 1}`);
}

describe('疊字旁刪字：選字跟著對的那個字走', () => {
  it('第二字選「她」，游標 1 退格：「她」保留', () => {
    const e = setup('ㄊㄚ', 'ㄊㄚ');
    expect(pick(e, '她').composition).toBe('他她');
    key(e, 'ArrowLeft');
    expect(key(e, 'Backspace').composition).toBe('她');
  });

  it('第一字選「她」，游標 1 退格：選字不套到剩下的字', () => {
    const e = setup('ㄊㄚ', 'ㄊㄚ');
    key(e, 'Home');
    const st = pick(e, '她');
    expect(st.composition).toBe('她他');
    expect(st.cursor).toBe(1);
    expect(key(e, 'Backspace').composition).toBe('他');
  });
});

describe('游標字數', () => {
  it('選注音本身後，游標照畫面上的字數算；接著打的注音接在後面', () => {
    const e = setup('ㄐㄧㄥ', 'ㄧㄢˋ');
    const st = pick(e, 'ㄧㄢˋ');
    expect(st.composition).toBe('經ㄧㄢˋ');
    expect(st.cursor).toBe(4);
    expect(key(e, syllableToKeyCodes('ㄐㄧㄥ')[0]!).composition).toBe('經ㄧㄢˋㄐ');
  });
});

describe('送出', () => {
  it('打到一半的注音不送出、跟著清掉', () => {
    const e = setup();
    key(e, syllableToKeyCodes('ㄐㄧㄥ')[0]!);
    expect(e.commit()).toBe('');
    expect(key(e, 'Home').composition).toBe('');
    const f = setup('ㄐㄧㄥ', 'ㄧㄢˋ');
    key(f, syllableToKeyCodes('ㄐㄧㄥ')[0]!);
    expect(f.commit()).toBe('經驗');
  });
});

describe('數字鍵盤的數字', () => {
  it('連打的數字併成一個 token；退格一次退一位', () => {
    const e = setup('ㄐㄧㄥ');
    key(e, 'Numpad1');
    expect(key(e, 'Numpad2').composition).toBe('經12');
    expect(e.syllableSequence).toEqual(['ㄐㄧㄥ', '12']);
    expect(key(e, 'Backspace').composition).toBe('經1');
  });

  it('原樣 token 上按 ↓ 不開選單、↑ 不換字', () => {
    const e = setup('ㄐㄧㄥ');
    key(e, 'Numpad1');
    expect(key(e, 'ArrowDown').menu).toBeUndefined();
    expect(key(e, 'ArrowUp').composition).toBe('經1');
  });
});

describe('視窗外 ↑', () => {
  it('游標在詞中間，第一下就換字', () => {
    const e = setup('ㄐㄧㄥ', 'ㄧㄢˋ');
    key(e, 'Home');
    key(e, 'ArrowRight');
    expect(key(e, 'ArrowUp').composition).toBe('經燕');
  });
});

describe('長專有名詞的使用者造詞', () => {
  it('選過的字併進 4 字的詞成 5 字使用者詞：下次直接打出來；只打前幾個音節不受影響', () => {
    const adapter = new UserAdapter();
    const e = setupWith(adapter, ...NAME);
    expect(pick(e, '德').composition).toBe('亞里斯多德');
    expect(e.commit()).toBe('亞里斯多德');
    expect(adapter.phrases.get('亞里斯多德')?.manual).toBe(true);
    const type = (syls: string[]): string => {
      let c = '';
      for (const s of syls) for (const code of syllableToKeyCodes(s)) c = key(e, code).composition;
      return c;
    };
    expect(type(NAME)).toBe('亞里斯多德');
    e.clear();
    expect(type(NAME.slice(0, 4))).toBe('亞里斯多');
  });

  it('手動詞加成隨讀音長度成長，算到 6 音節', () => {
    const a = new UserAdapter();
    const boost = (n: number): number => {
      const seq = Array.from({ length: n }, () => 'ㄚ');
      a.setUserPhrase('甲'.repeat(n), seq);
      return a.modifierFor(seq, '甲'.repeat(n));
    };
    expect([2, 3, 5, 6, 8].map(boost)).toEqual([8, 18, 38, 48, 48]);
  });
});
