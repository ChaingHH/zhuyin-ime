import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { LexiconEntry } from '@zhuyin/core';
import { PATHS } from '../config.js';

export interface EvalSample {
  text: string;
  /** 貪婪最長匹配分詞結果 */
  tokens: string[];
  /** 對應音節序列（正規化字串） */
  syllables: string[];
}

/** 讀評測集（第一行是中繼資料） */
export async function loadEvalSamples(file: string): Promise<EvalSample[]> {
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  return lines.slice(1).map((l) => JSON.parse(l) as EvalSample);
}

/** 線性同餘 RNG——評測集必須可重現（種子寫進輸出檔名旁的 meta）。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

async function loadLexiconIndex(): Promise<Map<string, LexiconEntry>> {
  const file = path.join(PATHS.processed, 'lexicon.jsonl');
  const map = new Map<string, LexiconEntry>();
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line) as LexiconEntry;
    // 評測讀音只用原詞典（不含挖出來的詞），和 build-mixed-eval.ts 一致
    if (!e.provenance.every((p) => p === 'mined')) map.set(e.word, e);
  }
  return map;
}

/**
 * 貪婪最長匹配分詞。回傳 null 表示存在無法覆蓋的字串（外文、未登錄詞過多）。
 * coverageThresh：可分詞字元比例下限。
 */
export function segment(
  sentence: string,
  lexicon: Map<string, LexiconEntry>,
  maxWordLen = 6,
  coverageThresh = 0.95,
): { tokens: string[]; syllables: string[] } | null {
  const tokens: string[] = [];
  const syllables: string[] = [];
  let covered = 0;
  let i = 0;
  while (i < sentence.length) {
    let matched: string | null = null;
    for (let len = Math.min(maxWordLen, sentence.length - i); len >= 1; len--) {
      const cand = sentence.slice(i, i + len);
      const entry = lexicon.get(cand);
      if (entry && entry.readings.length > 0) {
        matched = cand;
        // 讀音取第一組（多讀音消歧是 L4/L5 的工作，評測集記錄全部候選即可）
        syllables.push(...entry.readings[0]!);
        break;
      }
    }
    if (!matched) return null;
    covered += matched.length;
    tokens.push(matched);
    i += matched.length;
  }
  if (covered / sentence.length < coverageThresh) return null;
  return { tokens, syllables };
}

export async function buildEvalSet(
  domainFile: string,
  outName: string,
  nSentences: number,
  seed = 20260824,
): Promise<string> {
  const lexicon = await loadLexiconIndex();
  const rng = lcg(seed);
  const lines = (await readFile(domainFile, 'utf8')).split('\n').filter(Boolean);

  // 洗牌後依序取樣直到湊滿
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [lines[i], lines[j]] = [lines[j]!, lines[i]!];
  }

  const samples: EvalSample[] = [];
  for (const line of lines) {
    if (samples.length >= nSentences) break;
    const seg = segment(line, lexicon);
    if (seg && seg.syllables.length > 0) {
      samples.push({ text: line, ...seg });
    }
  }

  const outDir = PATHS.eval;
  await mkdir(outDir, { recursive: true });
  const out = path.join(outDir, `${outName}.jsonl`);
  const meta = JSON.stringify({ seed, n: samples.length, source: path.basename(domainFile) });
  await writeFile(out, `${meta}\n${samples.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');
  console.log(`[eval:${outName}] ${samples.length}/${nSentences} 句 -> ${out}`);
  return out;
}
