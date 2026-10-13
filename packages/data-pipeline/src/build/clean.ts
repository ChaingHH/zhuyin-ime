import * as OpenCC from 'opencc-js';

const toTwp = OpenCC.Converter({ from: 'cn', to: 'twp' });

const CJK = /[\u3400-\u9FFF]/;
const CJK_ALL = /^[\u3400-\u9FFF\u3000-\u303F\uFF00-\uFFEF，。！？；：、「」『』（）·…％-]*$/;

/** 句子清洗：OpenCC s2twp 轉換後過濾非中文主體、過短過長者。 */
export function cleanSentence(raw: string): string | null {
  const converted = toTwp(raw).trim();
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
