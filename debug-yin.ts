import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';
import { PllReranker } from './packages/rerank/src/reranker.js';

const { decoder } = await loadRuntime({ a: 1.2, gamma: 0.3 });
const samples = await loadEvalSamples('eval/colloquial.jsonl');
const s = samples.find((x) => x.text.includes('陰莖增大'))!;
console.log('syll:', JSON.stringify(s.syllables));
const idx = decoder as unknown as {
  index: Map<string, { word: string }[]>;
};
for (const key of ['ㄧㄣ ㄐㄧㄥ', 'ㄗㄥ ㄉㄚˋ']) {
  const list = idx.index.get(key);
  console.log(`key[${key}]:`, list ? list.slice(0, 6).map((e) => e.word) : '無');
}
const wide = decoder.decode(s.syllables, { nBest: 28 });
let found = -1;
wide.forEach((p, i) => {
  const j = p.words.join('|');
  if (j.includes('陰莖') || j.includes('增大')) found = i;
  if (i < 6 || found === i)
    console.log(`${String(i + 1).padStart(2)} ${p.score.toFixed(1)} ${j}`);
});
const rr = await PllReranker.create({ weight: 0.25, maxCandidates: 12 });
const r = await rr.rerank(wide);
r.plan.candidateIdx.forEach((oi, k) => {
  const joined = wide[oi]!.words.join('|');
  const after = r.paths.find((x) => x.words.join('|') === joined)!;
  console.log(`sel orig${oi + 1} pll=${(r.pll[k] ?? NaN).toFixed(2)} 總=${after.score.toFixed(2)} ${joined}`);
});
console.log('top1:', r.paths[0]!.words.join(''));
