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
  // (0,0) 保留為空槽
  if (h1 === 0 && h2 === 0) h2 = 1;
}

export class HashTable {
  private k1: Uint32Array;
  private k2: Uint32Array;
  private cols: Uint32Array[];
  private mask: number;
  size = 0;

  constructor(
    readonly ncols: number,
    capacity = 1 << 16,
  ) {
    this.k1 = new Uint32Array(capacity);
    this.k2 = new Uint32Array(capacity);
    this.cols = Array.from({ length: ncols }, () => new Uint32Array(capacity));
    this.mask = capacity - 1;
  }

  /** 找到 h1/h2 的槽位；不存在時回傳 ~空槽位（負數）。 */
  private slot(): number {
    let i = h1 & this.mask;
    for (;;) {
      const a = this.k1[i]!;
      const b = this.k2[i]!;
      if (a === h1 && b === h2) return i;
      if (a === 0 && b === 0) return ~i;
      i = (i + 1) & this.mask;
    }
  }

  get(key: string, col = 0): number {
    hashKey(key);
    const i = this.slot();
    return i >= 0 ? this.cols[col]![i]! : 0;
  }

  has(key: string): boolean {
    hashKey(key);
    return this.slot() >= 0;
  }

  /** cols[col][key] += v；key 不存在則先插入（其他欄為 0）。 */
  add(key: string, col: number, v: number): void {
    if (this.size + 1 > (this.mask + 1) * 0.6) this.grow();
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

  private grow(): void {
    const { k1, k2, cols } = this;
    const cap = (this.mask + 1) * 2;
    this.k1 = new Uint32Array(cap);
    this.k2 = new Uint32Array(cap);
    this.cols = Array.from({ length: this.ncols }, () => new Uint32Array(cap));
    this.mask = cap - 1;
    for (let j = 0; j < k1.length; j++) {
      if (k1[j] === 0 && k2[j] === 0) continue;
      h1 = k1[j]!;
      h2 = k2[j]!;
      const i = ~this.slot();
      this.k1[i] = h1;
      this.k2[i] = h2;
      for (let c = 0; c < this.ncols; c++) this.cols[c]![i] = cols[c]![j]!;
    }
  }
}
