/**
 * 產生「非台灣繁體字」字表：packages/core/src/nontrad.ts 與 native/src/nontrad.txt（兩邊同一份）。
 *
 * 判斷：OpenCC 的 STCharacters（簡→繁）、JPShinjitaiCharacters（日本新字體→舊字體）、
 * TWVariants（OpenCC 繁體→台灣字形，例如 爲→為、裏→裡）任一表會把這個字換成別的字，就是候選。
 * TWVariants 的目標字（台灣字形）不擋。再豁免教育部辭典（萌典）多字詞用到的字：里、台、干、才、云 這類同時是合法繁體的字會出現在
 * 萌典的詞裡（一日千里、天台）。只看多字詞，因為萌典有簡化字的單字條目（无、广、机）。
 * opencc-js 的字表一個字只留第一個候選，所以不能用「轉換後有沒有變」判斷（里→裏、台→臺 會被誤殺）。
 *
 * 用法（repo 根目錄）：npx tsx packages/data-pipeline/scripts/build-nontrad.ts [lexicon.jsonl]
 * 改字表後 runtime 會自動重建 lexicon.bin（NONTRAD_SINCE 比 bin 新）。
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** 台灣常用、不該擋的字：樑（上樑）、庄（南庄、舊庄 等台灣地名）、癡（教育部正字，萌典用 痴）、筑（筑波、筑紫） */
const ALLOW = new Set([...'樑庄癡筑']);

const DICT = '../../../node_modules/opencc-js/dist/esm-lib/dict/';
const lexFile = process.argv[2] ?? 'data/processed/lexicon.jsonl';

const moe = new Set<string>();
for (const line of readFileSync(lexFile, 'utf8').split('\n')) {
  if (!line) continue;
  const e = JSON.parse(line) as { word: string; provenance: string[] };
  const chars = [...e.word];
  if (chars.length > 1 && e.provenance.includes('moedict')) for (const c of chars) moe.add(c);
}

const pairs = async (f: string) =>
  ((await import(`${DICT}${f}.js`)).default as string).split('|').map((p) => p.split(' '));
// TWVariants 的目標字就是台灣字形（脣→唇、裏→裡），不能因為 STCharacters 把 唇 當簡化字而擋掉
const twForms = new Set((await pairs('TWVariants')).map(([, v]) => v));
const bad = new Set<string>();
for (const f of ['STCharacters', 'JPShinjitaiCharacters', 'TWVariants']) {
  for (const [k, v] of await pairs(f)) {
    if (!k || !v || k === v || [...k].length !== 1) continue;
    if (!moe.has(k) && !ALLOW.has(k) && !twForms.has(k)) bad.add(k);
  }
}
const chars = [...bad].sort().join('');

writeFileSync('native/src/nontrad.txt', chars);
writeFileSync(
  'packages/core/src/nontrad.ts',
  `// 由 packages/data-pipeline/scripts/build-nontrad.ts 產生，不要手改（native/src/nontrad.txt 是同一份）。
/** 非台灣繁體字（簡化字、日本新字體、非台灣字形），${bad.size} 字 */
export const NON_TRADITIONAL_CHARS = new Set([...'${chars}']);

/** 字表產生時間（ms）：lexicon.bin 比它舊就重建 */
export const NONTRAD_SINCE = ${Date.now()};

/** 詞裡沒有非台灣繁體字。詞典、使用者詞入格前都要過這關，輸出才不會出現簡體／日文字形。 */
export function isTraditionalWord(word: string): boolean {
  for (const c of word) if (NON_TRADITIONAL_CHARS.has(c)) return false;
  return true;
}
`,
);
console.log(
  `非繁體字 ${bad.size} 個（萌典豁免後）→ packages/core/src/nontrad.ts、native/src/nontrad.txt`,
);
