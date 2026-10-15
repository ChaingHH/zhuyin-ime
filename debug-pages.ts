// mmap 可行性：跑完評測句後，LM 大表有多少 4KB 頁被讀到（k1 陣列，每槽 4 bytes）。
// npx tsx debug-pages.ts [句數上限]
import { HashTable } from './packages/lm/dist/hashtable.js';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';

type Slotted = { slot(): number; cap: number; __pages?: Set<number> };
const proto = HashTable.prototype as unknown as Slotted;
const orig = proto.slot;
proto.slot = function (this: Slotted): number {
  const i = orig.call(this);
  (this.__pages ??= new Set()).add(Math.floor(((i < 0 ? ~i : i) * 4) / 4096));
  return i;
};

const rt = await loadRuntime({ a: 1, gamma: 0.5 });
const tables = { wbi: rt.lm.word.bi, wtri: rt.lm.word.tri, cbi: rt.lm.char.bi, ctri: rt.lm.char.tri };
for (const t of Object.values(tables)) (t as unknown as Slotted).__pages = new Set();
const limit = Number(process.argv[2] ?? Infinity);
const report = (label: string): void => {
  const parts = Object.entries(tables).map(([k, t]) => {
    const s = t as unknown as Slotted;
    const total = Math.ceil((s.cap * 4) / 4096);
    return `${k} ${s.__pages!.size}/${total}頁 ${((s.__pages!.size / total) * 100).toFixed(1)}%`;
  });
  console.log(`${label.padEnd(8)} k1 頁觸及率：${parts.join('  ')}`);
};
let n = 0;
for (const f of ['colloquial', 'written'])
  for (const s of await loadEvalSamples(`eval/${f}.jsonl`)) {
    if (n >= limit) break;
    rt.decoder.decode(s.syllables, { nBest: 1 });
    if (++n === 1 || n === 10 || n === 100 || n === 1500) report(`${n} 句`);
  }
