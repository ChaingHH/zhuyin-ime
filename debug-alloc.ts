// 打字時誰在配置記憶體：V8 取樣配置分析（含已被 GC 回收的物件），依函式彙總。只到 L5。
// ZHUYIN_NO_USER=1 npx tsx debug-alloc.ts [句數]
import { Session } from 'node:inspector/promises';
import { syllableToKeyCodes } from '@zhuyin/core';
import { ImeEngine } from './packages/cli/src/engine.js';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';

const rt = await loadRuntime({ a: 1, gamma: 0.5 });
const n = Number(process.argv[2] ?? 100);
const samples = (await loadEvalSamples('eval/colloquial.jsonl')).slice(0, n);
// ALLOC_MODE=nochar：γ=0；dummy：LM 換成回傳常數（只剩解碼器本身的配置）
const mode = process.env['ALLOC_MODE'];
if (mode === 'nochar') (rt.decoder.config as { gamma: number }).gamma = 0;
if (mode === 'dummy')
  (rt.decoder as unknown as { scorer: unknown }).scorer = {
    wordLogProb: (w: string) => -w.length,
    charSequenceLogProb: (w: string) => -w.length,
  };
const engine = new ImeEngine(rt.decoder, rt.legalSyllables);

interface Node {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: Node[];
}
const s = new Session();
s.connect();
await s.post('HeapProfiler.startSampling', {
  samplingInterval: 32768,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
let keys = 0;
for (const smp of samples) {
  for (const code of smp.syllables.flatMap((syl) => syllableToKeyCodes(syl))) {
    engine.onKey({ code, timestampMs: 0 });
    keys++;
  }
  engine.commit();
}
const { profile } = (await s.post('HeapProfiler.stopSampling')) as { profile: { head: Node } };

const by = new Map<string, number>();
let total = 0;
const walk = (nd: Node): void => {
  const f = nd.callFrame;
  const file = f.url.split(/[\\/]/).pop() ?? '';
  const k = `${f.functionName || '(anon)'} ${file}:${f.lineNumber + 1}`;
  by.set(k, (by.get(k) ?? 0) + nd.selfSize);
  total += nd.selfSize;
  nd.children.forEach(walk);
};
walk(profile.head);
console.log(`${n} 句 ${keys} 鍵：共配置約 ${(total / 2 ** 20).toFixed(0)}MB，每鍵 ${(total / keys / 1024).toFixed(0)}KB`);
for (const [k, v] of [...by].sort((x, y) => y[1] - x[1]).slice(0, 15))
  console.log(`${((v / total) * 100).toFixed(1).padStart(5)}%  ${(v / 2 ** 20).toFixed(0).padStart(5)}MB  ${k}`);
