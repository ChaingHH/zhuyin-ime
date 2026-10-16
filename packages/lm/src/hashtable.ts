/**
 * 開放定址雜湊表：key 只存兩組 32-bit 雜湊（不存字串），值為 Uint32 欄位。
 *
 * 為什麼不用 Map：數千萬筆 n-gram 存成 JS 物件時，每次 major GC 都要走過整個 heap
 * （實測每句約 700ms，L6 重排的大張量會頻繁觸發）。typed array 內容 GC 不掃描。
 * 64-bit 指紋在 5000 萬筆內的任意碰撞機率約 1e-4，對機率估計無實質影響。
 */
let h1 = 0;
let h2 = 0;

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// 逐字元累加的雜湊狀態：分段餵入（feed／feedCode）與一次餵整個字串的結果相同，
// 所以查 "c2 w" 時不必先組出字串（解碼時每鍵上萬次查詢，組字串是主要垃圾來源之一）。
let fa = 0;
let fb = 0;
let flen = 0;

function feed(s: string): void {
  let a = fa;
  let b = fb;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = (Math.imul(b, 31) + c) | 0;
  }
  fa = a;
  fb = b;
  flen += s.length;
}

function feedCode(c: number): void {
  fa = Math.imul(fa ^ c, 0x01000193);
  fb = (Math.imul(fb, 31) + c) | 0;
  flen++;
}

/** 收尾：算出兩組雜湊到模組變數 h1/h2（避免每次查詢配置 tuple）。 */
function finish(): void {
  h1 = fmix(fa);
  h2 = fmix(fb ^ flen);
  // k1=0 保留給空槽
  if (h1 === 0) h1 = 1;
}

function hashKey(key: string): void {
  fa = 0x811c9dc5;
  fb = 0;
  flen = 0;
  feed(key);
  finish();
}

/** 等同 hashKey(`${x} ${y}`)（二元鍵、三元上下文） */
function hash2(x: string, y: string): void {
  hash2Raw(x, y);
  finish();
}

/** 等同 hashKey(`${x} ${y}\t${z}`)（三元鍵） */
function hash3(x: string, y: string, z: string): void {
  hash2Raw(x, y);
  feedCode(9);
  feed(z);
  finish();
}

/** 餵入 `${x} ${y}`，不收尾 */
function hash2Raw(x: string, y: string): void {
  fa = 0x811c9dc5;
  fb = 0;
  flen = 0;
  feed(x);
  feedCode(32);
  feed(y);
}

/**
 * 計數的對數量化碼本：小於 exact 的值原樣存，以上按等比級距編碼到 2^bits 個碼，
 * 上限 2^32。16 位元：exact=4096，相對誤差約 1e-4；8 位元：exact=16，約 4%。
 */
export interface Codebook {
  encode: (v: number) => number;
  lut: Float64Array;
}

function codebook(bits: QuantBits): Codebook {
  const n = 1 << bits;
  const exact = { 16: 4096, 8: 16, 6: 8, 4: 4 }[bits];
  const logR = Math.log(2 ** 32 / exact) / (n - 1 - exact);
  const lut = new Float64Array(n);
  for (let c = 0; c < n; c++) lut[c] = c < exact ? c : exact * Math.exp((c - exact) * logR);
  const encode = (v: number): number =>
    v < exact ? v : Math.min(n - 1, exact + Math.round(Math.log(v / exact) / logR));
  return { encode, lut };
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Float32 的位元樣式（HashTable 的 Uint32 欄位暫存浮點值用） */
export function floatBits(v: number): number {
  f32[0] = v;
  return u32[0]!;
}

/**
 * 對數機率／退回權重的均勻碼本：[最小值, 最大值]（含 0）等距切成 2^bits 格，最接近 0 的那格改成精確的 0。
 * 不用分位數切：分位數把格子花在筆數多的中段，高機率的尾端（log p 接近 0）一格很寬，
 * 實測 8 位元時口語句準掉約 11 點；均勻切每格誤差上限是範圍 / 2^(bits+1)。
 * encode 吃 Float32 位元樣式（見 floatBits），回傳最近代表值的碼。
 */
export function logCodebook(bits: Uint32Array, nbits: 8 | 16): Codebook {
  const vals = new Float32Array(bits.buffer, bits.byteOffset, bits.length);
  let min = Infinity;
  let max = -Infinity;
  let hasZero = false;
  for (const v of vals) {
    if (v < min) min = v;
    if (v > max) max = v;
    if (v === 0) hasZero = true;
  }
  if (!vals.length) min = max = 0;
  const n = 1 << nbits;
  const step = (max - min) / (n - 1) || 1;
  const centers = Array.from({ length: n }, (_, c) => min + c * step);
  // 0 在查表時代表「沒存」：只有真的含 0 的欄（退回權重沒設）才放精確的 0。
  // 機率欄全是負的，接近 0 的（P≈1）必須留在最大的負值，否則會被當成沒存而退回
  if (hasZero) centers[Math.round(-min / step)] = 0;
  const lut = Float64Array.from(new Set(centers)).sort();
  const zero = lut.indexOf(0);
  const encode = (b: number): number => {
    u32[0] = b;
    const v = f32[0]!;
    if (v === 0) return zero;
    let lo = 0;
    let hi = lut.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v > (lut[mid]! + lut[mid + 1]!) / 2) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return { encode, lut };
}

/** 計數量化位元數；4／6 仍存在 Uint8（只省碼本精度，不省空間，用來量準確率） */
export type QuantBits = 4 | 6 | 8 | 16;
/** 凍結後的指紋位元數：k1 32 bit，加 k2 的 0／8／16 bit */
export type Fingerprint = 32 | 40 | 48;

export class HashTable implements CountTable {
  private k1: Uint32Array;
  /** 凍結後只留 h2 低 16／8 位元（48／40-bit 指紋）；長度 0 = 只用 k1（32-bit 指紋） */
  private k2: Uint32Array | Uint16Array | Uint8Array;
  /** h2 與 k2 比較前的遮罩（依 k2 寬度） */
  private k2mask = 0xffffffff;
  private cols: Array<Uint32Array | Uint16Array | Uint8Array>;
  private cap: number;
  /** 凍結（量化）後的解碼表；null = 原始 Uint32 計數 */
  private lut: Float64Array | null = null;
  size = 0;

  constructor(
    readonly ncols: number,
    capacity = 1 << 16,
  ) {
    this.k1 = new Uint32Array(capacity);
    this.k2 = new Uint32Array(capacity);
    this.cols = Array.from({ length: ncols }, () => new Uint32Array(capacity));
    this.cap = capacity;
  }

  /** 找到 h1/h2 的槽位；不存在時回傳 ~空槽位（負數）。 */
  private slot(): number {
    const b2 = (h2 & this.k2mask) >>> 0;
    let i = h1 % this.cap;
    for (;;) {
      const a = this.k1[i]!;
      if (a === h1 && (this.k2.length === 0 || this.k2[i] === b2)) return i;
      if (a === 0) return ~i;
      if (++i === this.cap) i = 0;
    }
  }

  get(key: string, col = 0): number {
    hashKey(key);
    return this.found(col);
  }

  /** 等同 get(`${x} ${y}`)，不組字串 */
  get2(x: string, y: string, col = 0): number {
    hash2(x, y);
    return this.found(col);
  }

  /** 等同 get(`${x} ${y}\t${z}`)，不組字串 */
  get3(x: string, y: string, z: string, col = 0): number {
    hash3(x, y, z);
    return this.found(col);
  }

  private found(col: number): number {
    const i = this.slot();
    if (i < 0) return 0;
    const v = this.cols[col]![i]!;
    return this.lut ? this.lut[v]! : v;
  }

  has(key: string): boolean {
    hashKey(key);
    return this.slot() >= 0;
  }

  /** cols[col][key] += v；key 不存在則先插入（其他欄為 0）。 */
  add(key: string, col: number, v: number): void {
    if (this.lut) throw new Error('HashTable 已凍結');
    if (this.size + 1 > this.cap * 0.6) this.rehash(this.cap * 2);
    hashKey(key);
    let i = this.slot();
    if (i < 0) {
      i = ~i;
      this.k1[i] = h1;
      this.k2[i] = h2;
      this.size++;
    }
    this.cols[col]![i]! += v;
  }

  /**
   * 量化並壓緊：計數改存 bits 位元碼、指紋縮成 48 bit、容量收到 size/load。
   * 之後唯讀。48-bit 指紋在 4000 萬筆內約有個位數碰撞，碰撞者保留先到的一筆。
   */
  freeze(bits: QuantBits, load = 0.75, fp: Fingerprint = 48): void {
    const q = codebook(bits);
    this.rehash(Math.ceil(this.size / load), bits, q.encode, fp);
    this.lut = q.lut;
  }

  private rehash(
    cap: number,
    bits?: QuantBits,
    encode?: (v: number) => number,
    fp: Fingerprint = 48,
  ): void {
    const { k1, k2, cols } = this;
    const Col = bits === 16 ? Uint16Array : bits ? Uint8Array : Uint32Array;
    this.k1 = new Uint32Array(cap);
    this.k2 = !bits
      ? new Uint32Array(cap)
      : fp === 40
        ? new Uint8Array(cap)
        : new Uint16Array(fp === 48 ? cap : 0);
    this.k2mask = 2 ** (8 * this.k2.BYTES_PER_ELEMENT) - 1;
    this.cols = Array.from({ length: this.ncols }, () => new Col(cap));
    this.cap = cap;
    for (let j = 0; j < k1.length; j++) {
      if (k1[j] === 0) continue;
      h1 = k1[j]!;
      h2 = k2[j]!;
      let i = this.slot();
      if (i >= 0) {
        this.size--;
        continue;
      }
      i = ~i;
      this.k1[i] = h1;
      if (this.k2.length) this.k2[i] = h2;
      for (let c = 0; c < this.ncols; c++)
        this.cols[c]![i] = encode ? encode(cols[c]![j]!) : cols[c]![j]!;
    }
  }

  /** 序列化用（lm.bin）：內部陣列與量化位元數（0 = 未量化）。 */
  dump(): { bits: 0 | QuantBits; size: number; arrays: ArrayBufferView[] } {
    const bits = this.lut ? (Math.log2(this.lut.length) as QuantBits) : 0;
    return { bits, size: this.size, arrays: [this.k1, this.k2, ...this.cols] };
  }

  /** dump() 的反向：arrays 直接當成表的儲存（不複製），型別須與 bits 對應。 */
  static restore(
    ncols: number,
    bits: 0 | QuantBits,
    size: number,
    arrays: ArrayBufferView[],
  ): HashTable {
    const t = new HashTable(ncols, 0);
    t.k1 = arrays[0] as Uint32Array;
    t.k2 = arrays[1] as Uint32Array | Uint16Array | Uint8Array;
    t.k2mask = 2 ** (8 * t.k2.BYTES_PER_ELEMENT) - 1;
    t.cols = arrays.slice(2) as Array<Uint32Array | Uint16Array | Uint8Array>;
    t.cap = t.k1.length;
    t.size = size;
    if (bits) t.lut = codebook(bits).lut;
    return t;
  }

  /** 佔用位元組數（鍵＋值陣列） */
  get bytes(): number {
    return [this.k1, this.k2, ...this.cols].reduce((s, a) => s + a.byteLength, 0);
  }

  /** 以未凍結表（完整 64-bit 雜湊）建最小完美雜湊表，值量化成 bits 位元。 */
  toPerfect(bits: 8 | 16): PerfectTable {
    if (this.lut) throw new Error('toPerfect 需要未凍結的表');
    return PerfectTable.build(this.k1, this.k2 as Uint32Array, this.cols as Uint32Array[], bits);
  }

  /** 欄位存 Float32 位元樣式（floatBits）時：每欄各建均勻碼本（logCodebook），再建 PerfectTable。 */
  toPerfectFloat(bits: 8 | 16, fpBits: 16 | 32 = 16): PerfectTable {
    if (this.lut) throw new Error('toPerfectFloat 需要未凍結的表');
    const cols = this.cols as Uint32Array[];
    const used = cols.map((c) => c.filter((_, i) => this.k1[i] !== 0));
    const books = used.map((c) => logCodebook(c, bits));
    return PerfectTable.build(this.k1, this.k2 as Uint32Array, cols, bits, books, fpBits);
  }
}

/** 只讀查詢介面：HashTable（載入中／一般）與 PerfectTable（打包後）共用。 */
export interface CountTable {
  readonly ncols: number;
  readonly size: number;
  readonly bytes: number;
  get(key: string, col?: number): number;
  get2(x: string, y: string, col?: number): number;
  get3(x: string, y: string, z: string, col?: number): number;
}

/** 平均每桶鍵數；位移值 16 bit，所以每鍵約 4 bit */
const BUCKET_LOAD = 4;
/** 槽數 = 鍵數 / SLOT_LOAD：留 3% 空槽，最後幾個桶才找得到位置 */
const SLOT_LOAD = 0.97;

const pick = (h: number, n: number): number => Math.floor((h * n) / 4294967296);

/**
 * 最小完美雜湊表（hash-and-displace，PTHash 類）：每個桶存一個 16-bit 位移值，
 * 鍵 → 桶 → 位移值 → 唯一的槽；不存鍵，只存 16-bit 指紋（h2 高 16 位，0 = 空槽）。
 * 查詢固定 2–3 次陣列讀取、沒有探測。代價：查不存在的鍵約 1/65536 誤中（HashTable fp=40 約 1/2^40）。
 * 只能整批建（打包時），之後唯讀。
 */
export class PerfectTable implements CountTable {
  private constructor(
    readonly ncols: number,
    readonly size: number,
    readonly bits: 8 | 16,
    readonly seed: number,
    private readonly pilots: Uint16Array,
    /** 指紋：Uint16（h2 高 16 位）或 Uint32（整個 h2）；0 = 空槽 */
    private readonly fp: Uint16Array | Uint32Array,
    private readonly cols: Array<Uint8Array | Uint16Array>,
    /** 每欄的碼本解碼表（計數表各欄相同；機率表各欄不同） */
    readonly luts: Float64Array[],
  ) {}

  private static bucket(seed: number, nb: number): number {
    return pick(fmix((h2 ^ seed) >>> 0), nb);
  }

  private static slot(pilot: number, seed: number, ns: number): number {
    return pick(fmix((h1 ^ Math.imul(pilot + 1, 0x9e3779b1) ^ seed) >>> 0), ns);
  }

  private static tag(wide: boolean): number {
    return (wide ? h2 : h2 >>> 16) || 1;
  }

  get(key: string, col = 0): number {
    hashKey(key);
    return this.found(col);
  }

  get2(x: string, y: string, col = 0): number {
    hash2(x, y);
    return this.found(col);
  }

  get3(x: string, y: string, z: string, col = 0): number {
    hash3(x, y, z);
    return this.found(col);
  }

  private found(col: number): number {
    const b = PerfectTable.bucket(this.seed, this.pilots.length);
    const s = PerfectTable.slot(this.pilots[b]!, this.seed, this.fp.length);
    return this.fp[s] === PerfectTable.tag(this.fp.BYTES_PER_ELEMENT === 4)
      ? this.luts[col]![this.cols[col]![s]!]!
      : 0;
  }

  get bytes(): number {
    return [this.pilots, this.fp, ...this.cols].reduce((s, a) => s + a.byteLength, 0);
  }

  static build(
    k1: Uint32Array,
    k2: Uint32Array,
    cols: Uint32Array[],
    bits: 8 | 16,
    books: Codebook[] = cols.map(() => codebook(bits)),
    fpBits: 16 | 32 = 16,
  ): PerfectTable {
    const items: number[] = [];
    for (let j = 0; j < k1.length; j++) if (k1[j] !== 0) items.push(j);
    const n = items.length;
    const nb = Math.max(1, Math.ceil(n / BUCKET_LOAD));
    const ns = Math.max(1, Math.ceil(n / SLOT_LOAD));
    for (let seed = 0x5bd1e995; ; seed = fmix(seed + 1)) {
      // 依桶分組（CSR），大桶先放
      const bucketOf = new Uint32Array(n);
      const count = new Uint32Array(nb + 1);
      for (let i = 0; i < n; i++) {
        h2 = k2[items[i]!]!;
        bucketOf[i] = PerfectTable.bucket(seed, nb);
        count[bucketOf[i]! + 1]!++;
      }
      for (let b = 0; b < nb; b++) count[b + 1]! += count[b]!;
      const member = new Uint32Array(n);
      const fill = count.slice(0, nb);
      for (let i = 0; i < n; i++) member[fill[bucketOf[i]!]!++] = i;
      const order = Array.from({ length: nb }, (_, b) => b).sort(
        (x, y) => count[y + 1]! - count[y]! - (count[x + 1]! - count[x]!),
      );
      const taken = new Uint8Array(ns);
      const pilots = new Uint16Array(nb);
      const slotOf = new Uint32Array(n);
      const tmp: number[] = [];
      let ok = true;
      for (const b of order) {
        const lo = count[b]!;
        const hi = count[b + 1]!;
        if (lo === hi) continue;
        let p = 0;
        for (; p < 65536; p++) {
          tmp.length = 0;
          for (let m = lo; m < hi; m++) {
            h1 = k1[items[member[m]!]!]!;
            const s = PerfectTable.slot(p, seed, ns);
            if (taken[s] || tmp.includes(s)) break;
            tmp.push(s);
          }
          if (tmp.length === hi - lo) break;
        }
        if (p === 65536) {
          ok = false; // 同桶兩鍵 h1 相同等極少見情況：換 seed 重來
          break;
        }
        pilots[b] = p;
        for (let m = lo; m < hi; m++) {
          taken[tmp[m - lo]!] = 1;
          slotOf[member[m]!] = tmp[m - lo]!;
        }
      }
      if (!ok) continue;
      const fp = fpBits === 32 ? new Uint32Array(ns) : new Uint16Array(ns);
      const Col = bits === 16 ? Uint16Array : Uint8Array;
      const out = cols.map(() => new Col(ns));
      for (let i = 0; i < n; i++) {
        const j = items[i]!;
        const s = slotOf[i]!;
        h2 = k2[j]!;
        fp[s] = PerfectTable.tag(fpBits === 32);
        for (let c = 0; c < cols.length; c++) out[c]![s] = books[c]!.encode(cols[c]![j]!);
      }
      return new PerfectTable(
        cols.length,
        n,
        bits,
        seed,
        pilots,
        fp,
        out,
        books.map((q) => q.lut),
      );
    }
  }

  /** 序列化用（lm.bin）。 */
  dump(): { bits: 8 | 16; seed: number; size: number; arrays: ArrayBufferView[] } {
    return {
      bits: this.bits,
      seed: this.seed,
      size: this.size,
      arrays: [this.pilots, this.fp, ...this.cols],
    };
  }

  /** dump() 的反向：arrays 直接當成表的儲存（不複製）。 */
  static restore(
    ncols: number,
    bits: 8 | 16,
    seed: number,
    size: number,
    arrays: ArrayBufferView[],
    luts?: Float64Array[],
  ): PerfectTable {
    const [pilots, fp, ...cols] = arrays;
    return new PerfectTable(
      ncols,
      size,
      bits,
      seed,
      pilots as Uint16Array,
      fp as Uint16Array | Uint32Array,
      cols as Array<Uint8Array | Uint16Array>,
      luts ?? cols.map(() => codebook(bits).lut),
    );
  }
}
