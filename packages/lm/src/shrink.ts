/**
 * lm.tsv → 剪枝後的退回式模型 lm.bo.bin（見 backoff.ts）。runtime 預設優先載入它。
 * 用法：npx tsx packages/lm/src/shrink.ts <θ> [data/models/lm.tsv] [data/models/lm.bo.bin]
 * LM_SHRINK_BITS=8|16：二元／三元機率的量化位元數（預設 8）。
 */
import { LanguageModel } from './model.js';
import { buildBackoff, scoreNgrams } from './backoff.js';

const [theta, src = 'data/models/lm.tsv', dst = 'data/models/lm.bo.bin'] = process.argv.slice(2);
if (theta === undefined) throw new Error('用法：shrink.ts <θ> [lm.tsv] [lm.bo.bin]');
const t0 = Date.now();
const full = await LanguageModel.load(src, { minBi: 1, minTri: 1 });
const scores = await scoreNgrams(full, src);
const bo = await buildBackoff(full, src, scores, {
  theta: Number(theta),
  bits: Number(process.env['LM_SHRINK_BITS'] ?? 8) as 8 | 16,
});
await bo.save(dst);
console.log(
  `寫出 ${dst}：${(bo.bytes / 2 ** 20).toFixed(1)}MB，筆數 ${bo.sizes.join('/')}，` +
    `${((Date.now() - t0) / 1000).toFixed(0)}s`,
);
