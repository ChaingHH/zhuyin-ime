// 量 L6 worker 的 onnxruntime 執行緒數對「重排延遲」與「同時進行的 L5 解碼延遲」的影響
// npx tsx debug-threads.ts [N=50] [threads=0,2,4,...]（先 npm run build；0=ORT 預設）
import { performance } from 'node:perf_hooks';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';
import { RerankWorker } from './packages/rerank/dist/index.js';

const N = Number(process.argv[2] ?? 50);
const counts = (process.argv[3] ?? '0,2,4,6,8,10,12,14').split(',').map(Number);
const rt = await loadRuntime();
const ss = (await loadEvalSamples('eval/colloquial.jsonl')).slice(0, N);
const nb = 28;
const pathsOf = ss.map((s) => rt.decoder.decode(s.syllables, { nBest: nb }));
const q = (xs: number[], p: number): number => {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))] ?? NaN;
};
const fmt = (xs: number[]): string =>
  `p50 ${q(xs, 0.5).toFixed(0)} / p95 ${q(xs, 0.95).toFixed(0)}ms`;
const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

// 基準：沒有重排時的 L5 解碼
const idle: number[] = [];
for (const s of ss) {
  const t0 = performance.now();
  rt.decoder.decode(s.syllables, { nBest: nb });
  idle.push(performance.now() - t0);
}
console.log(`L5 單獨：${fmt(idle)}`);

let ref: string[] | undefined;
for (const t of counts) {
  // gapThreshold 0：每句都跑 BERT，才量得到競爭
  const rr = await RerankWorker.create({
    weight: 0.5,
    maxCandidates: 16,
    flipMargin: 0.75,
    numThreads: t,
  });
  await rr.rerank(pathsOf[0]!); // 暖機
  const rer: number[] = [];
  const dec: number[] = [];
  const top: string[] = [];
  for (let i = 0; i < ss.length; i++) {
    let done = false;
    const t0 = performance.now();
    const p = rr.rerank(pathsOf[i]!).then((r) => {
      rer.push(performance.now() - t0);
      top.push(r[0]!.words.join(''));
      done = true;
    });
    // 重排期間主執行緒不斷做 L5 解碼（模擬使用者繼續打字）
    for (let j = i; !done; j = (j + 1) % ss.length) {
      const d0 = performance.now();
      rt.decoder.decode(ss[j]!.syllables, { nBest: nb });
      if (!done) dec.push(performance.now() - d0);
      await yieldLoop();
    }
    await p;
  }
  await rr.terminate();
  ref ??= top;
  const diff = top.filter((x, i) => x !== ref![i]).length;
  console.log(
    `threads=${String(t || 'ORT預設').padEnd(6)} 重排 ${fmt(rer)}  同時 L5 ${fmt(dec)} (n=${dec.length})  首選與第一組不同 ${diff}`,
  );
}
process.exit(0);
