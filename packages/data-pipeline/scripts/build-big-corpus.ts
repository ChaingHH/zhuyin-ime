// 大語料：PTT 全量 + 維基 dump → data/processed/corpus-big/{colloquial,written}.txt
// 不走整句清洗（PTT 用空白/半形標點斷句又夾英數，整句規則會丟掉九成），
// 改取「連續中文字片段」：任何非中文字都切開，保留 ≥4 字的片段。
// 用法：npx tsx packages/data-pipeline/scripts/build-big-corpus.ts [pttMaxChars] [wikiMaxChars]
// CORPUS_EN=1：英文詞不切開，換成類別符號 EN_CLASS（連續英文詞併成一個），中文與英文之間的空白
// 不算斷句；LM 因此學到 P(英文 | 開新的)。含英文的片段約每 HELDOUT_MOD 個留一個給
// eval/mixed.jsonl 的來源（$CORPUS_OUT/mixed-heldout.txt，原文），不進訓練。wikiMaxChars=0 只建 PTT。
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as OpenCC from 'opencc-js';
import { iterPttTexts } from '../src/sources/corpus.js';
import { EN_CLASS } from '@zhuyin/core';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(thisDir, '..', '..', '..');
const OUT_DIR = process.env['CORPUS_OUT'] ?? path.join(REPO, 'data', 'processed', 'corpus-big');
const WIKI_FILE =
  process.env['WIKI_FILE'] ?? path.join(REPO, 'data', 'raw', 'wiki', 'wiki_dump.jsonl');
const PTT_MAX = Number(process.argv[2] ?? 1e12);
const WIKI_MAX = Number(process.argv[3] ?? 1e12);
const toTwp = OpenCC.Converter({ from: 'cn', to: 'twp' });

// 留測防護：片段若包含任一評測句即丟棄（評測句皆 ≥6 字，以 6 字窗索引）
const evalSet = new Map<string, string[]>();
for (const f of ['colloquial.jsonl', 'written.jsonl']) {
  for (const line of (await readFile(path.join(REPO, 'eval', f), 'utf8')).split('\n')) {
    if (!line.startsWith('{"text"')) continue;
    const t = (JSON.parse(line) as { text: string }).text;
    const k = t.slice(0, 6);
    evalSet.set(k, [...(evalSet.get(k) ?? []), t]);
  }
}
function leaks(run: string): boolean {
  for (let i = 0; i + 6 <= run.length; i++) {
    const hit = evalSet.get(run.slice(i, i + 6));
    if (hit?.some((t) => run.startsWith(t, i))) return true;
  }
  return false;
}

const WITH_EN = process.env['CORPUS_EN'] === '1';
const HELDOUT_MOD = 200;
const HAN_RUN = /^[㐀-鿿]+$/;

/**
 * 一段文字 → 片段 [類別化字串, 原文]。中文串與英文詞交錯，中間只隔空白；
 * 其他字元（標點、數字）斷開，兩個中文串之間的空白也斷開（PTT 拿空白當標點）。
 */
export function enPieces(text: string): [string, string][] {
  const out: [string, string][] = [];
  let cls = '';
  let raw = '';
  let space = false;
  const flush = (): void => {
    if (cls) out.push([cls, raw.trim()]);
    cls = raw = '';
  };
  for (const tok of text.match(/[㐀-鿿]+|[A-Za-z0-9]+| +|[^㐀-鿿A-Za-z0-9 ]+/g) ?? []) {
    if (tok[0] === ' ') {
      space = true;
      continue;
    }
    const wasSpace = space;
    space = false;
    if (HAN_RUN.test(tok)) {
      if (wasSpace && !cls.endsWith(EN_CLASS)) flush();
      cls += tok;
      raw += (wasSpace && cls !== tok ? ' ' : '') + tok;
    } else if (/[A-Za-z]/.test(tok)) {
      if (!cls.endsWith(EN_CLASS)) cls += EN_CLASS;
      raw += (wasSpace && raw ? ' ' : '') + tok;
    } else flush();
  }
  flush();
  return out;
}

/** 片段字串的雜湊（決定留測，同一片段一律同一邊） */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

async function collect(
  texts: AsyncIterable<string>,
  maxChars: number,
  name: string,
): Promise<void> {
  const out = createWriteStream(path.join(OUT_DIR, `${name}.txt`), 'utf8');
  // 長片段去重：PTT 大量重複引文／簽名檔；短片段（常用語）保留頻次
  const seenLong = new Set<string>();
  let docs = 0;
  let chars = 0;
  let leaked = 0;
  let heldout = 0;
  const held =
    WITH_EN && name === 'colloquial'
      ? createWriteStream(path.join(OUT_DIR, 'mixed-heldout.txt'), 'utf8')
      : null;
  for await (const text of texts) {
    if (++docs % 100000 === 0) console.log(`[${name}] ${docs} 篇 ${(chars / 1e6).toFixed(0)}M 字`);
    const pieces: [string, string][] = WITH_EN
      ? enPieces(toTwp(text))
      : toTwp(text)
          .split(/[^㐀-鿿]+/)
          .map((r) => [r, r]);
    for (const [run, raw] of pieces) {
      if (run.length < 4) continue;
      if (held && run.includes(EN_CLASS)) {
        if (run.replaceAll(EN_CLASS, '').length < 2) continue;
        if (hash(run) % HELDOUT_MOD === 0) {
          heldout++;
          held.write(raw + '\n');
          continue;
        }
      }
      if (run.length >= 12) {
        if (seenLong.has(run)) continue;
        seenLong.add(run);
      }
      if (leaks(run)) {
        leaked++;
        continue;
      }
      chars += run.length;
      if (!out.write(run + '\n')) await new Promise((r) => out.once('drain', r));
    }
    if (chars >= maxChars) break;
  }
  await new Promise<void>((r) => out.end(() => r()));
  if (held) await new Promise<void>((r) => held.end(() => r()));
  console.log(
    `[${name}] done ${docs} 篇 ${(chars / 1e6).toFixed(1)}M 字，丟棄含評測句片段 ${leaked}，留測 ${heldout}`,
  );
}

async function* jsonlTexts(file: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    try {
      yield (JSON.parse(line) as { text?: string }).text ?? '';
    } catch {
      /* skip */
    }
  }
}

await mkdir(OUT_DIR, { recursive: true });
if (PTT_MAX > 0)
  await collect(
    iterPttTexts(path.join(REPO, 'data', 'raw', 'ptt', 'ppt_pretrain.json')),
    PTT_MAX,
    'colloquial',
  );
if (WIKI_MAX > 0) await collect(jsonlTexts(WIKI_FILE), WIKI_MAX, 'written');
