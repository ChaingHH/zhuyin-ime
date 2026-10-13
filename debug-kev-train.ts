// 產生 Kev 微調資料：從語料另抽句子（排除 eval 句），解碼 N-best，正解當 label。
// 用法：npx tsx debug-kev-train.ts [每域句數] → data/kev/train-{choice,noul}.jsonl
import { readFile, rename, writeFile } from 'node:fs/promises';
import { buildEvalSet } from './packages/data-pipeline/src/build/evalset.js';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';

const N = Number(process.argv[2] ?? 3000);
const TOP = 16;
const Q_CHOICE =
  '使用者用注音輸入法打了一句話，下列候選讀音相同。哪一句是使用者真正想打的、最通順自然的正體中文句子？';
const Q_NOUL = '這是一句通順自然、用字正確的正體中文句子嗎？';

const evalTexts = new Set<string>();
for (const f of ['colloquial', 'written']) {
  for (const l of (await readFile(`eval/${f}.jsonl`, 'utf8')).split('\n').slice(1)) {
    if (l) evalTexts.add(JSON.parse(l).text);
  }
}

const { decoder } = await loadRuntime({ a: 1, gamma: 0.5 });
const choice: string[] = [];
const noul: string[] = [];
for (const dom of ['colloquial', 'written']) {
  // 多抽一些，扣掉與 eval 重疊者
  const out = await buildEvalSet(
    `data/processed/corpus/${dom}.txt`,
    `kevtrain-${dom}`,
    N + 200,
    777,
  );
  await rename(out, `data/kev/kevtrain-${dom}.jsonl`);
  let kept = 0;
  for (const s of await loadEvalSamples(`data/kev/kevtrain-${dom}.jsonl`)) {
    if (kept >= N || evalTexts.has(s.text)) continue;
    const cands = [
      ...new Set(decoder.decode(s.syllables, { nBest: 28 }).map((p) => p.words.join(''))),
    ].slice(0, TOP);
    if (cands.length < 2 || !cands.includes(s.text)) continue; // 正解不在候選內則無從學
    kept++;
    choice.push(
      JSON.stringify({
        state: '',
        questions: {
          pick: {
            type: 'choice',
            instructions: Q_CHOICE,
            criteria: Object.fromEntries(cands.map((c) => [c, null])),
            label: s.text,
          },
        },
      }),
    );
    // noul：正解 + 前 3 個錯誤候選（錯誤候選多半就是 LM 會選錯的那幾個）
    for (const c of [s.text, ...cands.filter((c) => c !== s.text).slice(0, 3)]) {
      noul.push(
        JSON.stringify({
          state: c,
          questions: { ok: { type: 'noul', instructions: Q_NOUL, label: c === s.text } },
        }),
      );
    }
  }
  console.log(`${dom}: kept ${kept}`);
}
await writeFile('data/kev/train-choice.jsonl', choice.join('\n') + '\n');
await writeFile('data/kev/train-noul.jsonl', noul.join('\n') + '\n');
