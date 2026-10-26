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

/** 引擎（native/src/keymap.rs `Layout`）用的是這張表；mapKey 只有大千。 */
export const LAYOUTS: Record<string, KeyboardLayout> = { dachen: DACHEN };

/**
 * 各排列的鍵位：libchewing v0.5.1 `src/common/key2pho.c` 的 `key_str`，
 * 依序對應 PH_ORDER（ㄅ…ㄙ、ㄧㄨㄩ、ㄚ…ㄦ、˙ˊˇˋ）；空白一律是一聲。同 native/src/keymap.rs。
 */
export const LAYOUT_KEYS = {
  dachen: '1qaz2wsxedcrfv5tgbyhnujm8ik,9ol.0p;/-7634',
  eten: "bpmfdtnlvkhg7c,./j;'sexuaorwiqzy890-=1234",
  hsu: 'bpmfdtnlgkhjvcjvcrzasexuyhgeiawomnkllsdfj',
  ibm: '1234567890-qwertyuiopasdfghjkl;zxcvbn/m,.',
  eten26: 'bpmfdtnlvkhgvcgycjqwsexuaorwiqzpmntlhdfjk',
} as const;
export type LayoutName = keyof typeof LAYOUT_KEYS;

const PH_ORDER = 'ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙㄧㄨㄩㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦ˙ˊˇˋ';
const PUNCT_CODE: Record<string, string> = {
  '-': 'Minus',
  '=': 'Equal',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
};
const charCode = (c: string): string =>
  /[a-z]/.test(c) ? `Key${c.toUpperCase()}` : /\d/.test(c) ? `Digit${c}` : PUNCT_CODE[c]!;

/**
 * 正規形音節字串 → 實體鍵碼序列（C-M-F 順序送出後按聲調鍵）。
 * 用於 replay 合成、評測的 L0-L2 往返驗證與未來 X3 錯誤注入。
 * 許氏、倚天 26 鍵靠引擎依槽位判斷一鍵多音，少數音節（如 ㄟ）打不回來，見 keymap.rs 的測試。
 */
export function syllableToKeyCodes(
  canonicalForm: string,
  layout: LayoutName = 'dachen',
): KeyCode[] {
  const keys = LAYOUT_KEYS[layout];
  const MARK = '˙ˊˇˋ';
  let text = canonicalForm;
  let tone = '';
  const last = text[text.length - 1];
  if (last && MARK.includes(last)) {
    tone = last;
    text = text.slice(0, -1);
  }
  const codes: KeyCode[] = [];
  for (const glyph of text) {
    const i = PH_ORDER.indexOf(glyph);
    if (i >= 0) codes.push(charCode(keys[i]!));
  }
  codes.push(tone ? charCode(keys[PH_ORDER.indexOf(tone)]!) : 'Space');
  return codes;
}
