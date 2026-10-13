import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';
import { PllReranker } from './packages/rerank/src/reranker.js';

const files = process.argv.includes('--written')
  ? ['eval/written.jsonl']
  : ['eval/colloquial.jsonl'];

const { decoder } = await loadRuntime({ a: 1.2, gamma: 0.3 });
const rr = await PllReranker.create({ weight: 0.25, maxCandidates: 12, polySingle: decoder.polySingleChars });

const samples = await loadEvalSamples(files[0]);
let harmfulFlips = 0;
let totalFlips = 0;
let totalCorrect = 0;

for (const s of samples) {
  const paths = decoder.decode(s.syllables, { nBest: 28 });
  const lmTop = paths[0]?.words.join('') ?? '';
  const rp = await rr.rerank(paths);
  const after = rp.paths[0]?.words.join('') ?? '';
  if (lmTop === after) continue; // PLL didn't flip
  if (lmTop === s.text && after !== s.text) {
    // PLL flipped CORRECT to WRONG
    harmfulFlips++;
    if (harmfulFlips <= 10) {
      console.log(`HARMFUL: ref=${s.text}`);
      console.log(`  LM=${lmTop}`);
      console.log(`  PLL=${after}`);
      console.log(`  pll0=${rp.pll?.[rp.plan.candidateIdx[0]]?.toFixed(2)} pll1=${rp.pll?.[rp.plan.candidateIdx[1]]?.toFixed(2)}`);
    }
  }
  totalFlips++;
  if (after === s.text) totalCorrect++;
}

console.log(`\n--- Summary ---`);
console.log(`Total flips: ${totalFlips}/${samples.length}`);
console.log(`Flips to correct: ${totalCorrect}`);
console.log(`Harmful flips (correct→wrong): ${harmfulFlips}`);
