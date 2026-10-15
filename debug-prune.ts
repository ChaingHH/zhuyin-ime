// 剪枝／量化實驗：一個設定一個行程（量 RSS 要乾淨）。只跑到 L5。
// ZHUYIN_LM_MIN_BI=2 ZHUYIN_LM_MIN_TRI=3 ZHUYIN_LM_QUANT=16 node --expose-gc --import tsx debug-prune.ts
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';

const t0 = Date.now();
const rt = await loadRuntime({ a: 1, gamma: 0.5 });
const loadS = (Date.now() - t0) / 1000;
(globalThis as { gc?: () => void }).gc?.();
const mb = (b: number): string => (b / 2 ** 20).toFixed(0);
const tables = [rt.lm.word.bi, rt.lm.word.tri, rt.lm.char.bi, rt.lm.char.tri];
const row = [
  `bi>=${process.env['ZHUYIN_LM_MIN_BI'] ?? 2}`,
  `tri>=${process.env['ZHUYIN_LM_MIN_TRI'] ?? 3}`,
  `q=${process.env['ZHUYIN_LM_QUANT'] ?? 8}`,
  `rss ${mb(process.memoryUsage().rss)}MB`,
  `tables ${mb(tables.reduce((s, t) => s + t.bytes, 0))}MB`,
  `entries ${(tables.reduce((s, t) => s + t.size, 0) / 1e6).toFixed(1)}M`,
  `load ${loadS.toFixed(0)}s`,
];
for (const f of ['colloquial', 'written']) {
  const ss = await loadEvalSamples(`eval/${f}.jsonl`);
  let ok = 0;
  let chars = 0;
  let total = 0;
  const t1 = performance.now();
  for (const s of ss) {
    const out = rt.decoder.decode(s.syllables, { nBest: 1 })[0]?.words.join('') ?? '';
    if (out === s.text) ok++;
    const a = [...out];
    const b = [...s.text];
    total += b.length;
    for (let i = 0; i < b.length; i++) if (a[i] === b[i]) chars++;
  }
  const ms = (performance.now() - t1) / ss.length;
  row.push(
    `${f} 句 ${((ok / ss.length) * 100).toFixed(1)} 字 ${((chars / total) * 100).toFixed(1)} ${ms.toFixed(0)}ms`,
  );
}
console.log(row.join(' | '));
