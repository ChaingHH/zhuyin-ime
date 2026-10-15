/**
 * n-gram 語言模型 runtime（預設 interpolated Kneser-Ney；stupid backoff 保留為對照）。
 *
 * 設計對應架構文件 L5：
 * - 詞級三元 P_word(w | 前兩詞) 與字級三元 P_char(c | 前兩字) 為兩個獨立專家，
 *   在解碼器以 log-linear 相加（權重 a、γ），不做線性內插。
 */
import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { HashTable, PerfectTable, type Fingerprint, type QuantBits } from './hashtable.js';

export interface LmJson {
  meta: {
    wordTokens: number;
    charTokens: number;
    trainedAt: string;
    sources: string[];
  };
  wordUni: Record<string, number>;
  /** key: "w1 w2" */
  wordBi: Record<string, number>;
  /** key: "w1 w2\tw" */
  wordTri: Record<string, number>;
  charUni: Record<string, number>;
  /** key: "c1 c2" */
  charBi: Record<string, number>;
  /** key: "c1 c2\tc" */
  charTri: Record<string, number>;
}

export interface NgramIndex {
  uni: Map<string, number>;
  total: number;
  /** KN 接續計數：N1+(• w)＝w 前面出現過幾種不同詞 */
  cont: Map<string, number>;
  /** 二元型別總數 N1+(• •) */
  contTotal: number;
  /** 首詞作為二元上下文：後接計數總和（含剪掉的）、保留的後接型別數與計數和 */
  biTotals: Map<string, number>;
  biTypes: Map<string, number>;
  biKept: Map<string, number>;
  /**
   * "w1 w2" → 欄 0：二元計數；欄 1／2：作為三元上下文時的後接計數總和／型別數。
   * 大表放 typed array（見 hashtable.ts）。
   */
  bi: HashTable | PerfectTable;
  /** "w1 w2\tw" → 三元計數 */
  tri: HashTable | PerfectTable;
}

const BACKOFF = 0.4;

const BIN_MAGIC = 'ZYLMBIN1';
type Blob = [offset: number, bytes: number];
interface BinMap {
  n: number;
  keys: Blob;
  vals: Blob;
}
interface BinTable {
  ncols: number;
  bits: 0 | QuantBits;
  size: number;
  arrays: Blob[];
  /** 'perfect' = PerfectTable（arrays：位移值、指紋、值欄）；省略 = HashTable */
  kind?: 'perfect';
  seed?: number;
}
type BinIndex = { total: number; contTotal: number; bi: BinTable; tri: BinTable } & Record<
  'uni' | 'cont' | 'biTotals' | 'biTypes' | 'biKept',
  BinMap
>;
interface BinHeader {
  meta: LmJson['meta'];
  word: BinIndex;
  char: BinIndex;
}

function emptyIndex(): NgramIndex {
  return {
    uni: new Map(),
    total: 0,
    cont: new Map(),
    contTotal: 0,
    biTotals: new Map(),
    biTypes: new Map(),
    biKept: new Map(),
    bi: new HashTable(3),
    tri: new HashTable(1),
  };
}

const inc = (m: Map<string, number>, k: string, v: number): void => {
  m.set(k, (m.get(k) ?? 0) + v);
};

export interface LoadOptions {
  /** 二元／三元計數低於此值者不存（剪枝）；上下文總量仍含被剪掉的計數，質量流向低階 */
  minBi?: number;
  minTri?: number;
  /** 載入後把計數量化成 16／8（／實驗用 6、4）位元（見 hashtable.ts freeze）；0 = 不量化 */
  quant?: 0 | QuantBits;
  /** 量化後的指紋位元數與雜湊表載入率（freeze 參數） */
  fp?: Fingerprint;
  load?: number;
  /** 量化時改建最小完美雜湊表（PerfectTable）而不是開放定址表；quant 須為 8 或 16 */
  mph?: boolean;
}

/** 剪枝／量化設定的環境變數；runtime 與 pack.ts 共用，有設任何一個時 runtime 改讀 tsv。 */
export const LM_ENV_KEYS = [
  'ZHUYIN_LM_MIN_BI',
  'ZHUYIN_LM_MIN_TRI',
  'ZHUYIN_LM_QUANT',
  'ZHUYIN_LM_FP',
  'ZHUYIN_LM_LOAD',
  'ZHUYIN_LM_MPH',
] as const;

/** 預設 bi>=2 tri>=4 q=8、最小完美雜湊（docs/MEMORY.md：大表 109MB、句 −0.1／0、比開放定址快）。fp／load 只在 MPH=0 時有作用。 */
export function lmOptionsFromEnv(env: Record<string, string | undefined>): LoadOptions {
  return {
    minBi: Number(env['ZHUYIN_LM_MIN_BI'] ?? 2),
    minTri: Number(env['ZHUYIN_LM_MIN_TRI'] ?? 4),
    quant: Number(env['ZHUYIN_LM_QUANT'] ?? 8) as 0 | QuantBits,
    fp: Number(env['ZHUYIN_LM_FP'] ?? 40) as Fingerprint,
    load: Number(env['ZHUYIN_LM_LOAD'] ?? 0.75),
    mph: (env['ZHUYIN_LM_MPH'] ?? '1') === '1',
  };
}

/**
 * 一筆 n-gram 計數併入索引。order：1=uni、2=bi（"w1 w2"）、3=tri（"w1 w2\tw"）。
 * 依賴 .tsv 段落順序：同一專家的二元先於三元。
 */
function addEntry(
  idx: NgramIndex,
  order: number,
  key: string,
  count: number,
  opts: LoadOptions,
): void {
  if (order === 1) {
    inc(idx.uni, key, count);
    idx.total += count;
  } else if (order === 2) {
    const sp = key.indexOf(' ');
    const c1 = key.slice(0, sp);
    inc(idx.biTotals, c1, count);
    inc(idx.cont, key.slice(sp + 1), 1);
    idx.contTotal++;
    if (count < (opts.minBi ?? 1)) return;
    (idx.bi as HashTable).add(key, 0, count);
    inc(idx.biTypes, c1, 1);
    inc(idx.biKept, c1, count);
  } else {
    const ctx = key.slice(0, key.indexOf('\t'));
    // 上下文二元不存在（被剪或從未出現）時 KN 本來就不會用到這個三元
    if (count < (opts.minTri ?? 1) || !idx.bi.get(ctx, 0)) return;
    (idx.tri as HashTable).add(key, 0, count);
    (idx.bi as HashTable).add(ctx, 1, count);
    (idx.bi as HashTable).add(ctx, 2, 1);
  }
}

const SECTIONS: Record<string, ['word' | 'char', number]> = {
  wu: ['word', 1],
  wb: ['word', 2],
  wt: ['word', 3],
  cu: ['char', 1],
  cb: ['char', 2],
  ct: ['char', 3],
};

export class LanguageModel {
  readonly word = emptyIndex();
  readonly char = emptyIndex();
  meta = {} as LmJson['meta'];
  static readonly BOS = '\u0002';

  private constructor() {}

  /**
   * 載入 .json（舊格式）、.tsv（逐行 section\tcount\tkey，train.ts 輸出）
   * 或 .bin（save() 輸出；剪枝／量化在打包時已做完，opts 不再作用）。
   */
  static async load(file: string, opts: LoadOptions = {}): Promise<LanguageModel> {
    const lm = new LanguageModel();
    if (file.endsWith('.bin')) return lm.readBin(file);
    const add = (sec: string, key: string, count: number): void => {
      const s = SECTIONS[sec];
      if (s) addEntry(lm[s[0]], s[1], key, count, opts);
    };
    if (file.endsWith('.json')) {
      const j = JSON.parse(await readFile(file, 'utf8')) as LmJson;
      const parts: Array<[string, Record<string, number>]> = [
        ['wu', j.wordUni],
        ['wb', j.wordBi],
        ['wt', j.wordTri],
        ['cu', j.charUni],
        ['cb', j.charBi],
        ['ct', j.charTri],
      ];
      for (const [sec, rec] of parts) for (const k in rec) add(sec, k, rec[k]!);
      lm.meta = j.meta;
      return lm.finish(opts);
    }
    const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      const t1 = line.indexOf('\t');
      const sec = line.slice(0, t1);
      if (sec === '#meta') {
        lm.meta = JSON.parse(line.slice(t1 + 1)) as LmJson['meta'];
        continue;
      }
      const t2 = line.indexOf('\t', t1 + 1);
      add(sec, line.slice(t2 + 1), Number(line.slice(t1 + 1, t2)));
    }
    return lm.finish(opts);
  }

  private finish(opts: LoadOptions): LanguageModel {
    if (!opts.quant) return this;
    for (const idx of [this.word, this.char])
      for (const k of ['bi', 'tri'] as const) {
        const t = idx[k] as HashTable;
        if (opts.mph) idx[k] = t.toPerfect(opts.quant === 16 ? 16 : 8);
        else t.freeze(opts.quant, opts.load, opts.fp);
      }
    return this;
  }

  /**
   * 存成 .bin：magic、u32 標頭長度、JSON 標頭，之後是 8 位元組對齊的原始陣列。
   * 小表（uni、cont、biTotals…）存成 "
" 連接的鍵＋Float64 值；
   * 大表直接倒出 HashTable 內部陣列，載入時以 view 指向檔案 buffer，不重建。
   * 上下文總量（biTotals、bi 欄 1）含剪掉的計數，所以照存，不從保留項重算。
   */
  async save(file: string): Promise<void> {
    const blobs: Uint8Array[] = [];
    let off = 0;
    const put = (a: ArrayBufferView): [number, number] => {
      const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      const at = off;
      blobs.push(b);
      off += b.byteLength;
      const pad = (8 - (off % 8)) % 8;
      if (pad) blobs.push(new Uint8Array(pad));
      off += pad;
      return [at, b.byteLength];
    };
    const map = (m: Map<string, number>) => ({
      n: m.size,
      keys: put(Buffer.from([...m.keys()].join('\n'), 'utf8')),
      vals: put(Float64Array.from(m.values())),
    });
    const table = (t: HashTable | PerfectTable): BinTable => {
      if (t instanceof PerfectTable) {
        const d = t.dump();
        const arrays = d.arrays.map(put);
        return {
          kind: 'perfect',
          ncols: t.ncols,
          bits: d.bits,
          seed: d.seed,
          size: d.size,
          arrays,
        };
      }
      const d = t.dump();
      return { ncols: t.ncols, bits: d.bits, size: d.size, arrays: d.arrays.map(put) };
    };
    const index = (x: NgramIndex) => ({
      total: x.total,
      contTotal: x.contTotal,
      uni: map(x.uni),
      cont: map(x.cont),
      biTotals: map(x.biTotals),
      biTypes: map(x.biTypes),
      biKept: map(x.biKept),
      bi: table(x.bi),
      tri: table(x.tri),
    });
    const header = Buffer.from(
      JSON.stringify({ meta: this.meta, word: index(this.word), char: index(this.char) }),
      'utf8',
    );
    // 標頭補齊到 8 的倍數，資料區起點才對齊
    const start = Math.ceil((BIN_MAGIC.length + 4 + header.length) / 8) * 8;
    const head = Buffer.alloc(start);
    head.write(BIN_MAGIC, 0, 'latin1');
    head.writeUInt32LE(header.length, BIN_MAGIC.length);
    header.copy(head, BIN_MAGIC.length + 4);
    const fh = await open(file, 'w');
    try {
      await fh.write(head);
      for (const b of blobs) await fh.write(b);
    } finally {
      await fh.close();
    }
  }

  private async readBin(file: string): Promise<LanguageModel> {
    let buf: Uint8Array = await readFile(file);
    // 大檔的 Buffer 自成一塊（byteOffset 0）；小檔可能來自共用池，不對齊就複製一份
    if (buf.byteOffset % 8) buf = new Uint8Array(buf);
    const nb = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    if (nb.toString('latin1', 0, BIN_MAGIC.length) !== BIN_MAGIC)
      throw new Error(`${file} 不是 lm.bin 格式`);
    const hlen = nb.readUInt32LE(BIN_MAGIC.length);
    const h0 = BIN_MAGIC.length + 4;
    const h = JSON.parse(nb.toString('utf8', h0, h0 + hlen)) as BinHeader;
    const base = Math.ceil((h0 + hlen) / 8) * 8;
    const view = <T>(
      C: { new (b: ArrayBuffer, o: number, n: number): T; BYTES_PER_ELEMENT: number },
      [o, n]: [number, number],
    ): T => new C(buf.buffer as ArrayBuffer, buf.byteOffset + base + o, n / C.BYTES_PER_ELEMENT);
    const map = (m: BinMap): Map<string, number> => {
      const out = new Map<string, number>();
      if (!m.n) return out;
      const keys = nb.toString('utf8', base + m.keys[0], base + m.keys[0] + m.keys[1]).split('\n');
      const vals = view(Float64Array, m.vals);
      for (let i = 0; i < m.n; i++) out.set(keys[i]!, vals[i]!);
      return out;
    };
    const table = (t: BinTable): HashTable | PerfectTable => {
      if (t.kind === 'perfect') {
        const [pilots, fp, ...cols] = t.arrays;
        const arrays = [
          view(Uint16Array, pilots!),
          view(Uint16Array, fp!),
          ...cols.map((a) => (t.bits === 16 ? view(Uint16Array, a) : view(Uint8Array, a))),
        ];
        return PerfectTable.restore(t.ncols, t.bits as 8 | 16, t.seed!, t.size, arrays);
      }
      // 與 HashTable.rehash 一致：k1 Uint32；量化後 k2 Uint16、值欄 bits 位元
      const Col = (t.bits === 16 ? Uint16Array : t.bits ? Uint8Array : Uint32Array) as {
        new (b: ArrayBuffer, o: number, n: number): ArrayBufferView;
        BYTES_PER_ELEMENT: number;
      };
      const [k1, k2, ...cols] = t.arrays;
      const arrays = [
        view(Uint32Array, k1!),
        // k2 寬度依指紋位元數：每槽 0／1／2／4 bytes（k1 每槽 4 bytes）
        k2![1] * 2 === k1![1]
          ? view(Uint16Array, k2!)
          : k2![1] === k1![1]
            ? view(Uint32Array, k2!)
            : view(Uint8Array, k2!),
        ...cols.map((a) => view(Col, a)),
      ];
      return HashTable.restore(t.ncols, t.bits, t.size, arrays);
    };
    for (const k of ['word', 'char'] as const) {
      const x = h[k];
      Object.assign(this[k], {
        total: x.total,
        contTotal: x.contTotal,
        uni: map(x.uni),
        cont: map(x.cont),
        biTotals: map(x.biTotals),
        biTypes: map(x.biTypes),
        biKept: map(x.biKept),
        bi: table(x.bi),
        tri: table(x.tri),
      });
    }
    this.meta = h.meta;
    return this;
  }

  /** 平滑法：'kn' = interpolated Kneser-Ney；'sb' = stupid backoff（舊行為） */
  smoothing: 'kn' | 'sb' = 'kn';
  /** KN 折扣值 */
  discount = 0.75;

  /**
   * Interpolated Kneser-Ney（三元→二元→接續一元，再墊一點真 unigram 給沒見過的詞）。
   * 三元上下文分母用二元計數 c(c1 c2)：被剪枝（count<2）的三元質量自動流向低階。
   */
  private static knLogProb(idx: NgramIndex, w: string, c1: string, c2: string, D: number): number {
    // 一元：接續機率，與真 unigram 混一點避免 0
    const pCont = (idx.cont.get(w) ?? 0) / Math.max(idx.contTotal, 1);
    const pUni = ((idx.uni.get(w) ?? 0) + 0.5) / Math.max(idx.total, 1);
    let p = 0.9 * pCont + 0.1 * pUni;
    // 二元 P(w | c2)
    const bt = idx.biTotals.get(c2);
    if (bt) {
      // 剪掉的二元計數（bt − 保留和）併入退回權重，與三元同理
      const c = idx.bi.get(`${c2} ${w}`);
      const types = idx.biTypes.get(c2) ?? 0;
      const kept = idx.biKept.get(c2) ?? 0;
      p = Math.max(c - D, 0) / bt + ((D * types + (bt - kept)) / bt) * p;
    }
    // 三元 P(w | c1 c2)
    const ctx = `${c1} ${c2}`;
    const ctxCount = idx.bi.get(ctx, 0);
    if (ctxCount) {
      const tt = idx.bi.get(ctx, 1);
      const types = idx.bi.get(ctx, 2);
      const c = types ? idx.tri.get(`${ctx}\t${w}`) : 0;
      const total = Math.max(ctxCount, tt);
      p = Math.max(c - D, 0) / total + ((D * types + (total - tt)) / total) * p;
    }
    return Math.log(p);
  }

  private static logProb(idx: NgramIndex, w: string, c1: string, c2: string): number {
    const ctx = `${c1} ${c2}`;
    const tt = idx.bi.get(ctx, 1);
    if (tt) {
      const cw = idx.tri.get(`${ctx}\t${w}`);
      if (cw) return Math.log(cw / tt);
    }
    // 退回二元：以 c2（最近的詞）為上下文
    const biCount = idx.bi.get(`${c2} ${w}`);
    if (biCount) {
      // P(w | c2) = count(c2,w) / count(c2,*)——正規化在「上下文」上，不是詞自身頻率
      const total2 = idx.biTotals.get(c2) ?? 0;
      return Math.log(BACKOFF * (biCount / total2));
    }
    // unigram（含 unseen 的極小機率）
    const u = idx.uni.get(w) ?? 0.5;
    return Math.log(BACKOFF * BACKOFF * (u / Math.max(idx.total, 1)));
  }

  /** log P_word(w | w1 w2)，w1/w2 為前兩詞（BOS 以空字串表示）。 */
  wordLogProb(w: string, w1: string, w2: string): number {
    if (this.smoothing === 'kn')
      return LanguageModel.knLogProb(this.word, w, w1, w2, this.discount);
    return LanguageModel.logProb(this.word, w, w1, w2);
  }

  /** log P_char(c | c1 c2)。 */
  charLogProb(c: string, c1: string, c2: string): number {
    if (this.smoothing === 'kn')
      return LanguageModel.knLogProb(this.char, c, c1, c2, this.discount);
    return LanguageModel.logProb(this.char, c, c1, c2);
  }

  /** 字級專家：一個詞全部字元的條件機率和；字上下文隨詞內字元推進。 */
  charSequenceLogProb(word: string, charContext: readonly [string, string]): number {
    let [c1, c2] = charContext;
    let sum = 0;
    for (const ch of word) {
      sum += this.charLogProb(ch, c1, c2);
      c1 = c2;
      c2 = ch;
    }
    return sum;
  }
}
