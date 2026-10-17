/**
 * 從語料挖常用複合詞，補進詞典（provenance = mined）。
 *
 * 不重掃 1GB 語料：直接讀 lm.tsv 的詞級計數（訓練時的 unigram-DP 斷詞結果）。
 * 候選 = 相鄰兩個 token（詞典詞或單字）合起來 2–4 字、還不在詞典裡。篩選：
 * - 次數 c(ab) ≥ MIN_COUNT
 * - 凝聚度 PMI = log(c(ab)·N / (c(a)·c(b))) ≥ MIN_PMI
 * - 不是更長單位的碎片：左鄰（x a b）或右鄰（a b x）任一個詞佔超過 MAX_SHARE 就丟
 *   （柯 文 哲 → 「文哲」的左鄰幾乎都是「柯」）。鄰接分佈取自三元表（訓練時 count≥2），
 *   句首／句尾不算鄰居。
 * - 至少一邊是單字（狀態＋列、推＋文）；MINE_ALL_SHAPES=1 連「詞＋詞」也收
 * - 不含虛詞／代名詞（人名、詞後面黏「說」「的」這類片段）
 * 讀音 = 各 token 的讀音串接。多讀音的單字用詞典多字詞裡該字的讀音分佈挑，
 * 主讀音佔 ≥ 0.85 才收；多讀音的多字 token 直接跳過。
 *
 * 用法：npx tsx packages/data-pipeline/scripts/mine-words.ts [lm.tsv] [lexicon.jsonl] [out.jsonl]
 * 環境變數：MINE_MIN_COUNT（100）、MINE_MIN_PMI（4）、MINE_MAX_SHARE（0.5）。
 * 寬門檻 50/3/0.6 收 3.8 萬詞，雜訊多（唯一齣、已失），句準只 +0.1；這組 1.2 萬詞 +0.4/+0.2（docs/MEMORY.md §7）
 */
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

const DATA = process.env['ZHUYIN_DATA'] ?? 'data';
const lmFile = process.argv[2] ?? path.join(DATA, 'models', 'lm.tsv');
const lexFile = process.argv[3] ?? path.join(DATA, 'processed', 'lexicon.jsonl');
const outFile = process.argv[4] ?? path.join(DATA, 'processed', 'mined.jsonl');
const MIN_COUNT = Number(process.env['MINE_MIN_COUNT'] ?? 100);
const MIN_PMI = Number(process.env['MINE_MIN_PMI'] ?? 4);
const MAX_SHARE = Number(process.env['MINE_MAX_SHARE'] ?? 0.5);
const MIN_SHARE_READING = 0.85;
const ALL_SHAPES = process.env['MINE_ALL_SHAPES'] === '1';

const HAN = /^[㐀-鿿]+$/u;
// 虛詞、代名詞、助詞：和它們黏在一起的多半是片段（「他說」「好了」），不是詞
const FUNCTION = new Set([
  ...'的了是在和與及或也都就還又再很太最更不沒有個這那哪我你妳他她它們說吧嗎呢啊喔哦啦耶嘛呀欸唷囉著過被把讓給對從向跟為以於而但卻則才等',
]);

interface Entry {
  word: string;
  readings: string[][];
  provenance: string[];
  freq?: number;
}

async function* lines(file: string): AsyncGenerator<string> {
  yield* createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
}

async function main(): Promise<void> {
  const lex = new Map<string, Entry>();
  for (const line of (await readFile(lexFile, 'utf8')).split('\n')) {
    if (line) {
      const e = JSON.parse(line) as Entry;
      // 以「沒挖詞的詞典」為準：重跑時輸出一樣，不會因為上次挖的詞已在詞典裡而變少
      if (e.provenance.some((p) => p !== 'mined')) lex.set(e.word, e);
    }
  }

  // 單字讀音分佈：詞典多字詞裡，該字在各讀音下出現的權重（freq+1）
  const charReading = new Map<string, Map<string, number>>();
  for (const e of lex.values()) {
    const chars = [...e.word];
    if (chars.length < 2) continue;
    for (const r of e.readings) {
      if (r.length !== chars.length) continue;
      for (let i = 0; i < chars.length; i++) {
        let m = charReading.get(chars[i]!);
        if (!m) charReading.set(chars[i]!, (m = new Map()));
        m.set(r[i]!, (m.get(r[i]!) ?? 0) + (e.freq ?? 0) + 1);
      }
    }
  }
  const readingOf = (tok: string): string[] | null => {
    const e = lex.get(tok);
    if (!e) return null;
    if (e.readings.length === 1) return e.readings[0]!;
    if ([...tok].length > 1) return null;
    const m = charReading.get(tok);
    if (!m) return null;
    let total = 0;
    let best = '';
    let bestW = 0;
    for (const [r, w] of m) {
      if (!e.readings.some((x) => x[0] === r)) continue;
      total += w;
      if (w > bestW) [best, bestW] = [r, w];
    }
    return total > 0 && bestW / total >= MIN_SHARE_READING ? [best] : null;
  };

  // 第一遍：一元與二元，挑候選
  const uni = new Map<string, number>();
  let N = 0;
  const cand = new Map<string, { a: string; b: string; c: number; pmi: number }>();
  const bigrams: [string, string, number][] = [];
  for await (const line of lines(lmFile)) {
    const t1 = line.indexOf('\t');
    const sec = line.slice(0, t1);
    if (sec === 'wu') {
      const t2 = line.indexOf('\t', t1 + 1);
      const c = Number(line.slice(t1 + 1, t2));
      uni.set(line.slice(t2 + 1), c);
      N += c;
    } else if (sec === 'wb') {
      const t2 = line.indexOf('\t', t1 + 1);
      const c = Number(line.slice(t1 + 1, t2));
      if (c < MIN_COUNT) continue;
      const [a, b] = line.slice(t2 + 1).split(' ') as [string, string];
      if (!a || !b || !HAN.test(a) || !HAN.test(b)) continue;
      const len = [...a].length + [...b].length;
      if (len > 4 || lex.has(a + b) || FUNCTION.has(a) || FUNCTION.has(b)) continue;
      // 兩邊都是多字詞（詳細＋說明）多半是片語，詞二元本來就涵蓋；只收帶黏著單字的
      if (!ALL_SHAPES && [...a].length > 1 && [...b].length > 1) continue;
      bigrams.push([a, b, c]);
    } else if (sec === 'wt') break;
  }
  for (const [a, b, c] of bigrams) {
    const pmi = Math.log((c * N) / (uni.get(a)! * uni.get(b)!));
    if (pmi >= MIN_PMI) cand.set(`${a} ${b}`, { a, b, c, pmi });
  }
  console.log(`[mine] N=${N} 二元候選 ${bigrams.length} → PMI≥${MIN_PMI}: ${cand.size}`);

  // 第二遍：三元表給左右鄰分佈
  const left = new Map<string, Map<string, number>>();
  const right = new Map<string, Map<string, number>>();
  const add = (m: Map<string, Map<string, number>>, k: string, x: string, c: number): void => {
    let s = m.get(k);
    if (!s) m.set(k, (s = new Map()));
    s.set(x, (s.get(x) ?? 0) + c);
  };
  for await (const line of lines(lmFile)) {
    if (!line.startsWith('wt\t')) continue;
    const t2 = line.indexOf('\t', 3);
    const c = Number(line.slice(3, t2));
    const [ctx, w3] = line.slice(t2 + 1).split('\t') as [string, string];
    const [w1, w2] = ctx.split(' ') as [string, string];
    if (w1 && cand.has(`${w1} ${w2}`) && w3 !== '\u0003') add(right, `${w1} ${w2}`, w3, c);
    if (w1 && cand.has(`${w2} ${w3}`)) add(left, `${w2} ${w3}`, w1, c);
  }

  const maxShare = (m: Map<string, number> | undefined, c: number): number =>
    m ? Math.max(0, ...m.values()) / c : 0;
  const out: Entry[] = [];
  const report: string[] = [];
  let noReading = 0;
  let fragment = 0;
  for (const [key, x] of cand) {
    const ls = maxShare(left.get(key), x.c);
    const rs = maxShare(right.get(key), x.c);
    const ra = readingOf(x.a);
    const rb = readingOf(x.b);
    const ok = ls <= MAX_SHARE && rs <= MAX_SHARE;
    report.push(
      `${x.a}${x.b}\t${x.c}\t${x.pmi.toFixed(2)}\t${ls.toFixed(2)}\t${rs.toFixed(2)}\t${
        ra && rb ? [...ra, ...rb].join(' ') : '-'
      }\t${ok ? 'ok' : 'frag'}`,
    );
    if (!ok) {
      fragment++;
      continue;
    }
    if (!ra || !rb) {
      noReading++;
      continue;
    }
    out.push({ word: x.a + x.b, readings: [[...ra, ...rb]], provenance: ['mined'], freq: x.c });
  }
  out.sort((p, q) => p.word.localeCompare(q.word, 'zh-Hant'));
  await writeFile(outFile, out.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  await writeFile(outFile.replace(/\.jsonl$/, '.report.tsv'), report.join('\n') + '\n', 'utf8');
  console.log(`[mine] 碎片 ${fragment}、讀音不明 ${noReading}、收 ${out.length} → ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
