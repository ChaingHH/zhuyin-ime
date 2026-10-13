import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PATHS, SOURCES } from '../config.js';
import { downloadTo } from '../util/download.js';

export type LibchewingFile = (typeof SOURCES.libchewing)['files'][number];

export async function ensureLibchewingCsv(file: LibchewingFile): Promise<string> {
  const dest = path.join(PATHS.raw, 'libchewing', path.basename(file));
  try {
    await readFile(dest, 'utf8');
    return dest;
  } catch {
    await downloadTo(SOURCES.libchewing.baseUrl + file, dest);
    return dest;
  }
}

export interface LibchewingRow {
  word: string;
  freq: number;
  bopomofo: string;
}

/**
 * 解析 libchewing CSV：`詞,頻率,注音`，`#` 開頭為中繼資料（授權/版本）。
 * 注音為後綴式聲調（ㄇㄜ˙）。同一詞多讀音 = 多行。
 */
export function parseLibchewingCsv(text: string): LibchewingRow[] {
  const rows: LibchewingRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    // 註音符號、聲調符號單獨成列者不是詞——首字必須是漢字
    const cols = line.split(',');
    if (cols.length < 3) continue;
    const word = (cols[0] ?? '').trim();
    const freq = Number.parseInt(cols[1] ?? '0', 10);
    const bopomofo = cols.slice(2).join(',').trim();
    if (!word || !bopomofo) continue;
    if (!/[\u3400-\u9FFF]/.test(word[0] ?? '')) continue;
    rows.push({ word, freq: Number.isNaN(freq) ? 0 : freq, bopomofo });
  }
  return rows;
}
