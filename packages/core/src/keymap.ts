import type { KeyCode, Tone } from './index.js';

/**
 * L1 鍵盤映射契約：輸出「符號 + 它來自哪個實體鍵」的配對。
 * L3a 運動通道需要回頭查實體鍵位算鄰居距離，所以不能只輸出符號。
 */
export type MappedKey =
  | { kind: 'symbol'; symbol: string; code: KeyCode }
  | { kind: 'tone'; tone: Tone; code: KeyCode }
  | { kind: 'unmapped'; code: KeyCode };

export interface KeyboardLayout {
  readonly name: string;
  /** event.code → 注音符號（純聲調鍵不在表內，見 TONE_CODES） */
  readonly codeMap: Readonly<Record<string, string>>;
}

/** 大千的聲調鍵：空白＝一聲、6=ˊ、3=ˇ、4=ˋ、7=˙。遠離 home row 且相鄰，是已知誤按熱區。 */
export const TONE_CODES: Readonly<Record<string, Tone>> = {
  Space: 1,
  Digit6: 2,
  Digit3: 3,
  Digit4: 4,
  Digit7: 5,
};

// 大千式排列（聲母依直橫族分組；3/4/6/7 為純聲調鍵）
const DACHEN_ROWS: Array<[string, string]> = [
  ['Digit1', 'ㄅ'],
  ['Digit2', 'ㄉ'],
  ['Digit5', 'ㄓ'],
  ['Digit8', 'ㄚ'],
  ['Digit9', 'ㄞ'],
  ['Digit0', 'ㄢ'],
  ['Minus', 'ㄦ'],
  ['KeyQ', 'ㄆ'],
  ['KeyW', 'ㄊ'],
  ['KeyE', 'ㄍ'],
  ['KeyR', 'ㄐ'],
  ['KeyT', 'ㄔ'],
  ['KeyY', 'ㄗ'],
  ['KeyU', 'ㄧ'],
  ['KeyI', 'ㄛ'],
  ['KeyO', 'ㄟ'],
  ['KeyP', 'ㄣ'],
  ['KeyA', 'ㄇ'],
  ['KeyS', 'ㄋ'],
  ['KeyD', 'ㄎ'],
  ['KeyF', 'ㄑ'],
  ['KeyG', 'ㄕ'],
  ['KeyH', 'ㄘ'],
  ['KeyJ', 'ㄨ'],
  ['KeyK', 'ㄜ'],
  ['KeyL', 'ㄠ'],
  ['Semicolon', 'ㄤ'],
  ['KeyZ', 'ㄈ'],
  ['KeyX', 'ㄌ'],
  ['KeyC', 'ㄏ'],
  ['KeyV', 'ㄒ'],
  ['KeyB', 'ㄖ'],
  ['KeyN', 'ㄙ'],
  ['KeyM', 'ㄩ'],
  ['Comma', 'ㄝ'],
  ['Period', 'ㄡ'],
  ['Slash', 'ㄥ'],
];

export const DACHEN: KeyboardLayout = {
  name: 'dachen',
  codeMap: Object.fromEntries(DACHEN_ROWS),
};

/** 映射單一實體鍵。26 鍵排列會一鍵多符號——介面回傳陣列以容納未來排列。 */
export function mapKey(layout: KeyboardLayout, code: KeyCode): MappedKey[] {
  const tone = TONE_CODES[code];
  if (tone !== undefined) return [{ kind: 'tone', tone, code }];
  const symbol = layout.codeMap[code];
  if (symbol !== undefined) return [{ kind: 'symbol', symbol, code }];
  return [{ kind: 'unmapped', code }];
}

/** 倚天26／許氏等排列僅保留介面位置（Phase 2+）。 */
export const LAYOUTS: Record<string, KeyboardLayout> = { dachen: DACHEN };

const SYMBOL_TO_CODE = new Map(
  Object.entries(DACHEN.codeMap).map(([code, sym]) => [sym, code] as const),
);
const TONE_TO_CODE: Readonly<Record<Tone, string>> = {
  1: 'Space',
  2: 'Digit6',
  3: 'Digit3',
  4: 'Digit4',
  5: 'Digit7',
};

/**
 * 正規形音節字串 → 實體鍵碼序列（C-M-F 順序送出後按聲調鍵）。
 * 用於 replay 合成、評測的 L0-L2 往返驗證與未來 X3 錯誤注入。
 */
export function syllableToKeyCodes(canonicalForm: string): KeyCode[] {
  const MARK_TO_TONE: Record<string, Tone> = { ˊ: 2, ˇ: 3, ˋ: 4, '˙': 5 };
  let text = canonicalForm;
  let tone: Tone = 1;
  const last = text[text.length - 1];
  if (last && MARK_TO_TONE[last] !== undefined) {
    tone = MARK_TO_TONE[last]!;
    text = text.slice(0, -1);
  }
  const codes: KeyCode[] = [];
  for (const glyph of text) {
    const code = SYMBOL_TO_CODE.get(glyph);
    if (code) codes.push(code);
  }
  codes.push(TONE_TO_CODE[tone]);
  return codes;
}
