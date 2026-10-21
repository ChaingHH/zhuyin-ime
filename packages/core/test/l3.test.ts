import { describe, it, expect } from 'vitest';
import { Channel, Decoder, keyNeighbors, type LexiconEntry } from '../src/index.js';

describe('L3 鍵盤幾何', () => {
  it('相鄰鍵：R 的鄰居含同排與上下排，不含遠鍵', () => {
    const n = keyNeighbors('KeyR');
    for (const c of ['KeyE', 'KeyT', 'Digit4', 'Digit5', 'KeyD', 'KeyF']) expect(n).toContain(c);
    expect(n).not.toContain('KeyY');
    expect(n).not.toContain('KeyR');
  });
});

describe('L3 通道展開', () => {
  const legal = ['ㄐㄧㄣ', 'ㄐㄧㄥ', 'ㄑㄧㄣ', 'ㄐㄧㄣˋ', 'ㄐㄧ', 'ㄓ', 'ㄗ'];
  const ch = new Channel(legal);

  it('原音節排第一且代價 0；其餘皆合法、代價遞增', () => {
    const h = ch.expand('ㄐㄧㄣ');
    expect(h[0]).toEqual({ syl: 'ㄐㄧㄣ', cost: 0 });
    for (const x of h.slice(1)) expect(legal).toContain(x.syl);
    for (let i = 2; i < h.length; i++) expect(h[i]!.cost).toBeGreaterThanOrEqual(h[i - 1]!.cost);
  });

  it('模糊音 ㄣ→ㄥ、相鄰鍵 ㄐ(R)→ㄑ(F)、多按 ㄣ、聲調', () => {
    const syls = ch.expand('ㄐㄧㄣ').map((x) => x.syl);
    expect(syls).toContain('ㄐㄧㄥ'); // 模糊音
    expect(syls).toContain('ㄑㄧㄣ'); // R 與 F 相鄰
    expect(syls).toContain('ㄐㄧ'); // 多按一鍵
    expect(syls).toContain('ㄐㄧㄣˋ'); // 聲調
  });

  it('不合法的觀察音節也能展開到合法音節', () => {
    const syls = ch.expand('ㄓㄧ').map((x) => x.syl); // ㄓㄧ 不存在
    expect(syls[0]).toBe('ㄓㄧ');
    expect(syls).toContain('ㄓ'); // 多按 ㄧ
  });
});

describe('解碼器使用 L3 假設', () => {
  const lex: LexiconEntry[] = [
    { word: '經驗', readings: [['ㄐㄧㄥ', 'ㄧㄢˋ']], provenance: ['moedict'] },
    { word: '金', readings: [['ㄐㄧㄣ']], provenance: ['moedict'] },
    { word: '驗', readings: [['ㄧㄢˋ']], provenance: ['moedict'] },
  ];
  // 兩字詞遠比兩個單字通順
  const scorer = {
    wordLogProb: (w: string): number => (w === '經驗' ? -2 : -10),
    charSequenceLogProb: (): number => 0,
  };
  const dec = new Decoder(scorer);
  dec.loadLexicon(lex);
  const ch = new Channel(['ㄐㄧㄣ', 'ㄐㄧㄥ', 'ㄧㄢˋ'], { nasal: 3 });
  const obs = ['ㄐㄧㄣ', 'ㄧㄢˋ']; // 把 ㄥ 打成 ㄣ

  it('沒有 L3：只能拼出單字', () => {
    expect(dec.decode(obs)[0]!.words).toEqual(['金', '驗']);
  });

  it('有 L3：更正為「經驗」，讀音與通道代價記在拆解裡，且分數守恆', () => {
    const top = dec.decode(obs, { alternatives: obs.map((s) => ch.expand(s)) })[0]!;
    expect(top.words).toEqual(['經驗']);
    expect(top.breakdown[0]!.reading).toEqual(['ㄐㄧㄥ', 'ㄧㄢˋ']);
    expect(top.breakdown[0]!.chTerm).toBe(-3);
    const sum = top.breakdown.reduce((s, b) => s + b.wordTerm + b.charTerm + b.uTerm + b.chTerm, 0);
    expect(sum).toBeCloseTo(top.score, 6);
  });
});

describe('L3 截斷與跨槽覆蓋', () => {
  it('漏按假設不受 maxAlts 限制', () => {
    const ch = new Channel(['ㄧ', 'ㄧㄥ', 'ㄧˋ'], { maxAlts: 0 });
    expect(ch.expand('ㄧ').map((x) => x.syl)).toEqual(['ㄧ', 'ㄧㄥ']);
  });

  it('鄰鍵蓋掉已填的槽：ㄒㄧㄠ 的 U 按成 Y（ㄗ）→ ㄗㄠ 推得回 ㄒㄧㄠ', () => {
    const ch = new Channel(['ㄒㄧㄠ', 'ㄗㄠ']);
    expect(ch.expand('ㄗㄠ').map((x) => x.syl)).toContain('ㄒㄧㄠ');
  });
});

describe('解碼器 N-best 與固定段', () => {
  const lex: LexiconEntry[] = [
    { word: '經驗', readings: [['ㄐㄧㄥ', 'ㄧㄢˋ']], provenance: ['moedict'] },
    { word: '經', readings: [['ㄐㄧㄥ']], provenance: ['moedict'] },
    { word: '驗', readings: [['ㄧㄢˋ']], provenance: ['moedict'] },
    { word: '晶', readings: [['ㄐㄧㄥ']], provenance: ['moedict'] },
  ];
  const dec = new Decoder({ wordLogProb: () => -5, charSequenceLogProb: () => 0 });
  dec.loadLexicon(lex);
  const obs = ['ㄐㄧㄥ', 'ㄧㄢˋ'];

  it('同一串字的不同斷詞只留一條', () => {
    const texts = dec.decode(obs, { nBest: 8 }).map((p) => p.words.join(''));
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts).toContain('晶驗');
  });

  it('固定段越界或走不通時不帶固定段重解，不回空', () => {
    expect(dec.decode(obs, { fixed: [{ pos: 1, len: 5, word: '驗' }] }).length).toBeGreaterThan(0);
    expect(dec.decode(obs, { fixed: [{ pos: 0, len: 1, word: '沒有' }] }).length).toBeGreaterThan(0);
  });
});
