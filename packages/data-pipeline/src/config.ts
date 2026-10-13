import { fileURLToPath } from 'node:url';
import path from 'node:path';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
/** packages/data-pipeline/src → repo root */
export const REPO_ROOT = path.resolve(thisDir, '..', '..', '..');

export const PATHS = {
  raw: path.join(REPO_ROOT, 'data', 'raw'),
  processed: path.join(REPO_ROOT, 'data', 'processed'),
  models: path.join(REPO_ROOT, 'data', 'models'),
  eval: path.join(REPO_ROOT, 'eval'),
};

/** 每個來源的取得位址、授權與版本標記。版本變更必須更新此檔並重建下游。 */
export const SOURCES = {
  moedict: {
    url: 'https://raw.githubusercontent.com/g0v/moedict-data/master/dict-revised.json.xz',
    license: 'OGDL-Taiwan-1.0 (教育部重編國語辭典修訂本，via g0v/moedict-data)',
    revision: 'master@2026-08',
  },
  libchewing: {
    baseUrl: 'https://raw.githubusercontent.com/chewing/libchewing-data/main/dict/chewing/',
    files: ['word.csv', 'tsi.csv'] as const,
    license: 'LGPL-2.1-or-later (Copyright (c) 2025 libchewing Core Team)',
    revision: 'main@2026-08',
  },
  ptt: {
    url: 'https://huggingface.co/datasets/yuhuanstudio/PTT-pretrain-zhtw/resolve/main/ppt_pretrain.json',
    license: '見 dataset card（使用前逐條核對）',
    revision: 'main@2026-08',
  },
} as const;
