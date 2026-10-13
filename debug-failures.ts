import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';
import { PllReranker } from './packages/rerank/src/reranker.js';
import { performance } from 'perf_hooks';

const files = process.argv.includes('--written')
  ? ['eval/written.jsonl']
  : ['eval/colloquial.jsonl'];

const { decoder } = await loadRuntime({ a: 1.2, gamma: 0.3 });
const rr = await PllReranker.create({ weight: 0.25, maxCandidates: 12 });
const samples = await loadEvalSamples(files[0]);
console.log(`[FAILURES] ${samples.length} samples, rerank=quality(deck28/maxc12/flip0.75)\n`);

let failCount = 0;
for (const s of samples) {
  const paths = decoder.decode(s.syllables, { nBest: 28 });
  const before = paths[0]?.words.join('') ?? '';
  const rp = await rr.rerank(paths);
  const after = rp.paths[0]?.words.join('') ?? '';
  if (after === s.text) continue;
  failCount++;
  if (failCount > 30) break;
  const seg = (w: string): string => {
    const re = /(\p{Script=Han}+)|(\p{L}+)|(\p{N}+)|./gu;
    return [...w.matchAll(re)].map(m => m[1] ? `[${m[1]}]` : m[0]).join('');
  };
  console.log(`--- #${failCount}`);
  console.log(`  ref : ${seg(s.text)}`);
  console.log(`  L5  : ${seg(before)}`);
  console.log(`  L6  : ${seg(after)}`);
  if (rp.paths[0] && paths[0]) {
    const lmDiff = rp.paths[0].score - paths[0].score;
    const pll0 = rp.pll?.[rp.plan.candidateIdx[0]] ?? NaN;
    const pll1 = rp.pll?.[rp.plan.candidateIdx[1]] ?? NaN;
    console.log(`  pll0=${pll0.toFixed(2)} pll1=${pll1.toFixed(2)} lmDiff=${lmDiff.toFixed(2)}`);
  }
  // 標註哪些字錯
  const refC = [...s.text];
  const outC = [...after];
  const mismatches: string[] = [];
  for (let i = 0; i < Math.max(refC.length, outC.length); i++) {
    if (refC[i] !== outC[i]) mismatches.push(`${i}:${refC[i] ?? '∅'}→${outC[i] ?? '∅'}`);
  }
  console.log(`  diff: ${mismatches.join(' ')}`);
}
console.log(`\n[summary] ${failCount} failures in ${samples.length} samples (${(failCount / samples.length * 100).toFixed(1)}%)`);
