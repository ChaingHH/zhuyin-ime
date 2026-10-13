// L3 解碼速度探針：不同 maxAlts / altEntryCap 下的單句耗時（30 句有錯口語）
import { performance } from 'node:perf_hooks';
import { Channel } from './packages/core/src/index.js';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';
import { injectNoise, rng } from './packages/cli/src/noise.js';

const rt = await loadRuntime();
const legal = [...rt.legalSyllables];
const ss = (await loadEvalSamples('eval/colloquial.jsonl')).slice(0, 30);
const noisy = ss.map((s, i) => injectNoise(s.syllables, legal, { key: 0.03, cognitive: 0.03 }, rng(1000 + i)));
const dec = rt.decoder as unknown as { altEntryCap: number; altSingleOnlyIfEmpty: boolean };
for (const [maxAlts, cap, only] of [[0, 0, true], [24, 8, true], [24, 8, false], [12, 4, true]] as const) {
  dec.altSingleOnlyIfEmpty = only;
  const ch = maxAlts ? new Channel(legal, { maxAlts }) : null;
  dec.altEntryCap = cap;
  const t: number[] = [];
  for (const obs of noisy) {
    const t0 = performance.now();
    rt.decoder.decode(obs, { alternatives: ch ? obs.map((x) => ch.expand(x)) : undefined });
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  console.log(`maxAlts=${maxAlts} altEntryCap=${cap} 單音節僅查無時=${only}  p50 ${t[15]!.toFixed(0)}ms  max ${t[29]!.toFixed(0)}ms`);
}
process.exit(0);
