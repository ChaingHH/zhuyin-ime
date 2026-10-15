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

/** 算出 key 的兩組雜湊到模組變數 h1/h2（避免每次查詢配置 tuple）。 */
function hashKey(key: string): void {
  let a = 0x811c9dc5;
  let b = 0;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = (Math.imul(b, 31) + c) | 0;
  }
  h1 = fmix(a);
  h2 = fmix(b ^ key.length);
  // k1=0 保留給空槽
  if (h1 === 0) h1 = 1;
}

/**
 * 計數的對數量化碼本：小於 exact 的值原樣存，以上按等比級距編碼到 2^bits 個碼，
 * 上限 2^32。16 位元：exact=4096，相對誤差約 1e-4；8 位元：exact=16，約 4%。
 */
function codebook(bits: 8 | 16): { encode: (v: number) => number; lut: Float64Array } {
  const n = 1 << bits;
  const exact = bits === 16 ? 4096 : 16;
  const logR = Math.log(2 ** 32 / exact) / (n - 1 - exact);
  const lut = new Float64Array(n);
  for (let c = 0; c < n; c++) lut[c] = c < exact ? c : exact * Math.exp((c - exact) * logR);
  const encode = (v: number): number =>
    v < exact ? v : Math.min(n - 1, exact + Math.round(Math.log(v / exact) / logR));
  return { encode, lut };
}

export class HashTable {
  private k1: Uint32Array;
  /** 凍結後只留 h2 低 16 位元（48-bit 指紋） */
  private k2: Uint32Array | Uint16Array;
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
    const b2 = this.lut ? h2 & 0xffff : h2;
    let i = h1 % this.cap;
    for (;;) {
      const a = this.k1[i]!;
      if (a === h1 && this.k2[i] === b2) return i;
      if (a === 0) return ~i;
      if (++i === this.cap) i = 0;
    }
  }

  get(key: string, col = 0): number {
    hashKey(key);
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
  freeze(bits: 8 | 16, load = 0.75): void {
    const q = codebook(bits);
    this.rehash(Math.ceil(this.size / load), bits, q.encode);
    this.lut = q.lut;
  }

  private rehash(cap: number, bits?: 8 | 16, encode?: (v: number) => number): void {
    const { k1, k2, cols } = this;
    const Col = bits === 16 ? Uint16Array : bits === 8 ? Uint8Array : Uint32Array;
    this.k1 = new Uint32Array(cap);
    this.k2 = bits ? new Uint16Array(cap) : new Uint32Array(cap);
    this.cols = Array.from({ length: this.ncols }, () => new Col(cap));
    this.cap = cap;
    for (let j = 0; j < k1.length; j++) {
      if (k1[j] === 0) continue;
      h1 = k1[j]!;
      h2 = bits ? k2[j]! & 0xffff : k2[j]!;
      let i = this.slot();
      if (i >= 0) {
        this.size--;
        continue;
      }
      i = ~i;
      this.k1[i] = h1;
      this.k2[i] = h2;
      for (let c = 0; c < this.ncols; c++)
        this.cols[c]![i] = encode ? encode(cols[c]![j]!) : cols[c]![j]!;
    }
  }

  /** 序列化用（lm.bin）：內部陣列與量化位元數（0 = 未量化）。 */
  dump(): { bits: 0 | 8 | 16; size: number; arrays: ArrayBufferView[] } {
    const bits = this.lut ? (this.lut.length === 256 ? 8 : 16) : 0;
    return { bits, size: this.size, arrays: [this.k1, this.k2, ...this.cols] };
  }

  /** dump() 的反向：arrays 直接當成表的儲存（不複製），型別須與 bits 對應。 */
  static restore(
    ncols: number,
    bits: 0 | 8 | 16,
    size: number,
    arrays: ArrayBufferView[],
  ): HashTable {
    const t = new HashTable(ncols, 0);
    t.k1 = arrays[0] as Uint32Array;
    t.k2 = arrays[1] as Uint32Array | Uint16Array;
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
}
