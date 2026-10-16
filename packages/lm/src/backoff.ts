/**
 * 退回式（backoff）語言模型：打包時把 interpolated KN 的機率與退回權重算好、量化後存起來，
 * 查詢時只做查表加法，不再算 KN，也不需要 uni／cont／biTotals 等小 Map（docs/MEMORY.md）。
 *
 * 對有存的 n-gram 存「完整」的內插機率；沒存的用 α(上下文)·低階機率。
 * 不剪枝時 α 恰好等於 KN 的退回權重 γ，與 LanguageModel 逐位元以外完全相同（只差 float32）。
 *
 * 剪枝（buildBackoff）：每筆 n-gram 的分數 = 出現比例 × |log 原機率 − log 退回後機率|
 * （Seymore–Rosenfeld 加權差異，Stolcke 熵剪枝的簡化版），低於 θ 的刪掉；
 * 被留下的三元的上下文二元一定保留（α 存在那裡）。刪完重算 α，讓每個上下文的機率總和維持 1。
 */
import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { HashTable, PerfectTable, floatBits } from './hashtable.js';
import type { LanguageModel, LmJson, NgramIndex } from './model.js';

interface Expert {
  /** 詞 → 欄 0：log P1(w)；欄 1：log α(w 當二元上下文) */
  uni: PerfectTable;
  /** "c2 w" → 欄 0：log P2(w|c2)；欄 1：log α("c2 w" 當三元上下文) */
  bi: PerfectTable;
  /** "c1 c2\tw" → log P3(w|c1 c2) */
  tri: PerfectTable;
  /** 詞彙外的詞的 log P1 */
  unseen: number;
}

export class BackoffLM {
  constructor(
    readonly word: Expert,
    readonly char: Expert,
    readonly meta: LmJson['meta'],
  ) {}

  /** 表裡的機率都是負的，查不到回 0；退回權重查不到也是 0（α=1，正是沒存的意思）。 */
  private static logProb(x: Expert, w: string, c1: string, c2: string): number {
    const p3 = x.tri.get3(c1, c2, w);
    if (p3) return p3;
    let a = x.bi.get2(c1, c2, 1);
    const p2 = x.bi.get2(c2, w, 0);
    if (p2) return a + p2;
    a += x.uni.get(c2, 1);
    return a + (x.uni.get(w, 0) || x.unseen);
  }

  wordLogProb(w: string, w1: string, w2: string): number {
    return BackoffLM.logProb(this.word, w, w1, w2);
  }

  charLogProb(c: string, c1: string, c2: string): number {
    return BackoffLM.logProb(this.char, c, c1, c2);
  }

  charSequenceLogProb(word: string, charContext: readonly [string, string]): number {
    let [c1, c2] = charContext;
    let sum = 0;
    for (const ch of word) {
      sum += BackoffLM.logProb(this.char, ch, c1, c2);
      c1 = c2;
      c2 = ch;
    }
    return sum;
  }

  /** 各表佔用位元組數 */
  get bytes(): number {
    return [this.word, this.char].reduce((s, x) => s + x.uni.bytes + x.bi.bytes + x.tri.bytes, 0);
  }

  /** 各表筆數（詞一／詞二／詞三／字一／字二／字三） */
  get sizes(): number[] {
    return [this.word, this.char].flatMap((x) => [x.uni.size, x.bi.size, x.tri.size]);
  }

  /**
   * magic、u32 標頭長度、JSON 標頭，之後是 8 位元組對齊的原始陣列（表陣列＋每欄的碼本）。
   * 載入時陣列直接 view 到檔案 buffer。
   */
  async save(file: string): Promise<void> {
    const blobs: Uint8Array[] = [];
    let off = 0;
    const put = (a: ArrayBufferView): Blob => {
      blobs.push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
      const at = off;
      off += a.byteLength;
      const pad = (8 - (off % 8)) % 8;
      if (pad) blobs.push(new Uint8Array(pad));
      off += pad;
      return [at, a.byteLength];
    };
    const table = (t: PerfectTable): BinTable => {
      const d = t.dump();
      return {
        ncols: t.ncols,
        bits: d.bits,
        seed: d.seed,
        size: d.size,
        arrays: d.arrays.map(put),
        luts: t.luts.map(put),
        ...(d.arrays[1] instanceof Uint32Array ? { fpBits: 32 as const } : {}),
      };
    };
    const expert = (x: Expert): BinExpert => ({
      unseen: x.unseen,
      uni: table(x.uni),
      bi: table(x.bi),
      tri: table(x.tri),
    });
    const header = Buffer.from(
      JSON.stringify({ meta: this.meta, word: expert(this.word), char: expert(this.char) }),
      'utf8',
    );
    const start = Math.ceil((MAGIC.length + 4 + header.length) / 8) * 8;
    const head = Buffer.alloc(start);
    head.write(MAGIC, 0, 'latin1');
    head.writeUInt32LE(header.length, MAGIC.length);
    header.copy(head, MAGIC.length + 4);
    const fh = await open(file, 'w');
    try {
      await fh.write(head);
      for (const b of blobs) await fh.write(b);
    } finally {
      await fh.close();
    }
  }

  static async load(file: string): Promise<BackoffLM> {
    let buf: Uint8Array = await readFile(file);
    if (buf.byteOffset % 8) buf = new Uint8Array(buf);
    const nb = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    if (nb.toString('latin1', 0, MAGIC.length) !== MAGIC) throw new Error(`${file} 不是退回式模型`);
    const hlen = nb.readUInt32LE(MAGIC.length);
    const h0 = MAGIC.length + 4;
    const h = JSON.parse(nb.toString('utf8', h0, h0 + hlen)) as {
      meta: LmJson['meta'];
      word: BinExpert;
      char: BinExpert;
    };
    const base = buf.byteOffset + Math.ceil((h0 + hlen) / 8) * 8;
    const view = <T>(
      C: { new (b: ArrayBuffer, o: number, n: number): T; BYTES_PER_ELEMENT: number },
      [o, n]: Blob,
    ): T => new C(buf.buffer as ArrayBuffer, base + o, n / C.BYTES_PER_ELEMENT);
    const table = (t: BinTable): PerfectTable => {
      const [pilots, fp, ...cols] = t.arrays;
      return PerfectTable.restore(
        t.ncols,
        t.bits,
        t.seed,
        t.size,
        [
          view(Uint16Array, pilots!),
          t.fpBits === 32 ? view(Uint32Array, fp!) : view(Uint16Array, fp!),
          ...cols.map((a) => (t.bits === 16 ? view(Uint16Array, a) : view(Uint8Array, a))),
        ],
        t.luts.map((a) => view(Float64Array, a)),
      );
    };
    const expert = (x: BinExpert): Expert => ({
      unseen: x.unseen,
      uni: table(x.uni),
      bi: table(x.bi),
      tri: table(x.tri),
    });
    return new BackoffLM(expert(h.word), expert(h.char), h.meta);
  }
}

const MAGIC = 'ZYLMBO01';
type Blob = [offset: number, bytes: number];
interface BinTable {
  ncols: number;
  bits: 8 | 16;
  seed: number;
  size: number;
  arrays: Blob[];
  luts: Blob[];
  /** 省略 = 16 */
  fpBits?: 32;
}
interface BinExpert {
  unseen: number;
  uni: BinTable;
  bi: BinTable;
  tri: BinTable;
}

// ---------------------------------------------------------------- 建置（打包時）

/**
 * 未剪枝 KN 模型的各部件（與 LanguageModel.knLogProb 同一套公式，拆開才拿得到 γ 與低階機率）。
 * idx 須是 minBi=minTri=1、未量化載入的計數。
 */
class Kn {
  constructor(
    readonly idx: NgramIndex,
    private readonly D = 0.75,
  ) {}

  p1(w: string): number {
    const x = this.idx;
    const pCont = (x.cont.get(w) ?? 0) / Math.max(x.contTotal, 1);
    const pUni = ((x.uni.get(w) ?? 0) + 0.5) / Math.max(x.total, 1);
    return 0.9 * pCont + 0.1 * pUni;
  }

  /** c2 當二元上下文的退回權重；c2 沒當過上下文時 undefined（二元層直接等於一元） */
  g2(c2: string): number | undefined {
    const bt = this.idx.biTotals.get(c2);
    if (!bt) return undefined;
    const types = this.idx.biTypes.get(c2) ?? 0;
    const kept = this.idx.biKept.get(c2) ?? 0;
    return (this.D * types + (bt - kept)) / bt;
  }

  p2(w: string, c2: string): number {
    const g = this.g2(c2);
    if (g === undefined) return this.p1(w);
    const bt = this.idx.biTotals.get(c2)!;
    return Math.max(this.idx.bi.get2(c2, w) - this.D, 0) / bt + g * this.p1(w);
  }

  /** [退回權重, 分母]；c1 c2 沒當過上下文時 undefined */
  g3(c1: string, c2: string): [number, number] | undefined {
    const ctx = this.idx.bi.get2(c1, c2, 0);
    if (!ctx) return undefined;
    const tt = this.idx.bi.get2(c1, c2, 1);
    const types = this.idx.bi.get2(c1, c2, 2);
    const total = Math.max(ctx, tt);
    return [(this.D * types + (total - tt)) / total, total];
  }

  p3(w: string, c1: string, c2: string): number {
    const g = this.g3(c1, c2);
    if (!g) return this.p2(w, c2);
    return Math.max(this.idx.tri.get3(c1, c2, w) - this.D, 0) / g[1] + g[0] * this.p2(w, c2);
  }
}

/** 依 tsv 行序存的分數：每專家二元、三元各一條 */
export type NgramScores = Record<'word' | 'char', { bi: Float32Array; tri: Float32Array }>;

const SECTIONS: Record<string, ['word' | 'char', 'bi' | 'tri']> = {
  wb: ['word', 'bi'],
  wt: ['word', 'tri'],
  cb: ['char', 'bi'],
  ct: ['char', 'tri'],
};

async function* ngramLines(tsv: string): AsyncGenerator<[string, number, string]> {
  const rl = createInterface({ input: createReadStream(tsv, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const t1 = line.indexOf('\t');
    const t2 = line.indexOf('\t', t1 + 1);
    yield [line.slice(0, t1), Number(line.slice(t1 + 1, t2)), line.slice(t2 + 1)];
  }
}

/** 三元鍵 "c1 c2\tw" → [c1, c2, w] */
function splitTri(key: string): [string, string, string] {
  const t = key.indexOf('\t');
  const sp = key.indexOf(' ');
  return [key.slice(0, sp), key.slice(sp + 1, t), key.slice(t + 1)];
}

function splitBi(key: string): [string, string] {
  const sp = key.indexOf(' ');
  return [key.slice(0, sp), key.slice(sp + 1)];
}

class Floats {
  private a = new Float32Array(1 << 16);
  n = 0;
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done(): Float32Array {
    return this.a.slice(0, this.n);
  }
}

/** 每筆二元／三元的剪枝分數（出現比例 × |log 原機率 − log 退回後機率|）。full 須是未剪枝計數模型。 */
export async function scoreNgrams(full: LanguageModel, tsv: string): Promise<NgramScores> {
  const kn = { word: new Kn(full.word), char: new Kn(full.char) };
  const acc = {
    word: { bi: new Floats(), tri: new Floats() },
    char: { bi: new Floats(), tri: new Floats() },
  };
  for await (const [sec, count, key] of ngramLines(tsv)) {
    const s = SECTIONS[sec];
    if (!s) continue;
    const k = kn[s[0]];
    const share = count / Math.max(k.idx.total, 1);
    if (s[1] === 'bi') {
      const [c2, w] = splitBi(key);
      const bo = k.g2(c2)! * k.p1(w);
      acc[s[0]].bi.push(share * Math.abs(Math.log(k.p2(w, c2)) - Math.log(bo)));
    } else {
      const [c1, c2, w] = splitTri(key);
      const g = k.g3(c1, c2);
      // 上下文二元不存在時 KN 根本用不到這個三元：分數 −1，θ≥0 時必刪
      if (!g) {
        acc[s[0]].tri.push(-1);
        continue;
      }
      const lower = k.p2(w, c2);
      acc[s[0]].tri.push(share * Math.abs(Math.log(k.p3(w, c1, c2)) - Math.log(g[0] * lower)));
    }
  }
  const done = (x: { bi: Floats; tri: Floats }) => ({ bi: x.bi.done(), tri: x.tri.done() });
  return { word: done(acc.word), char: done(acc.char) };
}

/**
 * 四張表（詞二、詞三、字二、字三）的分數各乘上權重，再取「總共保留 keep 筆」的門檻 θ。
 * 權重只改表之間的分配：預設 1:1:2:2（字級加倍）在 6M 筆時比 1:1:1:1 好 0.7／−0.2 點（docs/MEMORY.md）。
 * 回傳加權後的分數（交給 buildBackoff）與 θ；被留下的三元的上下文二元另外保留，實際筆數會略多。
 */
export function selectTop(
  scores: NgramScores,
  keep: number,
  weights: readonly number[] = [1, 1, 2, 2],
): { scores: NgramScores; theta: number } {
  const [wb, wt, cb, ct] = [scores.word.bi, scores.word.tri, scores.char.bi, scores.char.tri].map(
    (a, i) => a.map((v) => (v < 0 ? v : v * weights[i]!)),
  );
  const all = new Float32Array(wb!.length + wt!.length + cb!.length + ct!.length);
  let o = 0;
  for (const a of [wb!, wt!, cb!, ct!]) {
    all.set(a, o);
    o += a.length;
  }
  all.sort();
  return {
    scores: { word: { bi: wb!, tri: wt! }, char: { bi: cb!, tri: ct! } },
    theta: all[Math.max(0, all.length - Math.round(keep))]!,
  };
}

export interface BuildOptions {
  /** 分數低於此值的 n-gram 刪掉；0 = 全留 */
  theta: number;
  /** 二元／三元機率的量化位元數（一元固定 16） */
  bits?: 8 | 16;
  /** 二元／三元的指紋位元數。查不到的鍵誤中時會拿到別筆的整個機率（計數模型只多一點折扣計數），所以比計數模型怕誤中 */
  fpBits?: 16 | 32;
}

/** α = 剩下的質量 / 低階在沒存的詞上的質量；分母太小（低階沒正規化好）時退回 KN 原本的 γ。 */
function alpha(sumP: number, sumLower: number, fallback: number): number {
  const den = 1 - sumLower;
  return den > 1e-6 ? Math.max(1 - sumP, 1e-12) / den : fallback;
}

/** 存進機率欄的 log P：0 在表裡代表「沒存」，P 恰好是 1 時也要存成負值 */
const logP = (p: number): number => Math.min(Math.log(p), -1e-6);

function addSums(m: Map<string, [number, number]>, k: string, p: number, lower: number): void {
  const v = m.get(k);
  if (v) {
    v[0] += p;
    v[1] += lower;
  } else m.set(k, [p, lower]);
}

/**
 * 從未剪枝計數模型與分數建出退回式模型。要讀 tsv 兩次（第一次標出被留下的三元的上下文）。
 * full 須以 { minBi: 1, minTri: 1 } 未量化載入同一個 tsv；scores 來自 scoreNgrams。
 */
export async function buildBackoff(
  full: LanguageModel,
  tsv: string,
  scores: NgramScores,
  opts: BuildOptions,
): Promise<BackoffLM> {
  const keep = (e: 'word' | 'char', o: 'bi' | 'tri', i: number): boolean =>
    scores[e][o][i]! >= opts.theta;
  const experts = ['word', 'char'] as const;
  const state = (e: 'word' | 'char') => ({
    kn: new Kn(full[e]),
    need: new HashTable(1),
    bi: new HashTable(2),
    tri: new HashTable(1),
    sum2: new Map<string, [number, number]>(),
    sum3: new Map<string, [number, number]>(),
    alpha2: null as Map<string, number> | null,
    i: { bi: 0, tri: 0 },
  });
  const st = { word: state('word'), char: state('char') };

  // 第一遍：被留下的三元，其上下文二元必須保留（α 存在那裡）
  for await (const [sec, , key] of ngramLines(tsv)) {
    const s = SECTIONS[sec];
    if (!s || s[1] !== 'tri') continue;
    const x = st[s[0]];
    if (keep(s[0], 'tri', x.i.tri++)) x.need.add(key.slice(0, key.indexOf('	')), 0, 1);
  }

  const finish2 = (x: ReturnType<typeof state>): Map<string, number> => {
    const m = new Map<string, number>();
    for (const [c2, [p, lower]] of x.sum2) m.set(c2, alpha(p, lower, x.kn.g2(c2) ?? 1));
    return m;
  };

  // 第二遍：留下的二元、三元存完整 KN 機率，累加每個上下文的質量
  for (const e of experts) st[e].i = { bi: 0, tri: 0 };
  for await (const [sec, , key] of ngramLines(tsv)) {
    const s = SECTIONS[sec];
    if (!s) continue;
    const x = st[s[0]];
    const k = x.kn;
    if (s[1] === 'bi') {
      if (!keep(s[0], 'bi', x.i.bi++) && !x.need.has(key)) continue;
      const [c2, w] = splitBi(key);
      const p = k.p2(w, c2);
      x.bi.add(key, 0, floatBits(logP(p)));
      addSums(x.sum2, c2, p, k.p1(w));
    } else {
      if (!keep(s[0], 'tri', x.i.tri++)) continue;
      const [c1, c2, w] = splitTri(key);
      const p = k.p3(w, c1, c2);
      x.tri.add(key, 0, floatBits(logP(p)));
      // 低階用剪枝後的二元層：二元有留就是原值，沒留就是 α2·P1
      x.alpha2 ??= finish2(x);
      const lower = x.bi.get2(c2, w, 0) ? k.p2(w, c2) : (x.alpha2.get(c2) ?? 1) * k.p1(w);
      addSums(x.sum3, `${c1} ${c2}`, p, lower);
    }
  }

  const out = experts.map((e): Expert => {
    const x = st[e];
    const k = x.kn;
    const a2 = (x.alpha2 ??= finish2(x));
    for (const [ctx, [p, lower]] of x.sum3) {
      const [c1, c2] = splitBi(ctx);
      x.bi.add(ctx, 1, floatBits(Math.log(alpha(p, lower, k.g3(c1, c2)?.[0] ?? 1))));
    }
    const uni = new HashTable(2);
    // 三種鍵都要：EOS 只出現在 cont（只當過後接詞），漏掉它句尾機率會變成詞彙外
    for (const w of new Set([
      ...k.idx.uni.keys(),
      ...k.idx.cont.keys(),
      ...k.idx.biTotals.keys(),
    ])) {
      uni.add(w, 0, floatBits(logP(k.p1(w))));
      const a = a2.get(w);
      if (a !== undefined && a !== 1) uni.add(w, 1, floatBits(Math.log(a)));
    }
    return {
      uni: uni.toPerfectFloat(16),
      bi: x.bi.toPerfectFloat(opts.bits ?? 8, opts.fpBits),
      tri: x.tri.toPerfectFloat(opts.bits ?? 8, opts.fpBits),
      unseen: Math.log((0.1 * 0.5) / Math.max(k.idx.total, 1)),
    };
  });
  return new BackoffLM(out[0]!, out[1]!, full.meta);
}
