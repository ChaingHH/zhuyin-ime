// 把 N-best 候選與 LM 分數存成 JSONL，供 Kev（Jev 開源復刻）離線打分與權重掃描。
// 用法：npx tsx debug-kev-dump.ts [K] → data/kev/nbest-{colloquial,written}.jsonl
import { mkdir, writeFile } from 'node:fs/promises';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';

const K = Number(process.argv[2] ?? 28);
const { decoder } = await loadRuntime({ a: 1, gamma: 0.5 });
await mkdir('data/kev', { recursive: true });

for (const name of ['colloquial', 'written']) {
  const samples = await loadEvalSamples(`eval/${name}.jsonl`);
  const lines: string[] = [];
  let oracle = 0;
  for (const s of samples) {
    const seen = new Set<string>();
    const cands: Array<{ text: string; score: number }> = [];
    for (const p of decoder.decode(s.syllables, { nBest: K })) {
      const text = p.words.join('');
      if (seen.has(text)) continue; // 同字串不同斷詞只留最高分
      seen.add(text);
      cands.push({ text, score: p.score });
    }
    if (seen.has(s.text)) oracle++;
    lines.push(JSON.stringify({ ref: s.text, cands }));
  }
  await writeFile(`data/kev/nbest-${name}.jsonl`, lines.join('\n') + '\n');
  console.log(
    `${name}: n=${samples.length} oracle@${K}=${((oracle / samples.length) * 100).toFixed(1)}%`,
  );
}
