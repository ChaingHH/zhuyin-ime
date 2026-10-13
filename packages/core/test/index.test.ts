import { describe, it, expect } from 'vitest';
import { isInitial, isMedial, isFinal, toneOf, INITIALS, MEDIAS, FINALS } from '../src/index.js';

describe('注音符號分類表', () => {
  it('37 個符號互斥且完備', () => {
    const all = [...INITIALS, ...MEDIAS, ...FINALS];
    expect(all).toHaveLength(21 + 3 + 13);
    expect(new Set(all).size).toBe(37);
  });

  it('分類函數不重疊', () => {
    for (const s of INITIALS) {
      expect(isInitial(s)).toBe(true);
      expect(isMedial(s)).toBe(false);
      expect(isFinal(s)).toBe(false);
    }
    for (const s of MEDIAS) expect(isMedial(s)).toBe(true);
    for (const s of FINALS) expect(isFinal(s)).toBe(true);
  });

  it('聲調標記映射', () => {
    expect(toneOf('')).toBe(1);
    expect(toneOf('ˊ')).toBe(2);
    expect(toneOf('ˇ')).toBe(3);
    expect(toneOf('ˋ')).toBe(4);
    expect(toneOf('˙')).toBe(5);
    expect(toneOf('?')).toBeUndefined();
  });
});
