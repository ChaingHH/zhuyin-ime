/**
 * 核心契約（Phase 0 凍結範圍：L0 按鍵、L2 音節、詞庫條目）。
 *
 * 設計約束來自架構文件：
 * - L0 不得丟失實體鍵位與時戳——兩者一路保留到 L3 運動通道。
 * - L2 四槽互斥且順序固定（聲母→介音→韻母→聲調），槽位法免費吸收音節內順序錯誤。
 * - 所有資料資產逐筆帶 provenance，支援 Apache-2.0 專案內混用 OGDL/LGPL 來源。
 */

/** 實體鍵盤 code（W3C KeyboardEvent.code），非字元值。 */
export type KeyCode = string;

/** L0 按鍵事件。timestampMs 為單調時鐘毫秒；inter-key interval 是 L3a 的強預測因子。 */
export interface KeyEvent {
  readonly code: KeyCode;
  readonly timestampMs: number;
  /** 該鍵產生的字元（KeyboardEvent.key）；英文模式直接輸出它，注音模式只用來認標點（Shift+, 等） */
  readonly key?: string;
}

/** 注音聲調：1~4 聲與 5（輕聲）。大千鍵盤上分別為空白/6/3/4/7。 */
export type Tone = 1 | 2 | 3 | 4 | 5;

/** L2 音節四槽。任一槽可空（聲調除外）。 */
export interface Syllable {
  readonly initial?: string;
  readonly medial?: string;
  readonly final?: string;
  readonly tone: Tone;
}

export const INITIALS = [
  'ㄅ',
  'ㄆ',
  'ㄇ',
  'ㄈ',
  'ㄉ',
  'ㄊ',
  'ㄋ',
  'ㄌ',
  'ㄍ',
  'ㄎ',
  'ㄏ',
  'ㄐ',
  'ㄑ',
  'ㄒ',
  'ㄓ',
  'ㄔ',
  'ㄕ',
  'ㄖ',
  'ㄗ',
  'ㄘ',
  'ㄙ',
] as const;

export * from './keymap.js';
export * from './slots.js';
export * from './decode.js';
export * from './x2.js';
export * from './l3.js';

export const MEDIAS = ['ㄧ', 'ㄨ', 'ㄩ'] as const;

export const FINALS = [
  'ㄚ',
  'ㄛ',
  'ㄜ',
  'ㄝ',
  'ㄞ',
  'ㄟ',
  'ㄠ',
  'ㄡ',
  'ㄢ',
  'ㄣ',
  'ㄤ',
  'ㄥ',
  'ㄦ',
] as const;

export const TONE_MARKS: Record<string, Tone> = {
  '': 1,
  ˊ: 2,
  ˇ: 3,
  ˋ: 4,
  '˙': 5,
};

const initialSet = new Set<string>(INITIALS);
const medialSet = new Set<string>(MEDIAS);
const finalSet = new Set<string>(FINALS);

export function isInitial(s: string): boolean {
  return initialSet.has(s);
}
export function isMedial(s: string): boolean {
  return medialSet.has(s);
}
export function isFinal(s: string): boolean {
  return finalSet.has(s);
}
export function toneOf(mark: string): Tone | undefined {
  return TONE_MARKS[mark];
}

/** 詞讀音來源標記。新增資料源必須在此登記並附授權。 */
export type Provenance = 'moedict' | 'libchewing' | 'user' | 'mined';

/**
 * 詞庫條目：一個詞與它的全部合法讀音。
 * canonical 形如「ㄐㄧㄣ ㄊㄧㄢ」（音節以空白分隔、輕聲 ˙ 後綴）。
 */
export interface LexiconEntry {
  readonly word: string;
  /** 每個元素為一組讀音的音節序列（已正規化） */
  readonly readings: readonly (readonly string[])[];
  readonly freq?: number;
  readonly provenance: readonly Provenance[];
}
