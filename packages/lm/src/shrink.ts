/**
 * lm.tsv → 剪枝後的退回式模型 lm.bo.bin（見 backoff.ts）。runtime 預設優先載入它。
 * 用法：npx tsx packages/lm/src/shrink.ts [保留筆數（百萬，預設 12）] [lm.tsv] [lm.bo.bin]
 * LM_SHRINK_WEIGHTS=詞二:詞三:字二:字三（預設 1:1:2:2）；LM_SHRINK_BITS=8|16（機率位元，預設 8）。
 * 預設設定：大表 46MB、RSS 115MB、句 76.1／79.4（docs/MEMORY.md）。要 NODE_OPTIONS=--max-old-space-size=12000。
 */
import { LanguageModel } from './model.js';
import { buildBackoff, scoreNgrams, selectTop } from './backoff.js';

const [keepM = '12', src = 'data/models/lm.tsv', dst = 'data/models/lm.bo.bin'] =
  process.argv.slice(2);
const weights = (process.env['LM_SHRINK_WEIGHTS'] ?? '1:1:2:2').split(':').map(Number);
const t0 = Date.now();
const full = await LanguageModel.load(src, { minBi: 1, minTri: 1 });
const top = selectTop(await scoreNgrams(full, src), Number(keepM) * 1e6, weights);
const bo = await buildBackoff(full, src, top.scores, {
  theta: top.theta,
  bits: Number(process.env['LM_SHRINK_BITS'] ?? 8) as 8 | 16,
});
await bo.save(dst);
console.log(
  `寫出 ${dst}：θ=${top.theta.toExponential(2)}，大表 ${(bo.bytes / 2 ** 20).toFixed(1)}MB，` +
    `筆數 ${bo.sizes.join('/')}，${((Date.now() - t0) / 1000).toFixed(0)}s`,
);
