import * as OpenCC from 'opencc-js';

const toTwp = OpenCC.Converter({ from: 'cn', to: 'twp' });

const CJK = /[\u3400-\u9FFF]/;
// NFKC 後全形英數標點都成了半形：允許 ASCII 標點與空白，英數不允許（全形、半形一致對待）
const CJK_ALL = /^[\u3400-\u9FFF\u3000-\u303F\x20-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E、「」『』·]*$/;

/**
 * 句子清洗：先 NFKC（相容表意字→統一碼字、全形英數標點→半形），
 * 再 OpenCC s2twp 轉換，過濾非中文主體、過短過長者。
 */
export function cleanSentence(raw: string): string | null {
  const converted = toTwp(raw.normalize('NFKC')).trim();
  if (converted.length < 6 || converted.length > 120) return null;
  let cjk = 0;
  for (const ch of converted) if (CJK.test(ch)) cjk++;
  if (cjk / converted.length < 0.7) return null;
  if (!CJK_ALL.test(converted)) return null;
  return converted;
}

/** 切句：。！？；與換行為界。 */
export function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?；;\n\r]+/)
    .map((s) => s.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''))
    .filter(Boolean);
}
