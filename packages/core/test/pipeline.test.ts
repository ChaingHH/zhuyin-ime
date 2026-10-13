import { describe, it, expect } from 'vitest';
import {
  DACHEN,
  TONE_CODES,
  mapKey,
  syllableToKeyCodes,
  CompositionBuffer,
  Decoder,
  INITIALS,
  MEDIAS,
  FINALS,
  type LexiconEntry,
} from '../src/index.js';

describe('L1 大千鍵盤映射', () => {
  it('37 個注音符號全部有鍵且不重複', () => {
    const symbols = Object.values(DACHEN.codeMap);
    expect(symbols).toHaveLength(37);
    expect(new Set(symbols).size).toBe(37);
    for (const s of [...INITIALS, ...MEDIAS, ...FINALS]) {
      expect(symbols).toContain(s);
    }
  });

  it('聲調鍵：Space=1聲、6/3/4/7=二三四輕', () => {
    expect(TONE_CODES['Space']).toBe(1);
    expect(TONE_CODES['Digit6']).toBe(2);
    expect(TONE_CODES['Digit3']).toBe(3);
    expect(TONE_CODES['Digit4']).toBe(4);
    expect(TONE_CODES['Digit7']).toBe(5);
  });

  it('映射保留實體鍵（L3a 契約）', () => {
    const m = mapKey(DACHEN, 'KeyC');
    expect(m[0]).toEqual({ kind: 'symbol', symbol: 'ㄏ', code: 'KeyC' });
  });
});

describe('L1↔L2 往返', () => {
  const legal = ['ㄐㄧㄣ', 'ㄊㄧㄢ', 'ㄑㄧˋ', 'ㄕˋ', 'ㄅㄞˊ'];
  it('正規形 → 鍵碼 → 槽位組字 → 相同序列', () => {
    const buf = new CompositionBuffer(DACHEN, legal);
    for (const syl of ['ㄐㄧㄣ', 'ㄊㄧㄢ']) {
      for (const code of syllableToKeyCodes(syl)) {
        buf.onKeyEvent({ code, timestampMs: 0 });
      }
    }
    expect(buf.sequence).toEqual(['ㄐㄧㄣ', 'ㄊㄧㄢ']);
  });

  it('槽位法吸收音節內亂序：ㄣ ㄐ ㄧ 仍得 ㄐㄧㄣ', () => {
    const buf = new CompositionBuffer(DACHEN, legal);
    // 故意以 ㄣ(final)→ㄐ(initial)→ㄧ(medial) 順序送出
    for (const code of ['KeyP', 'KeyR', 'KeyU', 'Space']) {
      buf.onKeyEvent({ code, timestampMs: 0 });
    }
    expect(buf.sequence).toEqual(['ㄐㄧㄣ']);
  });

  it('槽位衝突不接受；Backspace 可回退', () => {
    const buf = new CompositionBuffer(DACHEN, legal);
    expect(buf.onKeyEvent({ code: 'KeyB', timestampMs: 0 }).accepted).toBe(true); // ㄖ
    expect(buf.onKeyEvent({ code: 'KeyN', timestampMs: 0 }).accepted).toBe(false); // 第二聲母 ㄙ
    buf.backspace();
    expect(buf.pendingDisplay).toBe('');
  });

  it('非法音節標記為不合法但仍完成（交 L3 容錯）', () => {
    const buf = new CompositionBuffer(DACHEN, legal);
    buf.onKeyEvent({ code: 'KeyZ', timestampMs: 0 }); // ㄈ
    const out = buf.onKeyEvent({ code: 'Space', timestampMs: 0 }); // ㄈ 一聲不存在
    expect(out.accepted).toBe(true);
    expect(out.legal).toBe(false);
  });
});

const STUB_SCORER = {
  wordLogProb(w: string): number {
    return w === '今天' ? -1 : -3;
  },
  charSequenceLogProb(): number {
    return 0;
  },
};

const LEXICON: LexiconEntry[] = [
  { word: '今天', readings: [['ㄐㄧㄣ', 'ㄊㄧㄢ']], provenance: ['moedict'], freq: 100 },
  { word: '金天', readings: [['ㄐㄧㄣ', 'ㄊㄧㄢ']], provenance: ['libchewing'], freq: 1 },
  { word: '天', readings: [['ㄊㄧㄢ']], provenance: ['moedict'] },
];

describe('L5 解碼器', () => {
  const dec = new Decoder(STUB_SCORER);
  dec.loadLexicon(LEXICON);

  it('N-best 排序與拆解一致', () => {
    const paths = dec.decode(['ㄐㄧㄣ', 'ㄊㄧㄢ']);
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(paths[0]!.words[0]).toBe('今天');
    for (const p of paths) {
      const sum = p.breakdown.reduce((s, b) => s + b.wordTerm + b.charTerm, 0);
      expect(sum).toBeCloseTo(p.score, 6);
    }
  });

  it('OOV 音節保證格連通', () => {
    const paths = dec.decode(['ㄓㄤˋ']); // 不在詞庫
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]!.words[0]).toBe('\u25A1');
  });
});
