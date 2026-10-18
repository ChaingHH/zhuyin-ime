import { describe, it, expect } from 'vitest';
import { Channel, Decoder, UserAdapter, syllableToKeyCodes, type LexiconEntry } from '@zhuyin/core';
import { ImeEngine } from '../src/engine.js';

const LEX: LexiconEntry[] = [
  { word: '經驗', readings: [['ㄐㄧㄥ', 'ㄧㄢˋ']], provenance: ['moedict'] },
  { word: '金', readings: [['ㄐㄧㄣ']], provenance: ['moedict'] },
  { word: '驗', readings: [['ㄧㄢˋ']], provenance: ['moedict'] },
];
const SCORER = {
  wordLogProb: (w: string): number => (w === '經驗' ? -2 : -10),
  charSequenceLogProb: (): number => 0,
};
const LEGAL = ['ㄐㄧㄣ', 'ㄐㄧㄥ', 'ㄧㄢˋ'];

function typeSyllables(engine: ImeEngine, syls: string[]): string {
  let comp = '';
  for (const s of syls)
    for (const code of syllableToKeyCodes(s))
      comp = engine.onKey({ code, timestampMs: 0 }).composition;
  return comp;
}

describe('引擎接 L3', () => {
  it('ㄥ 打成 ㄣ：有 L3 更正為「經驗」，X2 學到的是更正後的讀音', () => {
    const decoder = new Decoder(SCORER);
    decoder.loadLexicon(LEX);
    const adapter = new UserAdapter();
    const engine = new ImeEngine(decoder, LEGAL, undefined, adapter);
    engine.channel = new Channel(LEGAL, { nasal: 3 });

    expect(typeSyllables(engine, ['ㄐㄧㄣ', 'ㄧㄢˋ'])).toBe('經驗');
    expect(engine.commit()).toBe('經驗');
    // 讀音層的學習記在意圖讀音（ㄐㄧㄥ）上；打錯的 ㄐㄧㄣ 只剩與讀音無關的全域加成
    const intended = adapter.modifierFor(['ㄐㄧㄥ', 'ㄧㄢˋ'], '經驗');
    const typo = adapter.modifierFor(['ㄐㄧㄣ', 'ㄧㄢˋ'], '經驗');
    expect(intended).toBeGreaterThan(typo * 2);
  });

  it('沒設 channel：維持原行為', () => {
    const decoder = new Decoder(SCORER);
    decoder.loadLexicon(LEX);
    const engine = new ImeEngine(decoder, LEGAL);
    expect(typeSyllables(engine, ['ㄐㄧㄣ', 'ㄧㄢˋ'])).toBe('金驗');
  });
});

describe('英文模式', () => {
  it('組字中切到英文：英文併進組字區，空白整段送出；組字區空的時直接輸出', () => {
    const decoder = new Decoder(SCORER);
    decoder.loadLexicon(LEX);
    const engine = new ImeEngine(decoder, LEGAL);
    const key = (code: string, k?: string) => engine.onKey({ code, key: k, timestampMs: 0 });
    typeSyllables(engine, ['ㄐㄧㄣ']);
    engine.toggleMode();
    expect(engine.mode).toBe('english');
    key('KeyO', 'O');
    key('KeyK', 'K');
    let st = key('KeyX', 'x');
    expect(st.composition).toBe('金OKx');
    expect(st.cursor).toBe(4);
    expect(engine.syllableSequence).toEqual(['ㄐㄧㄣ', 'OKx']);
    st = key('Backspace');
    expect(st.composition).toBe('金OK');
    expect(key('ShiftLeft', 'Shift').text).toBeUndefined();
    engine.toggleMode();
    expect(typeSyllables(engine, ['ㄐㄧㄣ'])).toBe('金OK金');
    engine.toggleMode();
    st = key('Space', ' ');
    expect(st.text).toBe('金OK金 ');
    expect(engine.syllableSequence).toEqual([]);
    expect(key('KeyR', 'R').text).toBe('R');
  });
});
