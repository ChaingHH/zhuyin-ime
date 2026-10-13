/**
 * 模型預下載：transformers.js 的 ONNX 權重放 data/models/hf（gitignored）。
 * 預設 Xenova/bert-base-chinese（Apache-2.0 衍生轉換；上游 google-bert/bert-base-chinese 為 Apache-2.0）。
 * int8/quantized 一律不用——報告實測句準會崩（70%→55%）。
 */
import path from 'node:path';
import { env } from '@huggingface/transformers';
import { fileURLToPath } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(thisDir, '..', '..', '..');

export const RERANK_MODEL = process.env['RERANK_MODEL'] ?? 'Xenova/bert-base-chinese';
export const HF_CACHE = path.join(REPO, 'data', 'models', 'hf');
env.cacheDir = HF_CACHE;
env.allowLocalModels = false;
