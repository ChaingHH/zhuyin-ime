/**
 * 讀音 → 詞 的精簡索引（取代 Map<讀音字串, 詞[]>，docs/MEMORY.md §5 #6）。
 *
 * - 讀音存成音節編號（Uint16）串，不存「ㄧ ㄉㄧㄥ」這種鍵字串；查詢時從音節陣列直接算雜湊，不組字串。
 * - 每個讀音的詞清單是一段 Uint32 詞編號（高頻在前），詞字串每個只存一份。
 * - 開放定址表（Int32）放鍵編號；比對時逐音節比，不會誤中。
 * - 可存成位元組（toBytes／fromBytes），載入時不必解析 lexicon.jsonl。core 不做 IO，檔案由呼叫端讀寫。
 * 執行中新增的詞（使用者造詞、挖詞）放在小的 Map 疊加層，接在原清單後面。
 */
import type { LexiconEntry } from './index.js';

const MAGIC = 'ZYLEX002';

export class LexiconIndex {
  private readonly sylId = new Map<string, number>();
  private slots: Int32Array;
  /** 疊加層：已有讀音的新詞（鍵編號 → 詞）、全新讀音（雜湊 → [音節編號, 詞]） */
  private readonly extraByKey = new Map<number, string[]>();
  private readonly extraNew = new Map<number, Array<{ ids: number[]; words: string[] }>>();
  private extraKeys = 0;
  private ids: number[] = [];

  private constructor(
    private readonly syllables: string[],
    private readonly words: string[],
    /** 第 k 個讀音的音節編號在 rd[rdOff[k] .. rdOff[k+1]) */
    private readonly rd: Uint16Array,
    private readonly rdOff: Uint32Array,
    /** 第 k 個讀音的詞編號在 wl[wOff[k] .. wOff[k+1])，高頻在前 */
    private readonly wl: Uint32Array,
    private readonly wOff: Uint32Array,
    /** 有多個讀音的單字（破音字）→ 主讀音（詞典的第一個讀音，依 libchewing 讀音頻率排） */
    readonly polySingle: ReadonlyMap<string, string>,
  ) {
    syllables.forEach((s, i) => this.sylId.set(s, i));
    const n = rdOff.length - 1;
    let cap = 16;
    while (cap < n / 0.6) cap *= 2;
    this.slots = new Int32Array(cap).fill(-1);
    for (let k = 0; k < n; k++) {
      let i = this.hashRange(k) & (cap - 1);
      while (this.slots[i] !== -1) i = (i + 1) & (cap - 1);
      this.slots[i] = k;
    }
  }

  /** 讀音數（含執行中新增的） */
  get size(): number {
    return this.rdOff.length - 1 + this.extraKeys;
  }

  /** 最長讀音的音節數 */
  get maxSpan(): number {
    let m = 1;
    for (let k = 0; k + 1 < this.rdOff.length; k++)
      m = Math.max(m, this.rdOff[k + 1]! - this.rdOff[k]!);
    for (const list of this.extraNew.values()) for (const x of list) m = Math.max(m, x.ids.length);
    return m;
  }

  /**
   * 詞條建索引。同讀音的詞依 freq 由高到低（同頻保持輸入順序）；超過 maxLen 音節的讀音不收。
   */
  static build(entries: readonly LexiconEntry[], maxLen: number): LexiconIndex {
    const syllables: string[] = [];
    const sylId = new Map<string, number>();
    const words: string[] = [];
    const wordId = new Map<string, number>();
    const poly = new Map<string, string>();
    const pairs: Array<{ key: string; w: number; f: number }> = [];
    for (const e of entries) {
      if ([...e.word].length === 1 && e.readings.length > 1 && !poly.has(e.word))
        poly.set(e.word, e.readings[0]!.join(' '));
      let w = wordId.get(e.word);
      if (w === undefined) {
        w = words.length;
        words.push(e.word);
        wordId.set(e.word, w);
      }
      for (const r of e.readings) {
        if (r.length > maxLen) continue;
        for (const s of r)
          if (!sylId.has(s)) {
            sylId.set(s, syllables.length);
            syllables.push(s);
          }
        pairs.push({ key: r.join(' '), w, f: e.freq ?? 0 });
      }
    }
    // 詞依 UTF-8 位元組排序（同 Rust 的 str 比較）：Rust find_word 載入後第一次要排序，
    // 已排好的輸入只要 O(n)（未排序的 26 萬詞約 30ms，佔引擎載入的六成）
    const enc = new TextEncoder();
    const bytesOf = words.map((w) => enc.encode(w));
    const order = words.map((_, i) => i).sort((a, b) => Buffer.compare(bytesOf[a]!, bytesOf[b]!));
    const rank = new Uint32Array(words.length);
    order.forEach((w, i) => (rank[w] = i));
    const sorted = order.map((i) => words[i]!);
    pairs.sort((x, y) => y.f - x.f);
    const lists = new Map<string, number[]>();
    for (const p of pairs) {
      const l = lists.get(p.key);
      if (l) l.push(rank[p.w]!);
      else lists.set(p.key, [rank[p.w]!]);
    }
    const rd: number[] = [];
    const rdOff = new Uint32Array(lists.size + 1);
    const wl: number[] = [];
    const wOff = new Uint32Array(lists.size + 1);
    let k = 0;
    for (const [key, l] of lists) {
      for (const s of key.split(' ')) rd.push(sylId.get(s)!);
      for (const w of l) wl.push(w);
      k++;
      rdOff[k] = rd.length;
      wOff[k] = wl.length;
    }
    return new LexiconIndex(
      syllables,
      sorted,
      Uint16Array.from(rd),
      rdOff,
      Uint32Array.from(wl),
      wOff,
      poly,
    );
  }

  private static hashIds(ids: ArrayLike<number>, lo: number, hi: number): number {
    let h = 0x811c9dc5;
    for (let i = lo; i < hi; i++) h = Math.imul(h ^ ids[i]!, 0x01000193);
    return (h ^ (h >>> 15)) >>> 0;
  }

  private hashRange(k: number): number {
    return LexiconIndex.hashIds(this.rd, this.rdOff[k]!, this.rdOff[k + 1]!);
  }

  /** 讀音轉成音節編號到 this.ids；有沒見過的音節回 false */
  private toIds(reading: readonly string[]): boolean {
    const ids = this.ids;
    ids.length = reading.length;
    for (let i = 0; i < reading.length; i++) {
      const id = this.sylId.get(reading[i]!);
      if (id === undefined) return false;
      ids[i] = id;
    }
    return true;
  }

  /** 基本索引裡的鍵編號；沒有回 −1（需先 toIds） */
  private findKey(h: number): number {
    const ids = this.ids;
    const mask = this.slots.length - 1;
    for (let i = h & mask; ; i = (i + 1) & mask) {
      const k = this.slots[i]!;
      if (k === -1) return -1;
      const lo = this.rdOff[k]!;
      if (this.rdOff[k + 1]! - lo !== ids.length) continue;
      let j = 0;
      while (j < ids.length && this.rd[lo + j] === ids[j]) j++;
      if (j === ids.length) return k;
    }
  }

  private findNew(h: number): { ids: number[]; words: string[] } | undefined {
    const ids = this.ids;
    return this.extraNew
      .get(h)
      ?.find((x) => x.ids.length === ids.length && x.ids.every((v, i) => v === ids[i]));
  }

  /** 依序（高頻在前）對讀音的前 cap 個詞呼叫 fn。 */
  each(reading: readonly string[], cap: number, fn: (word: string) => void): void {
    if (!this.toIds(reading)) return;
    const h = LexiconIndex.hashIds(this.ids, 0, this.ids.length);
    const k = this.findKey(h);
    let n = 0;
    if (k >= 0) {
      const end = Math.min(this.wOff[k + 1]!, this.wOff[k]! + cap);
      for (let i = this.wOff[k]!; i < end; i++, n++) fn(this.words[this.wl[i]!]!);
      const extra = this.extraByKey.get(k);
      if (extra) for (let i = 0; i < extra.length && n < cap; i++, n++) fn(extra[i]!);
    } else {
      const x = this.findNew(h);
      if (x) for (let i = 0; i < x.words.length && n < cap; i++, n++) fn(x.words[i]!);
    }
  }

  has(reading: readonly string[], word: string): boolean {
    let found = false;
    this.each(reading, Infinity, (w) => {
      if (w === word) found = true;
    });
    return found;
  }

  /** 執行中新增一個詞（接在該讀音清單最後）。已存在就不動。 */
  add(reading: readonly string[], word: string): void {
    if (this.has(reading, word)) return;
    for (const s of reading)
      if (!this.sylId.has(s)) {
        this.sylId.set(s, this.syllables.length);
        this.syllables.push(s);
      }
    this.toIds(reading);
    const h = LexiconIndex.hashIds(this.ids, 0, this.ids.length);
    const k = this.findKey(h);
    if (k >= 0) {
      const l = this.extraByKey.get(k);
      if (l) l.push(word);
      else this.extraByKey.set(k, [word]);
      return;
    }
    const x = this.findNew(h);
    if (x) {
      x.words.push(word);
      return;
    }
    const list = this.extraNew.get(h) ?? [];
    list.push({ ids: this.ids.slice(), words: [word] });
    this.extraNew.set(h, list);
    this.extraKeys++;
  }

  /**
   * 存成位元組：magic、u32 標頭長度、JSON 標頭（各段位置），之後是 4 位元組對齊的各段。
   * 只存基本索引，不含執行中新增的詞。
   */
  toBytes(): Uint8Array {
    const enc = new TextEncoder();
    const parts: Record<string, Uint8Array> = {
      syllables: enc.encode(this.syllables.join('\n')),
      words: enc.encode(this.words.join('\n')),
      poly: enc.encode([...this.polySingle].map(([w, r]) => `${w}\t${r}`).join('\n')),
      rd: bytes(this.rd),
      rdOff: bytes(this.rdOff),
      wl: bytes(this.wl),
      wOff: bytes(this.wOff),
    };
    const layout: Record<string, [number, number]> = {};
    let off = 0;
    for (const [name, b] of Object.entries(parts)) {
      layout[name] = [off, b.byteLength];
      off += Math.ceil(b.byteLength / 4) * 4;
    }
    const header = enc.encode(JSON.stringify(layout));
    const base = Math.ceil((MAGIC.length + 4 + header.length) / 4) * 4;
    const out = new Uint8Array(base + off);
    out.set(enc.encode(MAGIC), 0);
    new DataView(out.buffer).setUint32(MAGIC.length, header.length, true);
    out.set(header, MAGIC.length + 4);
    for (const [name, b] of Object.entries(parts)) out.set(b, base + layout[name]![0]);
    return out;
  }

  /** toBytes 的反向。數字陣列複製出來（不綁住整個檔案 buffer）。 */
  static fromBytes(buf: Uint8Array): LexiconIndex {
    const dec = new TextDecoder();
    if (dec.decode(buf.subarray(0, MAGIC.length)) !== MAGIC) throw new Error('不是詞典索引格式');
    const hlen = new DataView(buf.buffer, buf.byteOffset).getUint32(MAGIC.length, true);
    const h0 = MAGIC.length + 4;
    const layout = JSON.parse(dec.decode(buf.subarray(h0, h0 + hlen))) as Record<
      string,
      [number, number]
    >;
    const base = Math.ceil((h0 + hlen) / 4) * 4;
    const seg = (name: string): Uint8Array => {
      const [o, n] = layout[name]!;
      if (base + o + n > buf.length) throw new Error('詞典索引檔被截斷');
      // 要複製：Node 的 Buffer.slice 只是 view，.buffer 會是整個檔案
      return new Uint8Array(buf.subarray(base + o, base + o + n));
    };
    const text = (name: string): string[] => {
      const s = dec.decode(seg(name));
      return s ? s.split('\n') : [];
    };
    const u32 = (name: string) => new Uint32Array(seg(name).buffer);
    return new LexiconIndex(
      text('syllables'),
      text('words'),
      new Uint16Array(seg('rd').buffer),
      u32('rdOff'),
      u32('wl'),
      u32('wOff'),
      new Map(text('poly').map((l) => l.split('\t') as [string, string])),
    );
  }
}

function bytes(a: ArrayBufferView): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}
