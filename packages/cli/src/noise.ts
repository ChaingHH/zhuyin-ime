/**
 * X3 錯誤注入：在按鍵層級模擬打錯，再走真正的 L2 組字，得到「打錯後的音節序列」。
 * 用於評估 L3。注意：相鄰鍵定義與模糊音表和 L3 共用，結果偏樂觀（缺真人打字紀錄）。
 */
import {
  CompositionBuffer,
  DACHEN,
  FUZZY_PAIRS,
  TONE_CODES,
  keyNeighbors,
  syllableToKeyCodes,
} from '@zhuyin/core';

export interface NoiseOptions {
  /** 每個符號鍵出錯的機率（按到相鄰鍵 60%／漏按 20%／多按相鄰鍵 20%） */
  key: number;
  /** 每個音節的認知錯誤機率（模糊音 70%／記錯聲調 30%） */
  cognitive: number;
}

/** 可重現的亂數（mulberry32） */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYMBOL_KEYS = new Set(Object.keys(DACHEN.codeMap));
const MARKS = ['', 'ˊ', 'ˇ', 'ˋ', '˙'];
const fuzzyOf = new Map<string, string[]>();
for (const [a, b] of FUZZY_PAIRS) {
  fuzzyOf.set(a, [...(fuzzyOf.get(a) ?? []), b]);
  fuzzyOf.set(b, [...(fuzzyOf.get(b) ?? []), a]);
}

function pick<T>(xs: readonly T[], r: () => number): T {
  return xs[Math.floor(r() * xs.length)]!;
}

/** 認知錯誤：模糊音替換或改聲調（回傳可能不合法的音節，交給 L2 照打）。 */
function cognitive(syl: string, r: () => number): string {
  const chars = [...syl];
  const fuzzyIdx = chars.map((c, i) => (fuzzyOf.has(c) ? i : -1)).filter((i) => i >= 0);
  if (fuzzyIdx.length > 0 && r() < 0.7) {
    const i = pick(fuzzyIdx, r);
    chars[i] = pick(fuzzyOf.get(chars[i]!)!, r);
    return chars.join('');
  }
  const last = chars[chars.length - 1]!;
  const hasMark = MARKS.includes(last) && last !== '';
  const base = hasMark ? chars.slice(0, -1).join('') : syl;
  const cur = hasMark ? last : '';
  return (
    base +
    pick(
      MARKS.filter((m) => m !== cur),
      r,
    )
  );
}

/** 意圖音節序列 → 打錯後經 L2 組成的觀察音節序列。 */
export function injectNoise(
  syllables: readonly string[],
  legal: Iterable<string>,
  opts: NoiseOptions,
  r: () => number,
): string[] {
  const buf = new CompositionBuffer(DACHEN, legal);
  const press = (code: string): void => {
    buf.onKeyEvent({ code, timestampMs: 0 });
  };
  for (const intended of syllables) {
    const syl = r() < opts.cognitive ? cognitive(intended, r) : intended;
    const codes = syllableToKeyCodes(syl);
    for (const code of codes) {
      if (TONE_CODES[code] !== undefined) {
        // 聲調鍵：只會按到相鄰的聲調鍵（不破壞音節邊界）
        const adj = keyNeighbors(code).filter((c) => TONE_CODES[c] !== undefined);
        press(adj.length > 0 && r() < opts.key ? pick(adj, r) : code);
        continue;
      }
      if (r() >= opts.key) {
        press(code);
        continue;
      }
      const nb = keyNeighbors(code).filter((c) => SYMBOL_KEYS.has(c));
      const kind = r();
      if (kind < 0.6) press(pick(nb, r));
      else if (kind < 0.8)
        continue; // 漏按
      else {
        press(code);
        press(pick(nb, r)); // 多按相鄰鍵
      }
    }
  }
  return buf.sequence;
}
