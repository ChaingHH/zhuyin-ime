import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * LM 訓練（Phase 3.5）：unigram-DP 斷詞（維特比全域最優）取代貪婪最長匹配。
 * 貪婪只顧眼前，會把「可以憑條碼」切成讓 bigram「憑+條碼」拿不到計數的切法；
 * DP 以詞頻先驗挑全域最優。trigram 保留 count≥2，bigram 全保留。
 */
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(thisDir, '..', '..', '..');

interface Args {
  corpusDir: string;
  out: string;
  minTri: number;
}

const argv = process.argv.slice(2);
const args: Args = {
  corpusDir: argv[0] ?? path.join(REPO, 'data', 'processed', 'corpus'),
  out: argv[1] ?? path.join(REPO, 'data', 'models', 'lm.tsv'),
  minTri: Number(process.env['LM_MIN_TRI'] ?? 2),
};

async function main(): Promise<void> {
  const lexFile = path.join(REPO, 'data', 'processed', 'lexicon.jsonl');
  const dictFreq = new Map<string, number>();
  let maxLen = 1;
  for (const line of (await readFile(lexFile, 'utf8')).split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line) as { word: string; freq?: number };
    if (e.word.length > maxLen) maxLen = e.word.length;
    dictFreq.set(e.word, e.freq ?? 0);
  }
  console.log(`[dict] ${dictFreq.size} 詞，最長 ${maxLen}`);

  const costCache = new Map<string, number>();
  // 每詞固定代價：越大越傾向長詞（抑制過切）。以 token 總數對照貪婪基線校準。
  // 必須大於高頻單字的 log(freq)（約 11–13.5），否則單字成本為負、DP 反而鼓勵切碎。
  const TOKEN_PENALTY = Number.parseFloat(process.env['LM_TOKEN_PENALTY'] ?? '14');
  function wordCost(w: string): number {
    const hit = costCache.get(w);
    if (hit !== undefined) return hit;
    const f = dictFreq.get(w);
    // 成本 = TOKEN_PENALTY − log(f+1)：每個 token 固定代價抑制過度切分；
    // 未登錄單字另加高價。頻率越高越便宜，長詞需靠真實頻次取勝。
    const c =
      f === undefined ? TOKEN_PENALTY + Math.log(1 / 0.05) : TOKEN_PENALTY - Math.log(f + 1);
    costCache.set(w, c);
    return c;
  }

  /** unigram-DP：best[i] = 前 i 字最小總成本，back 回溯切點。 */
  function segment(sentence: string): string[] {
    const n = sentence.length;
    const best = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
    const back = new Array<number>(n + 1).fill(-1);
    best[0]! = 0;
    for (let i = 1; i <= n; i++) {
      const maxL = Math.min(maxLen, i);
      for (let len = 1; len <= maxL; len++) {
        const w = sentence.slice(i - len, i);
        if (len > 1 && !dictFreq.has(w)) continue;
        const c = best[i - len]! + wordCost(w);
        const cur = best[i] ?? Number.POSITIVE_INFINITY;
        if (c < cur) {
          best[i] = c;
          back[i] = i - len;
        }
      }
    }
    const tokens: string[] = [];
    let i = n;
    while (i > 0) {
      const j = back[i]!;
      tokens.push(sentence.slice(j, i));
      i = j;
    }
    return tokens.reverse();
  }

  // 分片計數：V8 單一 Map 上限約 1677 萬筆，大語料的三元組型別數會超過
  const wUni = new Map<string, number>();
  const wBi = new Counter();
  const wTri = new Counter();
  const cUni = new Map<string, number>();
  const cBi = new Counter();
  const cTri = new Counter();

  const inc = (m: Map<string, number> | Counter, k: string): void => {
    m.set(k, (m.get(k) ?? 0) + 1);
  };
  const BOS = '\u0002';
  // 句尾符：讓 LM 學到句尾分佈（吧 vs 巴）
  const EOS = '\u0003';
  const CJK = /[\u3400-\u9FFF]/;

  let wordTokens = 0;
  let charTokens = 0;
  // 污染防護：留測評測集的句子不得進入訓練計數
  const heldout = new Set<string>();
  const evalDir = path.join(REPO, 'eval');
  for (const ev of ['colloquial.jsonl', 'written.jsonl']) {
    try {
      const raw = await readFile(path.join(evalDir, ev), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.startsWith('{"text"')) continue;
        try {
          heldout.add((JSON.parse(line) as { text: string }).text);
        } catch {
          /* skip */
        }
      }
    } catch {
      /* 評測集不存在時跳過 */
    }
  }
  console.log(`[guard] 排除留測句 ${heldout.size}`);

  const files = ['colloquial.txt', 'written.txt'].map((f) => path.join(args.corpusDir, f));
  for (const file of files) {
    if (!existsSync(file)) {
      console.warn(`[skip] ${file} 不存在`);
      continue;
    }
    // 串流讀：大語料超過 V8 單一字串上限
    const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const sentence of rl) {
      if (!sentence) continue;
      if (heldout.has(sentence)) continue;

      const chars: string[] = [BOS, BOS];
      for (const ch of sentence) if (CJK.test(ch)) chars.push(ch);
      chars.push(EOS);

      // 詞級句首以空字串填充（解碼器句首狀態即 w1=w2=''），句尾補 EOS
      const tokens = ['', '', ...segment(sentence), EOS];

      for (let k = 2; k < tokens.length; k++) {
        const w = tokens[k]!;
        wordTokens++;
        if (w !== EOS) inc(wUni, w);
        inc(wBi, `${tokens[k - 1]} ${w}`);
        inc(wTri, `${tokens[k - 2]} ${tokens[k - 1]}\t${w}`);
      }
      for (let k = 2; k < chars.length; k++) {
        charTokens++;
        const c = chars[k]!;
        if (c !== EOS) inc(cUni, c);
        inc(cBi, `${chars[k - 1]} ${c}`);
        inc(cTri, `${chars[k - 2]} ${chars[k - 1]}\t${c}`);
      }
    }
  }

  // 詞典地板計數：語料未出現的詞典詞，由成字頻率合成先驗覆蓋。
  // 詞典收錄本身即是證據（萌典收了「陰莖」，不代表維基/PTT 抽樣會說它）。
  // floor(w) = exp(平均 log(字頻+1) − FLOOR_PENALTY)；可由 LM_FLOOR_PENALTY 調整，0=關閉。
  const FLOOR_PENALTY = Number.parseFloat(process.env['LM_FLOOR_PENALTY'] ?? '6');
  if (FLOOR_PENALTY > 0) {
    let injected = 0;
    for (const [w] of dictFreq) {
      if (wUni.has(w) || [...w].length < 2) continue;
      let logSum = 0;
      let ok = true;
      for (const ch of w) {
        const c = cUni.get(ch);
        if (c === undefined) {
          ok = false;
          break;
        }
        logSum += Math.log(c + 1);
      }
      if (!ok) continue;
      const floor = Math.exp(logSum / [...w].length - FLOOR_PENALTY);
      if (floor >= 1) {
        wUni.set(w, Math.round(floor));
        injected++;
      }
    }
    console.log(`[floor] 注入詞典詞地板計數 ${injected}`);
  }

  // 逐行輸出（section\tcount\tkey）：大模型超過 V8 單一字串上限，不能用 JSON.stringify
  const MIN_BI = Number(process.env['LM_MIN_BI'] ?? 1);
  const out = createWriteStream(args.out, 'utf8');
  const write = async (line: string): Promise<void> => {
    if (!out.write(line + '\n')) await new Promise<void>((r) => out.once('drain', () => r()));
  };
  const meta = {
    wordTokens,
    charTokens,
    trainedAt: new Date().toISOString(),
    sources: files.map((f) => path.basename(f)),
  };
  await write(`#meta\t${JSON.stringify(meta)}`);
  const sizes: Record<string, number> = {};
  const dump = async (
    sec: string,
    entries: Iterable<[string, number]>,
    min: number,
  ): Promise<void> => {
    let n = 0;
    for (const [k, v] of entries) {
      if (v < min) continue;
      await write(`${sec}\t${v}\t${k}`);
      n++;
    }
    sizes[sec] = n;
  };
  await dump('wu', wUni, 1);
  await dump('wb', wBi.entries(), MIN_BI);
  await dump('wt', wTri.entries(), args.minTri);
  await dump('cu', cUni, 1);
  await dump('cb', cBi.entries(), MIN_BI);
  await dump('ct', cTri.entries(), args.minTri);
  await new Promise<void>((r) => out.end(() => r()));
  console.log(`[lm] 詞 ${wordTokens} / 字 ${charTokens}; ${JSON.stringify(sizes)} -> ${args.out}`);
}

/** 分片計數器：以字串雜湊分到 64 個 Map。 */
class Counter {
  private readonly shards = Array.from({ length: 64 }, () => new Map<string, number>());
  private shard(k: string): Map<string, number> {
    let h = 0;
    for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0;
    return this.shards[h & 63]!;
  }
  get(k: string): number | undefined {
    return this.shard(k).get(k);
  }
  set(k: string, v: number): void {
    this.shard(k).set(k, v);
  }
  *entries(): Generator<[string, number]> {
    for (const m of this.shards) yield* m;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
