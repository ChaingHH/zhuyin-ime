import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PATHS, SOURCES } from '../config.js';
import { downloadTo } from '../util/download.js';
import { extractXz } from '../util/xz.js';

/** 萌典 dict-revised.json 條目（只取用到的欄位）。 */
export interface MoedictEntry {
  title: string;
  heteronyms?: { bopomofo?: string; pinyin?: string }[];
}

const XZ = path.join(PATHS.raw, 'moedict', 'dict-revised.json.xz');
const JSON_FILE = path.join(PATHS.raw, 'moedict', 'dict-revised.json');

export async function ensureMoedictJson(): Promise<string> {
  try {
    await readFile(JSON_FILE, 'utf8');
    return JSON_FILE;
  } catch {
    await downloadTo(SOURCES.moedict.url, XZ);
    await extractXz(XZ, JSON_FILE);
    return JSON_FILE;
  }
}

export async function loadMoedict(): Promise<MoedictEntry[]> {
  const file = await ensureMoedictJson();
  return JSON.parse(await readFile(file, 'utf8')) as MoedictEntry[];
}
