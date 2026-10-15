/**
 * 把 lm.tsv 以 runtime 預設（或 ZHUYIN_LM_* 環境變數，見 lmOptionsFromEnv）剪枝量化後存成 lm.bin，
 * 之後 runtime 直接讀 bin，不必每次解析整個 tsv。
 * 用法：npx tsx packages/lm/src/pack.ts [data/models/lm.tsv] [data/models/lm.bin]
 */
import { LanguageModel, lmOptionsFromEnv } from './model.js';

const [src = 'data/models/lm.tsv', dst = 'data/models/lm.bin'] = process.argv.slice(2);
const t0 = Date.now();
const lm = await LanguageModel.load(src, lmOptionsFromEnv(process.env));
console.log(`載入 ${src}：${((Date.now() - t0) / 1000).toFixed(0)}s`);
await lm.save(dst);
console.log(`寫出 ${dst}`);
