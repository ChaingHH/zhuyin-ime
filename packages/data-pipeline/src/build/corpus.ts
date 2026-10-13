import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { ensurePttRaw, fetchWikiTexts, iterPttTexts } from '../sources/corpus.js';
import { cleanSentence, splitSentences } from './clean.js';

const CORPUS_DIR = path.join(PATHS.processed, 'corpus');

async function writeDomain(name: string, sentences: string[]): Promise<string> {
  await mkdir(CORPUS_DIR, { recursive: true });
  const out = path.join(CORPUS_DIR, `${name}.txt`);
  await writeFile(out, sentences.join('\n') + '\n', 'utf8');
  return out;
}

/** 口語域：PTT 全量 → 清洗切句。 */
export async function buildColloquial(target: number): Promise<CorpusBuildResult> {
  const raw = await ensurePttRaw();
  const sentences: string[] = [];
  let docs = 0;
  for await (const text of iterPttTexts(raw)) {
    docs++;
    for (const s of splitSentences(text)) {
      const clean = cleanSentence(s);
      if (clean) sentences.push(clean);
    }
    if (sentences.length >= target) break;
  }
  const out = await writeDomain('colloquial', sentences.slice(0, target));
  console.log(`[colloquial] ${sentences.length} 句（掃描 ${docs} 篇）-> ${out}`);
  return { sentences: Math.min(sentences.length, target), inputDocs: docs };
}

export interface CorpusBuildResult {
  sentences: number;
  inputDocs: number;
}

/** 書面域：維基百科 rows API 抽樣。 */
export async function buildWritten(
  targetSentences: number,
  targetDocs: number,
): Promise<CorpusBuildResult> {
  const docs = await fetchWikiTexts(targetDocs);
  const sentences: string[] = [];
  for (const doc of docs) {
    for (const s of splitSentences(doc)) {
      const clean = cleanSentence(s);
      if (clean) sentences.push(clean);
    }
    if (sentences.length >= targetSentences) break;
  }
  const out = await writeDomain('written', sentences.slice(0, targetSentences));
  console.log(`[written] ${sentences.length} 句 -> ${out}`);
  return { sentences: Math.min(sentences.length, targetSentences), inputDocs: docs.length };
}
