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
    license:
      'CC BY-ND 3.0 TW (教育部重編國語辭典修訂本；著作權屬教育部，須標示出處；via g0v/moedict-data，格式轉換部分 CC0)',
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
  /** 簡體輸出的繁轉簡表。表小（約 113KB），原樣放在 native/src/opencc/、用 include_str! 編進引擎（native/src/t2s.rs），不經資料流程 */
  opencc: {
    baseUrl: 'https://raw.githubusercontent.com/BYVoid/OpenCC/ver.1.4.2/data/dictionary/',
    files: ['TSCharacters.txt', 'TSPhrases.txt'] as const,
    license: 'Apache-2.0 (OpenCC, Copyright BYVoid and contributors)',
    revision: 'ver.1.4.2',
  },
} as const;
