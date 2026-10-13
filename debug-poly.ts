import { readFile } from 'node:fs/promises';
import { loadRuntime } from './packages/cli/src/runtime.js';

const L = JSON.parse(await readFile('data/models/lm.json', 'utf8'));
const { decoder } = await loadRuntime({ a: 1.2, gamma: 0.3 });
const polyMap: Map<string, number> = decoder['polyMap'];

// 統計：破音字在詞格裡以「單字」vs「多字詞」出現的比例
const total = Object.values(L.wordUni).reduce((a: number, b: number) => a + b, 0);
let polySingle = 0, polyMulti = 0;
for (const [w, freq] of Object.entries(L.wordUni) as [string, number][]) {
  const nR = polyMap.get(w) ?? 1;
  if (nR <= 1) continue;
  if ([...w].length === 1) polySingle += freq;
  else polyMulti += freq;
}
console.log(`破音字 單字 freq sum: ${polySingle} (${(polySingle/total*100).toFixed(1)}%)`);
console.log(`破音字 多字 freq sum: ${polyMulti} (${(polyMulti/total*100).toFixed(1)}%)`);
console.log(`比值 多字/單字: ${(polyMulti/polySingle).toFixed(1)}x`);

// 列出 top 10 破音單字
const polySingles: [string, number][] = [];
for (const [w, freq] of Object.entries(L.wordUni) as [string, number][]) {
  if ((polyMap.get(w) ?? 1) > 1 && [...w].length === 1) polySingles.push([w, freq]);
}
polySingles.sort((a, b) => b[1] - a[1]);
console.log('\nTop 10 破音單字:');
for (const [w, f] of polySingles.slice(0, 10)) {
  console.log(`  ${w}  freq=${f}  readings=${polyMap.get(w)}`);
}
