// L7 非同步替換的實機驗證：找一句 L6 改對的句子，以真實節奏打字並記錄畫面
import { performance } from 'node:perf_hooks';
import { syllableToKeyCodes } from './packages/core/src/index.js';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';
import { ImeEngine } from './packages/cli/src/engine.js';
import { PllReranker } from './packages/rerank/src/reranker.js';

const rt = await loadRuntime();
const rr = await PllReranker.create({ weight: 0.5, maxCandidates: 16, gapThreshold: 6, flipMargin: 0.75, charFreq: (ch) => rt.lm.char.uni.get(ch) ?? 0 });
const samples = await loadEvalSamples('eval/colloquial.jsonl');
const pick = [];
for (const s of samples) {
  const paths = rt.decoder.decode(s.syllables, { nBest: 28 });
  if (paths[0]!.words.join('') === s.text) continue;
  if ((await rr.rerank(paths)).paths[0]!.words.join('') === s.text) pick.push(s);
  if (pick.length === 2) break;
}
const t0 = performance.now();
const ms = (): string => `${(performance.now() - t0).toFixed(0).padStart(5)}ms`;
for (const s of pick) {
  console.log(`\n正解：${s.text}`);
  const engine = new ImeEngine(rt.decoder, rt.legalSyllables, undefined, undefined, {
    rerank: async (p) => (await rr.rerank(p)).paths,
    onUpdate: (st) => console.log(`${ms()} [L6 替換] ${st.composition}`),
  });
  for (const syl of s.syllables) {
    let st;
    for (const code of syllableToKeyCodes(syl)) st = engine.onKey({ code, timestampMs: 0 });
    console.log(`${ms()} [L5 顯示] ${st!.composition}`);
    await new Promise((r) => setTimeout(r, 150)); // 人打一個音節約 150–300ms
  }
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`${ms()} 送出：${engine.commit()}`);
}
process.exit(0);
