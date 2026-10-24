// 退回式模型 vs 未剪枝 KN 計數模型：沿評測句的正解斷詞逐詞比 log 機率，列出差最多的查詢。
// NODE_OPTIONS=--max-old-space-size=12000 npx tsx debug-bo-diff.ts [bits]
import { LanguageModel, buildBackoff, scoreNgrams } from './packages/lm/src/index.js';
import { loadEvalSamples } from './packages/data-pipeline/src/build/evalset.js';

const SRC = 'data/models/lm.tsv';
const bits = Number(process.argv[2] ?? 16) as 8 | 16;
const full = await LanguageModel.load(SRC, { minBi: 1, minTri: 1 });
const scores = await scoreNgrams(full, SRC);
const bo = await buildBackoff(full, SRC, scores, { theta: -1, bits, fpBits: 32 });

for (const [name, x] of [
  ['word', bo.word],
  ['char', bo.char],
] as const)
  for (const t of ['uni', 'bi', 'tri'] as const)
    x[t].luts.forEach((l, c) =>
      console.log(`${name}.${t}[${c}] 範圍 ${l[0]!.toFixed(2)} .. ${l[l.length - 1]!.toFixed(2)}，${l.length} 格`),
    );

const BOS = LanguageModel.BOS;
const diffs: Array<[number, string]> = [];
for (const f of ['colloquial', 'written']) {
  let sum = 0;
  let n = 0;
  for (const s of await loadEvalSamples(`eval/${f}.jsonl`)) {
    let [w1, w2] = ['', '']; // 詞級句首是空字串（訓練與解碼器都是）
    for (const w of [...s.tokens, '\u0003']) {
      const a = full.wordLogProb(w, w1, w2);
      const b = bo.wordLogProb(w, w1, w2);
      sum += Math.abs(a - b);
      n++;
      diffs.push([Math.abs(a - b), `${f} word P(${w}|${w1} ${w2}) kn=${a.toFixed(3)} bo=${b.toFixed(3)}`]);
      [w1, w2] = [w2, w];
    }
    let [c1, c2] = [BOS, BOS];
    for (const c of [...s.text, '\u0003']) {
      const a = full.charLogProb(c, c1, c2);
      const b = bo.charLogProb(c, c1, c2);
      sum += Math.abs(a - b);
      n++;
      diffs.push([Math.abs(a - b), `${f} char P(${c}|${c1} ${c2}) kn=${a.toFixed(3)} bo=${b.toFixed(3)}`]);
      [c1, c2] = [c2, c];
    }
  }
  console.log(`${f}：平均 |差| ${(sum / n).toFixed(4)}（${n} 次查詢）`);
}
diffs.sort((x, y) => y[0] - x[0]);
for (const [, line] of diffs.slice(0, 30)) console.log(line);
