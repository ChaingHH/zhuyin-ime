/**
 * Part A 目標清單：評測句裡出現挖到的詞（mined.jsonl）、且該詞位置解錯的情況，外加手列的日常複合詞。
 * 用法：npx tsx debug-mined-targets.ts <mined.jsonl>（目前 data/ 的詞典與 LM）
 */
import { readFile } from 'node:fs/promises';
import { loadEvalSamples, loadRuntime } from './packages/cli/src/runtime.js';

const minedFile = process.argv[2]!;
const mined = new Set<string>();
for (const l of (await readFile(minedFile, 'utf8')).split('\n'))
  if (l) mined.add((JSON.parse(l) as { word: string }).word);

const { decoder } = await loadRuntime({ a: 1, gamma: 0.5 });
const hits: string[] = [];
let wrong = 0;
let total = 0;
for (const f of ['eval/colloquial.jsonl', 'eval/written.jsonl']) {
  for (const s of await loadEvalSamples(f)) {
    const out = decoder.decode(s.syllables, { nBest: 28 })[0]?.words.join('') ?? '';
    const ref = [...s.text];
    const got = [...out];
    for (let i = 0; i < ref.length; i++) {
      for (let len = 2; len <= 4 && i + len <= ref.length; len++) {
        const w = ref.slice(i, i + len).join('');
        if (!mined.has(w)) continue;
        total++;
        const ok = got.slice(i, i + len).join('') === w;
        if (!ok) {
          wrong++;
          hits.push(`${w}\t${got.slice(i, i + len).join('')}\t${s.text}`);
        }
      }
    }
  }
}
console.log(`[mined-in-eval] 出現 ${total}，解錯 ${wrong}`);
for (const h of hits) console.log(h);

// 手列：日常複合詞（狀態欄不在語料裡，挖不到；列著看）
const manual: [string, string[]][] = [
  ['狀態欄', ['ㄓㄨㄤˋ', 'ㄊㄞˋ', 'ㄌㄢˊ']],
  ['狀態列', ['ㄓㄨㄤˋ', 'ㄊㄞˋ', 'ㄌㄧㄝˋ']],
  ['工具列', ['ㄍㄨㄥ', 'ㄐㄩˋ', 'ㄌㄧㄝˋ']],
  ['網址列', ['ㄨㄤˇ', 'ㄓˇ', 'ㄌㄧㄝˋ']],
  ['推文', ['ㄊㄨㄟ', 'ㄨㄣˊ']],
  ['板友', ['ㄅㄢˇ', 'ㄧㄡˇ']],
];
for (const [w, syl] of manual) {
  const out = decoder.decode(syl, { nBest: 4 })[0]?.words.join('');
  console.log(`[manual] ${w} → ${out} ${out === w ? 'ok' : 'X'}`);
}
