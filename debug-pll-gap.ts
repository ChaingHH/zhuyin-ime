import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';
import { PllReranker } from './packages/rerank/src/reranker.js';

const files = process.argv.includes('--written')
  ? ['eval/written.jsonl']
  : ['eval/colloquial.jsonl'];

const { decoder } = await loadRuntime({ a: 1.2, gamma: 0.3 });
const rr = await PllReranker.create({ weight: 0.25, maxCandidates: 12 });

const samples = await loadEvalSamples(files[0]);
let harmful = 0, beneficial = 0;

for (const s of samples) {
  const paths = decoder.decode(s.syllables, { nBest: 28 });
  const lmTop = paths[0]?.words.join('') ?? '';
  const lmGap = paths.length >= 2 ? paths[0]!.score - paths[1]!.score : 999;
  const rp = await rr.rerank(paths);
  const after = rp.paths[0]?.words.join('') ?? '';
  if (lmTop === after) continue;
  const isHarmful = lmTop === s.text && after !== s.text;
  const isBeneficial = lmTop !== s.text && after === s.text;
  if (isHarmful) {
    harmful++;
    if (harmful <= 15) console.log(`HARMFUL lmGap=${lmGap.toFixed(2)} ref=${s.text} LM=${lmTop} PLL=${after}`);
  }
  if (isBeneficial) {
    beneficial++;
    if (beneficial <= 5) console.log(`BENEFICIAL lmGap=${lmGap.toFixed(2)} ref=${s.text} LM=${lmTop} PLL=${after}`);
  }
}
console.log(`\nBeneficial: ${beneficial}, Harmful: ${harmful}`);
