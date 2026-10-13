import { readFile } from 'node:fs/promises';
import { loadRuntime } from './packages/cli/src/runtime.js';

const L = JSON.parse(await readFile('data/models/lm.json', 'utf8'));
const { decoder } = await loadRuntime({ a: 1.2, gamma: 0.3 });
const paths = decoder.decode(['ㄒㄧㄥˋ','ㄗˇ','ㄎㄨㄞˋ','ㄙˇ','ㄉㄧㄠˋ','ㄌㄜ˙'], { nBest: 10 });

const total = Object.values(L.wordUni).reduce((a: number,b: number)=>a+b,0);
const polyMap: Map<string,number> = decoder['polyMap'];
function logP(w: string) {
  const u = L.wordUni[w];
  if (u === undefined) return null;
  return Math.log(u / total);
}

for (let i = 0; i < 4; i++) {
  const p = paths[i]!;
  console.log(`\n#${i+1}  score=${p.score.toFixed(2)}  words=[${p.words.join('][')}]`);
  for (const w of p.words) {
    const lp = logP(w);
    const nR = polyMap.get(w) ?? 1;
    const pen = nR > 1 ? Math.log(nR) : 0;
    const eff = lp !== null ? (lp - pen) : null;
    console.log(`  ${w.padEnd(6)} freq=${String(L.wordUni[w] ?? 'MISS').padStart(7)}  readings=${nR}  -pen=${pen.toFixed(2)}  logP=${lp?.toFixed(2) ?? 'MISS'}  eff=${eff?.toFixed(2) ?? 'MISS'}`);
  }
}
