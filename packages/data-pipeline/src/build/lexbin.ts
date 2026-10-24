import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LexiconIndex, isTraditionalWord, type LexiconEntry } from '@zhuyin/core';
import { PATHS } from '../config.js';

/** 解碼器的最長詞（音節數）；超過的讀音不進索引。和 Rust 解碼器一致 */
const MAX_SPAN = 10;

/**
 * lexicon.jsonl → lexicon.bin（Rust 引擎只讀 bin）。
 * 先寫暫存檔再改名：中斷或兩個行程同時建，都不會留下截斷檔。
 */
export async function cmdLexbin(): Promise<void> {
  const jsonl = path.join(PATHS.processed, 'lexicon.jsonl');
  const bin = path.join(PATHS.processed, 'lexicon.bin');
  const entries = (await readFile(jsonl, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LexiconEntry)
    // 舊的 lexicon.jsonl 可能還有非台灣繁體字的詞（cmdLexicon 現在建詞典時就擋）
    .filter((e) => isTraditionalWord(e.word));
  const tmp = `${bin}.${process.pid}.tmp`;
  await writeFile(tmp, LexiconIndex.build(entries, MAX_SPAN).toBytes());
  await rename(tmp, bin);
  console.log(`[done] ${bin}（${entries.length} 詞）`);
}
