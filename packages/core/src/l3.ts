/**
 * L3 假設展開（通道模型 P(K|S)）：觀察到的音節 → 使用者可能想打的合法音節＋代價。
 *
 * 代價 = −log P(觀察 | 意圖) 的近似，加在解碼分數上（意圖＝觀察時為 0）。
 * 兩個通道：
 * - 運動（L3a）：按到實體相鄰鍵、多按一鍵、漏按一鍵、相鄰聲調鍵。
 * - 認知（L3b）：模糊音（ㄣ/ㄥ、ㄓ/ㄗ…）、記錯聲調。
 * 每個音節只展開一處錯誤；音節內順序顛倒已由 L2 槽位法吸收，這裡不重做。
 */
import { FINALS, INITIALS, MEDIAS, isFinal, isInitial, isMedial } from './index.js';
import { DACHEN, TONE_CODES, type KeyboardLayout } from './keymap.js';

export interface Hypothesis {
  /** 意圖音節（正規形） */
  readonly syl: string;
  /** 通道代價（≥0，log 單位） */
  readonly cost: number;
}

export interface ChannelOptions {
  /** 按到相鄰鍵 */
  sub?: number;
  /** 多按一鍵（意圖少一個符號） */
  extra?: number;
  /** 漏按一鍵（意圖多一個符號） */
  miss?: number;
  /** 按到相鄰聲調鍵（3↔4、6↔7） */
  toneAdj?: number;
  /** 記錯聲調（其他聲調） */
  tone?: number;
  /** 模糊音 */
  fuzzy?: number;
  /** 每個音節最多保留幾個非原音節假設（低代價優先） */
  maxAlts?: number;
}

/** 模糊音對（雙向）：台灣常見的平捲舌、前後鼻音、ㄈㄏ、ㄌㄋ、ㄌㄖ。 */
export const FUZZY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['ㄣ', 'ㄥ'],
  ['ㄓ', 'ㄗ'],
  ['ㄔ', 'ㄘ'],
  ['ㄕ', 'ㄙ'],
  ['ㄈ', 'ㄏ'],
  ['ㄌ', 'ㄋ'],
  ['ㄌ', 'ㄖ'],
];

// 實體鍵盤幾何（標準 ANSI 交錯排列）：鍵中心距離 ≤1.3 視為相鄰
const ROWS: Array<{ offset: number; codes: string[] }> = [
  {
    offset: 0,
    codes: [...'1234567890'.split('').map((d) => `Digit${d}`), 'Minus', 'Equal'],
  },
  { offset: 0.5, codes: [...'QWERTYUIOP'.split('').map((c) => `Key${c}`), 'BracketLeft'] },
  { offset: 0.75, codes: [...'ASDFGHJKL'.split('').map((c) => `Key${c}`), 'Semicolon', 'Quote'] },
  {
    offset: 1.25,
    codes: [...'ZXCVBNM'.split('').map((c) => `Key${c}`), 'Comma', 'Period', 'Slash'],
  },
];
const POS = new Map<string, [number, number]>();
ROWS.forEach((r, y) => r.codes.forEach((code, i) => POS.set(code, [i + r.offset, y])));

/** 實體相鄰鍵（不含自己）。 */
export function keyNeighbors(code: string): string[] {
  const p = POS.get(code);
  if (!p) return [];
  const out: string[] = [];
  for (const [c, q] of POS) {
    if (c === code) continue;
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) <= 1.3) out.push(c);
  }
  return out;
}

type Slot = 'initial' | 'medial' | 'final';
interface Parts {
  initial?: string;
  medial?: string;
  final?: string;
  mark: string;
}

const MARKS = ['', 'ˊ', 'ˇ', 'ˋ', '˙'];
const slotOf = (s: string): Slot | null =>
  isInitial(s) ? 'initial' : isMedial(s) ? 'medial' : isFinal(s) ? 'final' : null;

function parse(syl: string): Parts | null {
  const p: Parts = { mark: '' };
  for (const ch of syl) {
    if (MARKS.includes(ch) && ch !== '') {
      p.mark = ch;
      continue;
    }
    const slot = slotOf(ch);
    if (!slot || p[slot] !== undefined) return null;
    p[slot] = ch;
  }
  return p;
}

const join = (p: Parts): string => `${p.initial ?? ''}${p.medial ?? ''}${p.final ?? ''}${p.mark}`;

export class Channel {
  private readonly legal: ReadonlySet<string>;
  private readonly o: Required<ChannelOptions>;
  private readonly cache = new Map<string, Hypothesis[]>();
  /** 符號 → 實體相鄰鍵上的符號 */
  private readonly symNeighbors = new Map<string, string[]>();
  /** 聲調符號 → 實體相鄰的聲調符號 */
  private readonly toneNeighbors = new Map<string, string[]>();
  private readonly fuzzy = new Map<string, string[]>();

  constructor(legal: Iterable<string>, opts: ChannelOptions = {}, layout: KeyboardLayout = DACHEN) {
    this.legal = new Set(legal);
    this.o = {
      // 預設＝初始值 ×1.5：合成錯誤評測（每鍵 3%、每音節 3% 認知錯誤）的 dev 上，
      // 有錯輸入句準 22%→51%，乾淨輸入只差 −0.4／0（×1 誤更正較多，×2 起救回率下降）
      sub: opts.sub ?? 9,
      extra: opts.extra ?? 10.5,
      miss: opts.miss ?? 12,
      toneAdj: opts.toneAdj ?? 7.5,
      tone: opts.tone ?? 10.5,
      fuzzy: opts.fuzzy ?? 7.5,
      maxAlts: opts.maxAlts ?? 24,
    };
    for (const [code, sym] of Object.entries(layout.codeMap)) {
      this.symNeighbors.set(
        sym,
        keyNeighbors(code)
          .map((n) => layout.codeMap[n])
          .filter((s): s is string => s !== undefined),
      );
    }
    const markOfCode = (c: string): string | undefined => {
      const t = TONE_CODES[c];
      return t === undefined ? undefined : MARKS[t - 1];
    };
    for (const code of Object.keys(TONE_CODES)) {
      const m = markOfCode(code)!;
      this.toneNeighbors.set(
        m,
        keyNeighbors(code)
          .map(markOfCode)
          .filter((x): x is string => x !== undefined),
      );
    }
    for (const [a, b] of FUZZY_PAIRS) {
      this.fuzzy.set(a, [...(this.fuzzy.get(a) ?? []), b]);
      this.fuzzy.set(b, [...(this.fuzzy.get(b) ?? []), a]);
    }
  }

  /** 展開觀察音節：第一個永遠是原音節（代價 0），其後依代價遞增。 */
  expand(observed: string): Hypothesis[] {
    const hit = this.cache.get(observed);
    if (hit) return hit;
    const best = new Map<string, number>();
    const add = (p: Parts, cost: number): void => {
      const s = join(p);
      if (s === observed || !this.legal.has(s)) return;
      if (cost < (best.get(s) ?? Infinity)) best.set(s, cost);
    };
    const p = parse(observed);
    if (p) {
      const o = this.o;
      for (const slot of ['initial', 'medial', 'final'] as const) {
        const c: string | undefined = p[slot];
        if (c === undefined) continue;
        // 多按一鍵：意圖沒有這個符號
        add({ ...p, [slot]: undefined }, o.extra);
        // 按到相鄰鍵：觀察到 c，意圖是 c 鍵旁邊那個鍵的符號 s
        for (const s of this.symNeighbors.get(c) ?? ([] as string[])) {
          const sSlot = slotOf(s)!;
          if (sSlot === slot) add({ ...p, [slot]: s }, o.sub);
          else if (p[sSlot] === undefined) add({ ...p, [slot]: undefined, [sSlot]: s }, o.sub);
        }
        for (const s of this.fuzzy.get(c) ?? []) add({ ...p, [slot]: s }, o.fuzzy);
      }
      // 漏按一鍵：意圖多一個符號（只補空槽）
      const pools: Record<Slot, readonly string[]> = {
        initial: INITIALS,
        medial: MEDIAS,
        final: FINALS,
      };
      for (const slot of ['initial', 'medial', 'final'] as const) {
        if (p[slot] !== undefined) continue;
        for (const s of pools[slot]) add({ ...p, [slot]: s }, o.miss);
      }
      // 聲調：相鄰聲調鍵較便宜，其他聲調算記錯
      const adj = new Set(this.toneNeighbors.get(p.mark) ?? []);
      for (const m of MARKS) {
        if (m !== p.mark) add({ ...p, mark: m }, adj.has(m) ? o.toneAdj : o.tone);
      }
    }
    const alts = [...best]
      .sort((a, b) => a[1] - b[1])
      .slice(0, this.o.maxAlts)
      .map(([syl, cost]) => ({ syl, cost }));
    const out = [{ syl: observed, cost: 0 }, ...alts];
    this.cache.set(observed, out);
    return out;
  }
}
