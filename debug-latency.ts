// 本引擎的逐鍵延遲：評測句的大千按鍵逐一送進 ImeEngine（只到 L5，不載使用者資料），
// 量每次 onKey 的耗時與整段 CPU 時間；L3 關／開各一次。和 debug-ime-bench.ps1 的 PIME／微軟數字對照。
// ZHUYIN_NO_USER=1 npx tsx debug-latency.ts [句數上限]
import { Channel, syllableToKeyCodes } from '@zhuyin/core';
import { ImeEngine } from './packages/cli/src/engine.js';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';

const rt = await loadRuntime({ a: 1, gamma: 0.5 });
const limit = Number(process.argv[2] ?? Infinity);
const samples = [
  ...(await loadEvalSamples('eval/colloquial.jsonl')),
  ...(await loadEvalSamples('eval/written.jsonl')),
].slice(0, limit);
const pct = (xs: number[], p: number): number => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

for (const l3 of [false, true]) {
  const engine = new ImeEngine(rt.decoder, rt.legalSyllables);
  if (l3) engine.channel = new Channel(rt.legalSyllables);
  const lat: number[] = [];
  let ok = 0;
  const cpu0 = process.cpuUsage();
  for (const s of samples) {
    for (const code of s.syllables.flatMap((syl) => syllableToKeyCodes(syl))) {
      const t = performance.now();
      engine.onKey({ code, timestampMs: 0 });
      lat.push(performance.now() - t);
    }
    if (engine.commit() === s.text) ok++;
  }
  const cpu = process.cpuUsage(cpu0);
  lat.sort((x, y) => x - y);
  const f = (x: number): string => x.toFixed(2);
  console.log(
    `L3 ${l3 ? '開' : '關'} | ${samples.length} 句 ${lat.length} 鍵 | 句 ${((ok / samples.length) * 100).toFixed(1)}% | ` +
      `每鍵 p50 ${f(pct(lat, 0.5))} p95 ${f(pct(lat, 0.95))} p99 ${f(pct(lat, 0.99))} max ${f(lat.at(-1)!)} ms | ` +
      `CPU ${((cpu.user + cpu.system) / 1000 / lat.length).toFixed(2)} ms/鍵 | RSS ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)}MB`,
  );
}

// 打字後的記憶體：V8 留著的垃圾空間 vs 真正存活的資料
const mbs = (b: number): string => `${(b / 2 ** 20).toFixed(0)}MB`;
const m0 = process.memoryUsage();
(await import('node:v8')).default.setFlagsFromString('--expose-gc');
const tg = performance.now();
((await import('node:vm')).default.runInNewContext('gc') as (o: object) => void)({
  type: 'major',
  execution: 'sync',
  flavor: 'last-resort',
});
const m1 = process.memoryUsage();
console.log(
  `打字後 rss ${mbs(m0.rss)} heap ${mbs(m0.heapUsed)}/${mbs(m0.heapTotal)} → GC（${(performance.now() - tg).toFixed(0)}ms）後 rss ${mbs(m1.rss)} heap ${mbs(m1.heapUsed)}/${mbs(m1.heapTotal)}`,
);
