// 記憶體拆解：Node 本身 → 只載 LM → 整個 runtime（詞典＋解碼器）。
// node --expose-gc --import tsx debug-mem.ts
import { LanguageModel } from '@zhuyin/lm';
import { loadRuntime } from './packages/cli/src/runtime.js';

const gc = (globalThis as { gc?: () => void }).gc ?? ((): void => {});
const mb = (b: number): string => `${(b / 2 ** 20).toFixed(0)}MB`;
const snap = (label: string): void => {
  gc();
  const m = process.memoryUsage();
  console.log(
    `${label.padEnd(10)} rss ${mb(m.rss)}  heapUsed ${mb(m.heapUsed)}  arrayBuffers ${mb(m.arrayBuffers)}`,
  );
};

snap('node');
const lm = await LanguageModel.load('data/models/lm.bin');
snap('lm only');
const maps = [lm.word, lm.char].map((i) => i.uni.size + i.cont.size + i.biTotals.size + i.biTypes.size + i.biKept.size);
console.log(`           LM 小 Map 筆數 word ${maps[0]} char ${maps[1]}`);
const rt = await loadRuntime({ a: 1, gamma: 0.5 });
snap('runtime');
console.log(rt.lm === lm ? '' : '           （runtime 另載了一份 LM，上一行含兩份）');
