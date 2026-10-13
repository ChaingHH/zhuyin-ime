// 大語料：PTT 全量 + 維基 dump → data/processed/corpus-big/{colloquial,written}.txt
// 不走整句清洗（PTT 用空白/半形標點斷句又夾英數，整句規則會丟掉九成），
// 改取「連續中文字片段」：任何非中文字都切開，保留 ≥4 字的片段。
// 用法：npx tsx packages/data-pipeline/scripts/build-big-corpus.ts [pttMaxChars] [wikiMaxChars]
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as OpenCC from 'opencc-js';
import { iterPttTexts } from '../src/sources/corpus.js';

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
  for await (const text of texts) {
    if (++docs % 100000 === 0) console.log(`[${name}] ${docs} 篇 ${(chars / 1e6).toFixed(0)}M 字`);
    for (const run of toTwp(text).split(/[^㐀-鿿]+/)) {
      if (run.length < 4) continue;
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
  console.log(
    `[${name}] done ${docs} 篇 ${(chars / 1e6).toFixed(1)}M 字，丟棄含評測句片段 ${leaked}`,
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
await collect(jsonlTexts(WIKI_FILE), WIKI_MAX, 'written');
