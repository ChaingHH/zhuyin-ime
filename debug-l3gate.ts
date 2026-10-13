// 單音節更正限制（altSingleOnlyIfEmpty）的準確率代價：口語前 200 句、預設 L3 代價
import { Channel } from './packages/core/src/index.js';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';
import { injectNoise, rng } from './packages/cli/src/noise.js';

const rt = await loadRuntime();
const legal = [...rt.legalSyllables];
const ss = (await loadEvalSamples('eval/colloquial.jsonl')).slice(0, 200);
const noisy = ss.map((s, i) => injectNoise(s.syllables, legal, { key: 0.03, cognitive: 0.03 }, rng(1000 + i)));
const ch = new Channel(legal);
const dec = rt.decoder as unknown as { altSingleOnlyIfEmpty: boolean };
for (const only of [true, false]) {
  dec.altSingleOnlyIfEmpty = only;
  const acc = (inputs: string[][]): string =>
    ((ss.filter((s, i) => rt.decoder.decode(inputs[i]!, { alternatives: inputs[i]!.map((x) => ch.expand(x)) })[0]?.words.join('') === s.text).length / ss.length) * 100).toFixed(1);
  console.log(`單音節僅查無時=${only}  乾淨 ${acc(ss.map((s) => s.syllables))}  有錯 ${acc(noisy)}`);
}
process.exit(0);
