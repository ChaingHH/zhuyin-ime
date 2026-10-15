/**
 * 把 lm.tsv 以 runtime 預設（或 ZHUYIN_LM_MIN_BI／MIN_TRI／QUANT）剪枝量化後存成 lm.bin，
 * 之後 runtime 直接讀 bin，不必每次解析整個 tsv。
 * 用法：npx tsx packages/lm/src/pack.ts [data/models/lm.tsv] [data/models/lm.bin]
 */
import { LanguageModel } from './model.js';

const [src = 'data/models/lm.tsv', dst = 'data/models/lm.bin'] = process.argv.slice(2);
const t0 = Date.now();
const lm = await LanguageModel.load(src, {
  minBi: Number(process.env['ZHUYIN_LM_MIN_BI'] ?? 2),
  minTri: Number(process.env['ZHUYIN_LM_MIN_TRI'] ?? 3),
  quant: Number(process.env['ZHUYIN_LM_QUANT'] ?? 8) as 0 | 8 | 16,
});
console.log(`載入 ${src}：${((Date.now() - t0) / 1000).toFixed(0)}s`);
await lm.save(dst);
console.log(`寫出 ${dst}`);
