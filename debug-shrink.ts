// 退回式模型剪枝實驗：全模型與分數只算一次，對多個「保留筆數」各建一個模型、量句準確率。
// NODE_OPTIONS=--max-old-space-size=12000 npx tsx debug-shrink.ts [設定,…]
// 設定 = 保留筆數（百萬）/機率位元/指紋位元/詞二:詞三:字二:字三 分數權重，例如 6/8/16/1:1:2:2；
// 省略時是 8、32、1:1:1:1。權重只改四張表之間的分配，總筆數仍是保留筆數
// RSS 要另外用 debug-prune.ts（ZHUYIN_LM=…bo.bin）一設定一行程量。
import { rm } from 'node:fs/promises';
import {
  LanguageModel,
  buildBackoff,
  scoreNgrams,
  selectTop,
} from './packages/lm/src/index.js';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';

const SRC = 'data/models/lm.tsv';
const configs = (process.argv[2] ?? '4,6,8,11').split(',').map((c) => {
  const [k, b = '8', f = '32', w = '1:1:1:1'] = c.split('/');
  return {
    k: Number(k),
    bits: Number(b) as 8 | 16,
    fpBits: Number(f) as 16 | 32,
    weights: w.split(':').map(Number),
  };
});
process.env['ZHUYIN_NO_USER'] = '1';

let t = Date.now();
const full = await LanguageModel.load(SRC, { minBi: 1, minTri: 1 });
console.log(`載入全模型 ${((Date.now() - t) / 1000).toFixed(0)}s`);
t = Date.now();
const scores = await scoreNgrams(full, SRC);
const tables = [scores.word.bi, scores.word.tri, scores.char.bi, scores.char.tri];
const n = tables.reduce((m, a) => m + a.length, 0);
console.log(`算分數 ${((Date.now() - t) / 1000).toFixed(0)}s，共 ${(n / 1e6).toFixed(1)}M 筆`);

const samples = {
  colloquial: await loadEvalSamples('eval/colloquial.jsonl'),
  written: await loadEvalSamples('eval/written.jsonl'),
};

for (const { k, bits, fpBits, weights } of configs) {
  const { scores: ws, theta } = selectTop(scores, k * 1e6, weights);
  t = Date.now();
  const bo = await buildBackoff(full, SRC, ws, { theta, bits, fpBits });
  const file = `data/models/tmp-${k}-${bits}-${fpBits}.bo.bin`;
  await bo.save(file);
  const buildS = (Date.now() - t) / 1000;
  process.env['ZHUYIN_LM'] = file;
  const rt = await loadRuntime({ a: 1, gamma: 0.5 });
  const row = [
    `keep ${k}M w=${weights.join(':')} θ=${theta.toExponential(2)} bits=${bits} fp=${fpBits}`,
    `表 ${(bo.bytes / 2 ** 20).toFixed(1)}MB`,
    `筆數 ${bo.sizes.map((n) => (n / 1e6).toFixed(2)).join('/')}M`,
    `建 ${buildS.toFixed(0)}s`,
  ];
  for (const [f, ss] of Object.entries(samples)) {
    let ok = 0;
    for (const s of ss) {
      const out = rt.decoder.decode(s.syllables, { nBest: 1 })[0]?.words.join('') ?? '';
      if (out === s.text) ok++;
    }
    row.push(`${f} 句 ${((ok / ss.length) * 100).toFixed(1)}`);
  }
  console.log(row.join(' | '));
  if (!process.env['KEEP_BO']) await rm(file);
}
