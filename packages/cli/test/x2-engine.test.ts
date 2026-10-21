import { describe, it, expect } from 'vitest';
import { Decoder, UserAdapter, syllableToKeyCodes, type LexiconEntry } from '@zhuyin/core';
import { ImeEngine } from '../src/engine.js';

const SCORER = {
  wordLogProb(w: string): number {
    // 單字給普通分；未見多字詞給重懲罰（模擬真實 LM 的 unseen backoff）
    return [...w].length === 1 ? -5 : -16;
  },
  charSequenceLogProb(): number {
    return 0;
  },
};

const LEXICON: LexiconEntry[] = [
  { word: '聯', readings: [['ㄌㄧㄢˊ']], provenance: ['moedict'], freq: 50 },
  { word: '準', readings: [['ㄓㄨㄣˇ']], provenance: ['moedict'], freq: 50 },
  { word: '會', readings: [['ㄏㄨㄟˋ']], provenance: ['moedict'], freq: 90 },
];

function keysFor(engine: ImeEngine, syllables: string[]): void {
  for (const syl of syllables) {
    for (const code of syllableToKeyCodes(syl)) {
      engine.onKey({ code, timestampMs: 0 });
    }
  }
}

describe('X2 引擎整合：覆蓋缺口的學習曲線', () => {
  it('挖詞 → 入格 → 選字 → 成為 top-1（三段式）', () => {
    const decoder = new Decoder(SCORER);
    decoder.loadLexicon(LEXICON);
    const adapter = new UserAdapter();
    const engine = new ImeEngine(
      decoder,
      new Set(['ㄌㄧㄢˊ', 'ㄓㄨㄣˇ', 'ㄏㄨㄟˋ']),
      undefined,
      adapter,
    );
    const SEQ = ['ㄌㄧㄢˊ', 'ㄓㄨㄣˇ', 'ㄏㄨㄟˋ'];

    // t0：詞庫沒有「聯準會」，top-1 是三個單字（串接後恰好同形）
    keysFor(engine, SEQ);
    expect(engine.commit()).toBe('聯準會');

    // commit 把相鄰單字合併記成挖詞，但只出現一次還不入格（MINED_MIN_FREQ）
    expect(adapter.phrases.has('聯準會')).toBe(true);
    expect(decoder.hasEntry(SEQ, '聯準會')).toBe(false);
    // 第二次送出才入格
    keysFor(engine, SEQ);
    expect(engine.commit()).toBe('聯準會');
    expect(decoder.hasEntry(SEQ, '聯準會')).toBe(true);

    // t1：同一引擎再打一次——格上有邊了。整詞路徑與三單字路徑同形，
    // 整句候選只留分數高的那條；整詞要從選字視窗選（游標移到最前、↓、選第 1 個＝最長的詞）
    keysFor(engine, SEQ);
    for (const code of ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowDown'])
      engine.onKey({ code, timestampMs: 0 });
    engine.onKey({ code: 'Digit1', timestampMs: 0 });
    expect(engine.getCandidates()[0]!.words).toEqual(['聯準會']);
    engine.commit();
    expect(adapter.modifierFor(SEQ, '聯準會', 0)).toBeGreaterThan(0);

    // t2：之後的解碼以修飾後分數排序
    keysFor(engine, SEQ);
    expect(engine.getCandidates()[0]!.words).toEqual(['聯準會']);
  });

  it('kill-switch：關閉後 top-1 的詞與分數與無 X2 完全一致（學到的詞彙仍在格上，但 U(w)=0）', () => {
    const build = (): Decoder => {
      const d = new Decoder(SCORER);
      d.loadLexicon(LEXICON);
      return d;
    };
    const adapter = new UserAdapter();
    const eOn = new ImeEngine(build(), [], undefined, adapter);
    const eOff = new ImeEngine(build(), []);
    const SEQ = ['ㄌㄧㄢˊ', 'ㄓㄨㄣˇ', 'ㄏㄨㄟˋ'];
    keysFor(eOn, SEQ);
    keysFor(eOff, SEQ);
    eOn.commit(); // 學習（挖詞入格＋選字記錄）
    adapter.setEnabled(false);
    keysFor(eOn, SEQ);
    const onTop = eOn.getCandidates()[0]!;
    const offTop = eOff.getCandidates()[0]!;
    expect(onTop.words.join('')).toBe(offTop.words.join(''));
    expect(onTop.score).toBeCloseTo(offTop.score, 9);
  });

  it('拆解守恆：wordTerm+charTerm+uTerm 之和等於總分', () => {
    const decoder = new Decoder(SCORER, { gamma: 0.5 });
    decoder.loadLexicon(LEXICON);
    const adapter = new UserAdapter();
    adapter.recordSelection(['ㄌㄧㄢˊ'], '聯');
    const seq = ['ㄌㄧㄢˊ'];
    const paths = decoder.decode(seq, {
      modifier: (w) => adapter.modifierFor(seq, w, 0),
    });
    for (const p of paths) {
      const sum = p.breakdown.reduce((s, b) => s + b.wordTerm + b.charTerm + b.uTerm, 0);
      expect(sum).toBeCloseTo(p.score, 6);
    }
    expect(paths[0]!.breakdown[0]!.uTerm).toBeGreaterThan(0);
  });
});
