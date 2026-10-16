// 倒出評測句的 N-best（詞序＋分數），改解碼器前後各跑一次、diff，確認結果逐位元相同。
// ZHUYIN_NO_USER=1 npx tsx debug-decode-dump.ts <out.txt> [nBest]
import { writeFileSync } from 'node:fs';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';

const rt = await loadRuntime({ a: 1, gamma: 0.5 });
const nBest = Number(process.argv[3] ?? 4);
const out: string[] = [];
for (const f of ['colloquial', 'written'])
  for (const s of await loadEvalSamples(`eval/${f}.jsonl`))
    for (const p of rt.decoder.decode(s.syllables, { nBest }))
      out.push(`${p.words.join('|')}\t${p.score}`);
writeFileSync(process.argv[2]!, out.join('\n'));
console.log(`${out.length} 行 -> ${process.argv[2]}`);
