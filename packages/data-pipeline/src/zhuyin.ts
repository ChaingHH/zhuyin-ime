import { type Syllable, type Tone, isInitial, isMedial, isFinal, toneOf } from '@zhuyin/core';

/** 輕聲 ˙ 的書寫位置：萌典前綴（˙ㄇㄜ）、libchewing 後後綴（ㄇㄜ˙）。 */
export type ToneMarkConvention = 'prefix' | 'suffix';

export interface ParsedSyllable {
  syllable: Syllable;
  /** 正規化字串：C-M-F + 聲調後綴（1 聲無標記） */
  canonical: string;
}

const TONE_MARK_CHARS = ['ˊ', 'ˇ', 'ˋ', '˙'] as const;

/**
 * 將單一音節字串解析為四槽結構。
 * 回傳 null 表示含有不可分類的符號或槽位衝突（例如兩個聲母）——
 * 這類輸入由呼叫端決定丟棄或送 L3，解析層不做容錯猜測。
 */
export function parseSyllable(raw: string, convention: ToneMarkConvention): ParsedSyllable | null {
  let text = raw.trim();
  if (!text) return null;

  let tone: Tone = 1;
  if (convention === 'prefix' && text.startsWith('˙')) {
    tone = 5;
    text = text.slice(1);
  }
  while (text.length > 0) {
    const last = text[text.length - 1] as string;
    if (!(TONE_MARK_CHARS as readonly string[]).includes(last)) break;
    const t = toneOf(last);
    if (t === undefined || (t !== 5 && tone !== 1)) return null;
    // 後綴式：最後出現的聲調標記為準；前綴式 ˙ 已先取走
    if (convention === 'prefix' && t !== 5) tone = t;
    if (convention === 'suffix') tone = t;
    text = text.slice(0, -1);
  }

  let initial: string | undefined;
  let medial: string | undefined;
  let final: string | undefined;
  for (const glyph of text) {
    if (isInitial(glyph)) {
      if (initial !== undefined) return null;
      initial = glyph;
    } else if (isMedial(glyph)) {
      if (medial !== undefined || final !== undefined) return null;
      medial = glyph;
    } else if (isFinal(glyph)) {
      if (final !== undefined) return null;
      final = glyph;
    } else {
      return null;
    }
  }

  const syllable: Syllable = { initial, medial, final, tone };
  return { syllable, canonical: canonicalSyllable(syllable) };
}

export function canonicalSyllable(s: Syllable): string {
  const marks: Record<Tone, string> = { 1: '', 2: 'ˊ', 3: 'ˇ', 4: 'ˋ', 5: '˙' };
  return `${s.initial ?? ''}${s.medial ?? ''}${s.final ?? ''}${marks[s.tone]}`;
}

/** 空韻：捲舌音與舌尖音聲母可獨自構成音節（ㄓㄔㄕㄖㄗㄘㄙ），如 ㄕˋ（是）、ㄗ˙（子）。 */
const APICAL_INITIALS = new Set(['ㄓ', 'ㄔ', 'ㄕ', 'ㄖ', 'ㄗ', 'ㄘ', 'ㄙ']);

/**
 * 結構合法性：
 * 1. 有韻母或介音（介音可兼韻核：ㄍㄨˇ、ㄧˋ）
 * 2. 或為空韻音節（ㄕˋ、ㄗ˙）
 * 純聲母 ㄅ、單獨聲調符號不合法。完整音韻合法表在 Phase 1 由本表種子擴充。
 */
export function isStructurallyValid(s: Syllable): boolean {
  if (s.final !== undefined || s.medial !== undefined) return true;
  return s.initial !== undefined && APICAL_INITIALS.has(s.initial);
}

/**
 * 解析整串音節（空白分隔）。任一音節不可解析 → 整串回 null。
 * 自動處理萌典的黏連兒化（ㄊㄡˊㄦ → ㄊㄡˊ ㄦ）：ㄦ 直接跟在前一音節後時切開，
 * 但「ㄦ」本身為音節（ㄦˊ=而）時不切。˙ 在前綴式屬於後面的 ㄦ（ㄊㄡ˙ㄦ → ㄊㄡ ˙ㄦ），
 * 在後綴式屬於前一音節（ㄇㄜ˙ㄦ → ㄇㄜ˙ ㄦ）。
 */
export function parseSyllableSequence(
  raw: string,
  convention: ToneMarkConvention,
): ParsedSyllable[] | null {
  const normalized =
    convention === 'prefix'
      ? raw.replace(/(?<=[\u3105-\u312F\u02CA\u02C7\u02CB])(˙?)ㄦ/g, ' $1ㄦ')
      : raw.replace(/(?<=[\u3105-\u312F\u02CA\u02C7\u02CB\u02D9])ㄦ/g, ' ㄦ');
  const parts = normalized.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const out: ParsedSyllable[] = [];
  for (const part of parts) {
    const parsed = parseSyllable(part, convention);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

/**
 * 一個 bopomofo 欄位可能以全形逗號／頓號列出多個讀音，或用（語音）（讀音）（又音）等標註分開
 * （「（語音）ㄕㄡˊ （讀音）ㄕㄨˊ」）——標註本身當分隔符，切成多串。
 */
export function splitAlternativeReadings(raw: string): string[] {
  return raw
    .split(/[，、]|[（(][^）)]*[）)]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function canonicalSequence(syls: readonly { canonical: string }[]): string {
  return syls.map((s) => s.canonical).join(' ');
}
