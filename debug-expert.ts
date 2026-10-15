// 兩個 LM 專家各自的貢獻：預設 a=1 γ=0.5、只用詞級（γ=0）、只用字級（a=0）。只到 L5。
// npx tsx debug-expert.ts
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';

const rt = await loadRuntime({ a: 1, gamma: 0.5 });
const cfg = rt.decoder.config as { a: number; gamma: number };
const sets = {
  colloquial: await loadEvalSamples('eval/colloquial.jsonl'),
  written: await loadEvalSamples('eval/written.jsonl'),
};
for (const [a, gamma] of [
  [1, 0.5],
  [1, 0],
  [0, 1],
] as const) {
  cfg.a = a;
  cfg.gamma = gamma;
  const row = [`a=${a} γ=${gamma}`];
  for (const [name, ss] of Object.entries(sets)) {
    const ok = ss.filter((s) => rt.decoder.decode(s.syllables, { nBest: 1 })[0]?.words.join('') === s.text).length;
    row.push(`${name} 句 ${((ok / ss.length) * 100).toFixed(1)}`);
  }
  console.log(row.join(' | '));
}
