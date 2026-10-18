import { describe, it, expect } from 'vitest';
import { Decoder, UserAdapter, syllableToKeyCodes, type LexiconEntry } from '@zhuyin/core';
import { ImeEngine } from '../src/engine.js';

const LEX: LexiconEntry[] = [
  { word: '經驗', readings: [['ㄐㄧㄥ', 'ㄧㄢˋ']], provenance: ['moedict'] },
  { word: '經', readings: [['ㄐㄧㄥ']], provenance: ['moedict'] },
  { word: '晶', readings: [['ㄐㄧㄥ']], provenance: ['moedict'] },
  { word: '驗', readings: [['ㄧㄢˋ']], provenance: ['moedict'] },
  { word: '燕', readings: [['ㄧㄢˋ']], provenance: ['moedict'] },
];
const SCORER = {
  wordLogProb: (w: string): number => (w === '經驗' ? -2 : -10),
  charSequenceLogProb: (): number => 0,
};
const LEGAL = ['ㄐㄧㄥ', 'ㄧㄢˋ'];

function typeIn(engine: ImeEngine): void {
  for (const s of ['ㄐㄧㄥ', 'ㄧㄢˋ'])
    for (const code of syllableToKeyCodes(s)) engine.onKey({ code, timestampMs: 0 });
}
function setup(adapter?: UserAdapter): ImeEngine {
  const decoder = new Decoder(SCORER);
  decoder.loadLexicon(LEX);
  const engine = new ImeEngine(decoder, LEGAL, undefined, adapter);
  typeIn(engine);
  return engine;
}
const key = (e: ImeEngine, code: string) => e.onKey({ code, timestampMs: 0 });

describe('選字視窗', () => {
  it('游標在最後：↓ 列出最後一個字的候選，數字鍵選定後該詞固定', () => {
    const e = setup();
    expect(key(e, 'ArrowDown').menu?.items).toEqual(['驗', '燕']);
    const st = key(e, 'Digit2');
    expect(st.menu).toBeUndefined();
    expect(st.composition.endsWith('燕')).toBe(true);
    expect(e.commit()).toBe(st.composition);
  });

  it('微軟注音鍵位：↓↑ 移反白（頭尾循環）、Enter 選反白', () => {
    const e = setup();
    expect(key(e, 'ArrowDown').menu?.cursor).toBe(0);
    expect(key(e, 'ArrowDown').menu?.cursor).toBe(1);
    expect(key(e, 'ArrowDown').menu?.cursor).toBe(0);
    expect(key(e, 'ArrowUp').menu?.cursor).toBe(1);
    expect(key(e, 'Enter').composition.endsWith('燕')).toBe(true);
  });

  it('← 移到字前面：↓ 列出從游標開始的詞（長詞在前）；後面的字照樣重解碼', () => {
    const e = setup();
    expect(key(e, 'ArrowLeft').cursor).toBe(1);
    expect(key(e, 'ArrowLeft').cursor).toBe(0);
    expect(key(e, 'ArrowDown').menu?.items).toEqual(['經驗', '經', '晶']);
    expect(key(e, 'Digit3').composition.startsWith('晶')).toBe(true);
  });

  it('Esc 關閉不改字；退格退掉固定段所在的音節後，固定段作廢', () => {
    const e = setup();
    key(e, 'ArrowDown');
    expect(key(e, 'Escape').composition).toBe('經驗');
    key(e, 'ArrowDown');
    key(e, 'Digit2');
    key(e, 'Backspace');
    for (const code of syllableToKeyCodes('ㄧㄢˋ')) key(e, code);
    expect(e.getCandidates()[0]!.words.join('')).toBe('經驗');
  });

  it('選過的字連同相鄰單字存成使用者詞：下次同讀音直接是它', () => {
    const adapter = new UserAdapter();
    const e = setup(adapter);
    key(e, 'ArrowDown');
    const picked = key(e, 'Digit2').composition;
    expect(e.commit()).toBe(picked);
    expect(adapter.phrases.get(picked)?.manual).toBe(true);
    typeIn(e);
    expect(e.getCandidates()[0]!.words.join('')).toBe(picked);
  });
});

describe('標點與空格', () => {
  it('有字時空格、標點留在組字區一起送出；空的組字區直接輸出', () => {
    const e = setup();
    expect(key(e, 'Space').composition).toBe('經驗 ');
    const st = e.onKey({ code: 'Comma', key: '<', timestampMs: 0 });
    expect(st.text).toBeUndefined();
    expect(st.composition).toBe('經驗 ，');
    expect(e.commit()).toBe('經驗 ，');
    expect(key(e, 'Space').text).toBe(' ');
    expect(e.onKey({ code: 'BracketLeft', key: '[', timestampMs: 0 }).text).toBe('「');
  });

  it('沒按 Shift 的 , 還是注音 ㄝ', () => {
    const e = setup();
    e.commit();
    const st = e.onKey({ code: 'Comma', key: ',', timestampMs: 0 });
    expect(st.text).toBeUndefined();
    expect(st.composition).toBe('ㄝ');
  });
});

describe('整句候選', () => {
  it('同樣的字、不同斷詞只留一條（分數最高的）', () => {
    const e = setup();
    const texts = e.getCandidates().map((p) => p.words.join(''));
    expect(new Set(texts).size).toBe(texts.length);
    expect(e.getCandidates()[0]!.words).toEqual(['經驗']);
  });
});

describe('Esc', () => {
  it('選字視窗沒開時，Esc 放棄整段組字（不送出、不學習）', () => {
    const adapter = new UserAdapter();
    const e = setup(adapter);
    const st = key(e, 'Escape');
    expect(st.composition).toBe('');
    expect(e.syllableSequence).toEqual([]);
    expect(adapter.toJSON().bySeq).toEqual({});
  });
});

describe('組字中的空格', () => {
  it('有字時按空白：空格留在組字區、自成一詞，跟著一起送出；不併進造詞', () => {
    const adapter = new UserAdapter();
    const decoder = new Decoder(SCORER);
    decoder.loadLexicon(LEX);
    const e = new ImeEngine(decoder, LEGAL, undefined, adapter);
    for (const code of syllableToKeyCodes('ㄐㄧㄥ')) key(e, code);
    expect(key(e, 'Space').composition).toBe('經 ');
    for (const code of syllableToKeyCodes('ㄧㄢˋ')) key(e, code);
    // 「經驗」不能跨過空格
    expect(e.getCandidates()[0]!.words).toEqual(['經', ' ', '驗']);
    expect(e.commit()).toBe('經 驗');
    expect([...adapter.phrases.keys()]).toEqual([]);
  });

  it('打到一半（有未完成注音）時空白鍵還是一聲；退格會退掉空格', () => {
    const e = setup();
    key(e, 'KeyR'); // ㄐ
    key(e, 'KeyU'); // ㄧ
    key(e, 'Space'); // 一聲：完成 ㄐㄧ
    expect(e.syllableSequence).toEqual(['ㄐㄧㄥ', 'ㄧㄢˋ', 'ㄐㄧ']);
    key(e, 'Space'); // 沒有未完成注音：空格
    expect(e.syllableSequence).toEqual(['ㄐㄧㄥ', 'ㄧㄢˋ', 'ㄐㄧ', ' ']);
    key(e, 'Backspace');
    expect(e.syllableSequence).toEqual(['ㄐㄧㄥ', 'ㄧㄢˋ', 'ㄐㄧ']);
  });
});

describe('游標在中間', () => {
  const comma = (e: ImeEngine) => e.onKey({ code: 'Comma', key: '<', timestampMs: 0 });

  it('插字、空格、標點都插在游標處；打到一半的注音也顯示在游標處', () => {
    const e = setup(); // 經驗
    key(e, 'ArrowLeft'); // 游標在「驗」前
    key(e, 'Space');
    expect(e.syllableSequence).toEqual(['ㄐㄧㄥ', ' ', 'ㄧㄢˋ']);
    comma(e);
    expect(e.syllableSequence).toEqual(['ㄐㄧㄥ', ' ', '，', 'ㄧㄢˋ']);
    const st = key(e, 'KeyR'); // ㄐ：還沒打完
    expect(st.cursor).toBe(3);
    expect(st.composition).toBe('經 ，ㄐ驗');
    key(e, 'KeyU');
    key(e, 'Slash');
    key(e, 'Space'); // 一聲：完成 ㄐㄧㄥ，插在游標處
    expect(e.syllableSequence).toEqual(['ㄐㄧㄥ', ' ', '，', 'ㄐㄧㄥ', 'ㄧㄢˋ']);
    expect(e.commit()).toMatch(/^經 ，.驗$/);
  });

  it('Backspace 刪游標前、Delete 刪游標後；Home／End 移到頭尾', () => {
    const e = setup();
    key(e, 'Home');
    key(e, 'Delete');
    expect(e.syllableSequence).toEqual(['ㄧㄢˋ']);
    key(e, 'Backspace'); // 游標在最前：沒東西可刪
    expect(e.syllableSequence).toEqual(['ㄧㄢˋ']);
    key(e, 'End');
    key(e, 'Backspace');
    expect(e.syllableSequence).toEqual([]);
  });

  it('前面插字後，後面選過的詞跟著平移、仍然固定', () => {
    const e = setup();
    key(e, 'ArrowDown');
    key(e, 'Digit2'); // 最後一個字固定為「燕」
    key(e, 'Home');
    for (const code of syllableToKeyCodes('ㄐㄧㄥ')) key(e, code);
    expect(e.syllableSequence).toEqual(['ㄐㄧㄥ', 'ㄐㄧㄥ', 'ㄧㄢˋ']);
    expect(e.getCandidates()[0]!.words.join('').endsWith('燕')).toBe(true);
  });

  it('打到一半的注音時標點不收', () => {
    const e = setup();
    key(e, 'KeyR');
    expect(comma(e).composition).toBe('經驗ㄐ');
    expect(e.syllableSequence).toEqual(['ㄐㄧㄥ', 'ㄧㄢˋ']);
  });
});

describe('狀態欄：選過的單字黏在多字詞旁', () => {
  const LEX2: LexiconEntry[] = [
    { word: '狀態', readings: [['ㄓㄨㄤˋ', 'ㄊㄞˋ']], provenance: ['moedict'] },
    { word: '蘭', readings: [['ㄌㄢˊ']], provenance: ['moedict'] },
    { word: '欄', readings: [['ㄌㄢˊ']], provenance: ['moedict'] },
  ];
  // 狀態|蘭 −7 勝過 狀態|欄 −8（差 1，比 X2 選字加成 0.55·ln2 大、比 0.55·ln6 小）
  const LP: Record<string, number> = { 狀態: -2, 蘭: -5, 欄: -6 };
  const SCORER2 = {
    wordLogProb: (w: string): number => LP[w] ?? -10,
    charSequenceLogProb: (): number => 0,
  };
  const typeIt = (e: ImeEngine): string => {
    let comp = '';
    for (const s of ['ㄓㄨㄤˋ', 'ㄊㄞˋ', 'ㄌㄢˊ'])
      for (const code of syllableToKeyCodes(s))
        comp = e.onKey({ code, timestampMs: 0 }).composition;
    return comp;
  };
  const make = (adapter: UserAdapter): ImeEngine => {
    const decoder = new Decoder(SCORER2);
    decoder.loadLexicon(LEX2);
    return new ImeEngine(decoder, ['ㄓㄨㄤˋ', 'ㄊㄞˋ', 'ㄌㄢˊ'], undefined, adapter);
  };

  it('選一次「欄」送出，下次直接是狀態欄（併進左邊的詞存成使用者詞）', () => {
    const adapter = new UserAdapter();
    const e = make(adapter);
    expect(typeIt(e)).toBe('狀態蘭');
    expect(key(e, 'ArrowDown').menu?.items).toEqual(['蘭', '欄']);
    key(e, 'Digit2');
    expect(e.commit()).toBe('狀態欄');
    expect(adapter.phrases.get('狀態欄')?.readings).toEqual([['ㄓㄨㄤˋ', 'ㄊㄞˋ', 'ㄌㄢˊ']]);
    expect(typeIt(e)).toBe('狀態欄');
  });

  it('X2 選字加成以該詞的讀音為鍵：ㄌㄢˊ 選過 5 次「欄」就翻成狀態欄', () => {
    const adapter = new UserAdapter();
    for (let i = 0; i < 5; i++) adapter.recordSelection(['ㄌㄢˊ'], '欄');
    expect(typeIt(make(adapter))).toBe('狀態欄');
  });
});
