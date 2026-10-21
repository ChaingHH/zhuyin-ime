import { describe, it, expect } from 'vitest';
import { leakChecker } from '../src/build/leak.js';

describe('防洩漏 8 字窗', () => {
  const leaks = leakChecker(['我今天去台北車站買了一杯咖啡', '天氣很好呢']);

  it('整句包含', () => {
    expect(leaks('昨天我今天去台北車站買了一杯咖啡啊')).toBe(true);
  });

  it('近似重複：改一個字、截掉頭尾仍擋', () => {
    expect(leaks('他今天去台北車站買了兩杯咖啡')).toBe(true);
    expect(leaks('去台北車站買了一杯')).toBe(true);
  });

  it('只共用不到 8 字不擋', () => {
    expect(leaks('明天去台北車站看看')).toBe(false);
  });

  it('不足 8 字的評測句只擋完全包含', () => {
    expect(leaks('今天天氣很好呢對吧')).toBe(true);
    expect(leaks('天氣很好嗎')).toBe(false);
  });
});
