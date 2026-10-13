// 量 L6 重排期間 Node 事件迴圈被卡住多久（非同步替換是否真的不擋打字）
// npx tsx debug-block.ts [--worker]；--worker 用 dist 的 RerankWorker（先 npm run build）
import { performance } from 'node:perf_hooks';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';
import { PllReranker } from './packages/rerank/src/reranker.js';
import { RerankWorker } from './packages/rerank/dist/index.js';

const rt = await loadRuntime();
const opts = { weight: 0.5, maxCandidates: 16, flipMargin: 0.75 };
const pll = await PllReranker.create(opts);
const rr = process.argv.includes('--worker')
  ? await RerankWorker.create(opts)
  : { rerank: async (p: Parameters<PllReranker['rerank']>[0]) => (await pll.rerank(p)).paths };
const ss = (await loadEvalSamples('eval/colloquial.jsonl')).slice(0, 20);
let maxGap = 0;
let last = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  maxGap = Math.max(maxGap, now - last);
  last = now;
}, 2);
for (const s of ss) {
  const paths = rt.decoder.decode(s.syllables, { nBest: 28 });
  maxGap = 0;
  last = performance.now();
  const t0 = performance.now();
  await rr.rerank(paths);
  const dt = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 10)); // 讓計時器補記卡住的那段
  console.log(`rerank ${dt.toFixed(0)}ms  事件迴圈最長卡住 ${maxGap.toFixed(0)}ms`);
}
clearInterval(timer);
process.exit(0);
