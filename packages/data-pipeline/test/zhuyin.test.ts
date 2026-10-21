import { describe, it, expect } from 'vitest';
import {
  canonicalSequence,
  isStructurallyValid,
  parseSyllable,
  parseSyllableSequence,
  splitAlternativeReadings,
} from '../src/zhuyin.js';

describe('音節解析', () => {
  it('萌典前綴式輕聲：˙ㄉㄜ', () => {
    const p = parseSyllable('˙ㄉㄜ', 'prefix');
    expect(p).not.toBeNull();
    expect(p!.syllable).toEqual({ initial: 'ㄉ', final: 'ㄜ', tone: 5 });
    expect(p!.canonical).toBe('ㄉㄜ˙');
  });

  it('libchewing 後綴式輕聲：ㄇㄜ˙', () => {
    const p = parseSyllable('ㄇㄜ˙', 'suffix');
    expect(p!.syllable.tone).toBe(5);
    expect(p!.canonical).toBe('ㄇㄜ˙');
  });

  it('三聲與四聲後綴（兩種慣例皆同形）', () => {
    expect(parseSyllable('ㄋㄠˇ', 'prefix')!.syllable.tone).toBe(3);
    expect(parseSyllable('ㄓㄨㄤˋ', 'suffix')!.syllable.tone).toBe(4);
  });

  it('槽位分解：ㄐㄧㄣ = 聲母ㄐ＋介音ㄧ＋韻母ㄣ', () => {
    const p = parseSyllable('ㄐㄧㄣ', 'prefix');
    expect(p!.syllable).toEqual({ initial: 'ㄐ', medial: 'ㄧ', final: 'ㄣ', tone: 1 });
  });

  it('捲舌音 ㄓㄨㄤ', () => {
    const p = parseSyllable('ㄓㄨㄤ', 'prefix');
    expect(p!.syllable.initial).toBe('ㄓ');
    expect(p!.syllable.medial).toBe('ㄨ');
    expect(p!.syllable.final).toBe('ㄤ');
  });

  it('雙聲母衝突回 null', () => {
    expect(parseSyllable('ㄅㄆㄚ', 'prefix')).toBeNull();
  });

  it('未知符號回 null（不做猜測，交 L3 容錯）', () => {
    expect(parseSyllable('xㄚ', 'prefix')).toBeNull();
  });

  it('獨立聲母可解析但結構不合法', () => {
    const p = parseSyllable('ㄅ', 'suffix');
    expect(p).not.toBeNull();
    expect(isStructurallyValid(p!.syllable)).toBe(false);
  });

  it('介音兼韻核：ㄍㄨˇ、ㄅㄨˋ、ㄧˋ 合法', () => {
    for (const raw of ['ㄍㄨˇ', 'ㄅㄨˋ', 'ㄧˋ', 'ㄩ']) {
      const p = parseSyllable(raw, 'prefix');
      expect(p).not.toBeNull();
      expect(isStructurallyValid(p!.syllable)).toBe(true);
    }
  });

  it('空韻：ㄕˋ、ㄗ˙ 合法；ㄅ、ㄌ 單獨不合法', () => {
    expect(isStructurallyValid(parseSyllable('ㄕˋ', 'prefix')!.syllable)).toBe(true);
    expect(isStructurallyValid(parseSyllable('ㄗ˙', 'suffix')!.syllable)).toBe(true);
    expect(isStructurallyValid(parseSyllable('ㄅ', 'suffix')!.syllable)).toBe(false);
    expect(isStructurallyValid(parseSyllable('ㄌㄜˋ', 'prefix')!.syllable)).toBe(true);
  });

  it('黏連兒化：ㄊㄡˊㄦ 切為兩音節；單獨 ㄦˊ 不受影響', () => {
    const erhua = parseSyllableSequence('ㄊㄡˊㄦ', 'prefix');
    expect(erhua!.map((s) => s.canonical).join(' ')).toBe('ㄊㄡˊ ㄦ');
    const er = parseSyllable('ㄦˊ', 'prefix');
    expect(er!.canonical).toBe('ㄦˊ');
    const lightEr = parseSyllable('˙ㄦ', 'prefix');
    expect(lightEr!.canonical).toBe('ㄦ˙');
  });

  it('黏連兒化帶輕聲：前綴式 ˙ 屬 ㄦ、後綴式 ˙ 屬前字', () => {
    expect(canonicalSequence(parseSyllableSequence('ㄊㄡ˙ㄦ', 'prefix')!)).toBe('ㄊㄡ ㄦ˙');
    expect(canonicalSequence(parseSyllableSequence('ㄇㄜ˙ㄦ', 'suffix')!)).toBe('ㄇㄜ˙ ㄦ');
  });

  it('萌典讀音標註當分隔符：（語音）（讀音）（又音）', () => {
    expect(splitAlternativeReadings('（語音）ㄕㄡˊ　（讀音）ㄕㄨˊ')).toEqual(['ㄕㄡˊ', 'ㄕㄨˊ']);
    expect(splitAlternativeReadings('ㄌㄨㄛˋ（又音）ㄌㄠˋ')).toEqual(['ㄌㄨㄛˋ', 'ㄌㄠˋ']);
    expect(splitAlternativeReadings('ㄐㄧㄣ ㄊㄧㄢ，ㄐㄧㄣ ㄊㄧㄢ˙')).toHaveLength(2);
  });

  it('序列解析：今天', () => {
    const seq = parseSyllableSequence('ㄐㄧㄣ ㄊㄧㄢ', 'prefix');
    expect(seq).toHaveLength(2);
    expect(canonicalSequence(seq!)).toBe('ㄐㄧㄣ ㄊㄧㄢ');
  });

  it('序列中任一音節失敗則整串 null', () => {
    expect(parseSyllableSequence('ㄐㄧㄣ x', 'prefix')).toBeNull();
  });
});
