import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';
import { PllReranker } from './packages/rerank/src/reranker.js';

const { decoder } = await loadRuntime({ a: 1.2, gamma: 0.3 });
const rr = await PllReranker.create({ weight: 0.25, maxCandidates: 12 });

// ---- A. 矛盾 (合成: ㄇㄠˊ ㄉㄨㄣˋ) ----
console.log('=== A. 矛盾 ㄇㄠˊ ㄉㄨㄣˋ ===');
const pa = decoder.decode(['ㄇㄠˊ', 'ㄉㄨㄣˋ'], { nBest: 28 });
for (let i = 0; i < Math.min(10, pa.length); i++) {
  const w = pa[i]!.words.join('');
  console.log(`  ${String(i+1).padStart(2)} s=${pa[i]!.score.toFixed(1)} ${pa[i]!.words.join('|')}`);
}
const rpa = await rr.rerank(pa);
console.log(`  → L6 top: ${rpa.paths[0]?.words.join('')}`);

// ---- B. 莫名其妙 (合成: ㄇㄛˋ ㄇㄧㄥˊ ㄑㄧˊ ㄇㄧㄠˋ) ----
console.log('\n=== B. 莫名其妙 ㄇㄛˋ ㄇㄧㄥˊ ㄑㄧˊ ㄇㄧㄠˋ ===');
const pb = decoder.decode(['ㄇㄛˋ', 'ㄇㄧㄥˊ', 'ㄑㄧˊ', 'ㄇㄧㄠˋ'], { nBest: 28 });
for (let i = 0; i < Math.min(8, pb.length); i++) {
  const w = pb[i]!.words.join('');
  const mark = w.includes('莫名其妙') ? ' ★正確' : w.includes('莫名奇妙') ? ' ✗錯' : '';
  console.log(`  ${String(i+1).padStart(2)} s=${pb[i]!.score.toFixed(1)}${mark} ${pb[i]!.words.join('|')}`);
}
const rpb = await rr.rerank(pb);
console.log(`  → L6 top: ${rpb.paths[0]?.words.join('')}`);

// ---- C. 程式碼 (written eval sample) ----
const wr = await loadEvalSamples('eval/written.jsonl');
const chengshi = wr.find(s => s.text.includes('程式碼'));
if (chengshi) {
  console.log(`\n=== C. 程式碼 ===`);
  console.log(`ref: ${chengshi.text}`);
  const pc = decoder.decode(chengshi.syllables, { nBest: 28 });
  for (let i = 0; i < Math.min(10, pc.length); i++) {
    const w = pc[i]!.words.join('');
    const mark = w.includes('程式碼') ? ' ★正確' : '';
    console.log(`  ${String(i+1).padStart(2)} s=${pc[i]!.score.toFixed(1)}${mark} ${pc[i]!.words.join('|')}`);
  }
  const ci = pc.findIndex(x => x.words.join('') === chengshi.text);
  console.log(`  正解 rank: ${ci >= 0 ? ci+1 : '不在 top28'}`);
  const rpc = await rr.rerank(pc);
  console.log(`  → L6 top: ${rpc.paths[0]?.words.join('')}`);
}
