/**
 * X2 使用者適應層。
 *
 * 契約：`使用者行為 → 分數修飾函數 U(w)`。
 *
 * 關鍵設計決策（來自架構文件 §5）：
 * - **分數修飾，不是詞條插入**。McBopomofo 把使用者資料以 0 分（最高分）
 *   硬插的教訓：絕對覆寫會把正確候選擠掉，輸入法反而更難用。
 *   本層只做 log-space 相對加成，且有上限。
 * - 必須可整體關閉（kill-switch），關閉時 L5 行為與無此層完全一致
 *   （支援「固定候選字視窗順序」這類肌肉記憶需求）。
 * - 有上限：一直打字不會讓學習檔無限長大（X2_LIMITS、compact；數字見 docs/MEMORY.md
 *   「X2 學習資料的成長」）。native/src/x2.rs 是同一份邏輯，兩邊輸出逐位元組相同。
 */
import type { LexiconEntry } from './index.js';
import { isTraditionalWord } from './nontrad.js';

export interface UserAdapterOptions {
  /** 總開關。關閉時 modifierFor 恆回 0。 */
  enabled?: boolean;
  /** 每次選字帶來的加成係數（× ln(1+count)） */
  boostPerCount?: number;
  /** 單詞加成上限（log-space；2.2 ≈ e^2.2 ≈ 9 倍相對權重） */
  maxSeqBoost?: number;
  /** 全域（跨上下文）選字統計的權重折減 */
  globalFactor?: number;
  /** 手動使用者造詞的加成（仍非絕對覆寫）：2 音節的值 */
  manualPhraseBoost?: number;
  /** 手動造詞每多一個音節再加多少（算到 6 音節）。讀音越長越不會撞到別的詞，LM 差距卻越大 */
  manualPhraseBoostPerSyllable?: number;
}

interface SelectionRecord {
  count: number;
  lastAt: number;
}

/** 使用者詞條：手動造詞（manual）或挖詞（freq）；lastAt＝最後一次造詞／挖到的時間 */
export type Phrase = Omit<LexiconEntry, 'freq'> & {
  manual?: boolean;
  freq?: number;
  lastAt?: number;
};

export interface UserAdapterData {
  bySeq: Record<string, Record<string, SelectionRecord>>;
  global: Record<string, SelectionRecord>;
  phrases: Phrase[];
}

/**
 * 學習資料的上限。衰減後的次數 = 次數 × 0.5^(天數/14)；整理時先刪衰減到 dropBelow 以下的，
 * 再從最弱的刪到上限。手動造詞不衰減，只在超過 maxManual 時刪最舊的。
 */
export const X2_LIMITS = {
  /** 讀音×詞 的選字記錄 */
  maxSeq: 10_000,
  /** 全域（跨讀音）選字記錄 */
  maxGlobal: 10_000,
  /** 挖到的詞 */
  maxMined: 5_000,
  /** 手動造詞（選字視窗選過的詞）：硬上限 */
  maxManual: 20_000,
  /** 次數 1 約 75 天沒再出現就刪（此時加成已不到 0.01） */
  dropBelow: 0.025,
  /** 每新增這麼多項目整理一次（載入時也整理） */
  compactEvery: 2_000,
};

const DEFAULTS = {
  enabled: true,
  boostPerCount: 0.55,
  maxSeqBoost: 2.2,
  globalFactor: 0.35,
  /** 手動造詞＝使用者明確意圖，加成必須壓過常規 LM 差距（仍有界、非絕對覆寫） */
  manualPhraseBoost: 8.0,
  /**
   * 詞典沒有的音譯名（薩樂瑪梵斯）逐字選過一次後，LM 首選與它差 0–19（5 字）、0–29（6 字），
   * 8 補不回來（debug-user-name.ts，40 個隨機名字）；每音節 +10 → 5 字 38、6 字 48 都壓得過
   */
  manualPhraseBoostPerSyllable: 10.0,
};

export class UserAdapter {
  private readonly opts: Required<UserAdapterOptions>;
  private readonly bySeq = new Map<string, Map<string, SelectionRecord>>();
  private readonly global = new Map<string, SelectionRecord>();
  /** 手動造詞＋挖詞結果（帶讀音，交給 Decoder.addEntry 入格） */
  readonly phrases = new Map<string, Phrase>();
  /** 已注入 decoder 的詞（避免重複 addEntry） */
  private injected = new Set<string>();
  /** 最近一次看到的時間（recordSelection／載入）；setUserPhrase、mineWord 沒給時間時用它 */
  private now = Date.now();
  /** 上次整理後新增的項目數 */
  private added = 0;

  constructor(opts: UserAdapterOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  setEnabled(v: boolean): void {
    this.opts.enabled = v;
  }

  /** 每次選字／送出 top-1 詞時記錄。seq 為該詞對應的音節序列。 */
  recordSelection(seq: readonly string[], word: string, at: number = Date.now()): void {
    if (!this.opts.enabled) return;
    this.now = at;
    const key = seq.join(' ');
    let m = this.bySeq.get(key);
    if (!m) {
      m = new Map();
      this.bySeq.set(key, m);
    }
    if (!m.has(word)) this.added++;
    if (!this.global.has(word)) this.added++;
    bump(m, word, at);
    bump(this.global, word, at);
    this.maybeCompact();
  }

  /**
   * U(w)：給定上下文音節與候選詞，回傳 log-space 加成。
   * 有界：seqBoost 封頂於 maxSeqBoost；全域統計另乘 globalFactor 且封頂一半。
   */
  modifierFor(seq: readonly string[], word: string, at: number = Date.now()): number {
    if (!this.opts.enabled) return 0;

    // 手動詞條：最強（但仍有界）加成，且僅在讀音相符時由呼叫端保證 seq 一致
    if (this.phrases.get(word)?.manual === true) {
      const extra = Math.max(0, Math.min(seq.length, 6) - 2);
      return this.opts.manualPhraseBoost + this.opts.manualPhraseBoostPerSyllable * extra;
    }

    let u = 0;
    const key = seq.join(' ');
    const rec = this.bySeq.get(key)?.get(word);
    if (rec && rec.count > 0) {
      const decay = recency(rec.lastAt, at);
      u +=
        Math.min(this.opts.maxSeqBoost, this.opts.boostPerCount * Math.log(1 + rec.count)) * decay;
    }
    const g = this.global.get(word);
    if (g && g.count > 0) {
      const decay = recency(g.lastAt, at);
      u +=
        Math.min(this.opts.maxSeqBoost / 2, this.opts.boostPerCount * Math.log(1 + g.count)) *
        this.opts.globalFactor *
        decay;
    }
    return u;
  }

  /**
   * 使用者明示造詞（微軟「啟用使用者造詞詞典」項）：
   * 讀音由引擎從送出時的音節補齊。加成最強（仍有界）。
   */
  setUserPhrase(word: string, readings: readonly string[], at: number = this.now): void {
    if (!this.phrases.has(word)) this.added++;
    this.phrases.set(word, {
      word,
      readings: [readings.slice()],
      provenance: ['user'],
      manual: true,
      lastAt: at,
    });
    this.maybeCompact();
  }

  /**
   * 從送出字串挖掘新詞（「讓 IME 學習造詞」項）：
   * 引擎把解碼路徑中連續的 UNK（□）span 交進來。
   * 首次出現即入格（覆蓋缺口是實測失敗案例的直接修法），
   * 但 freq 記錄出現次數供日後排序；重複出現不重複入格。
   */
  mineWord(word: string, reading: readonly string[], at: number = this.now): boolean {
    const existing = this.phrases.get(word);
    if (existing) {
      if (!existing.manual) {
        existing.freq = (existing.freq ?? 1) + 1;
        existing.lastAt = at;
      }
      return false;
    }
    if (word.length < 2) return false;
    this.phrases.set(word, {
      word,
      readings: [reading.slice()],
      provenance: ['mined'],
      freq: 1,
      lastAt: at,
    });
    this.added++;
    this.maybeCompact();
    return true;
  }

  private maybeCompact(): void {
    if (this.added >= X2_LIMITS.compactEvery) this.compact(this.now);
  }

  /**
   * 整理：刪掉衰減完的記錄與挖詞，超過上限的從最弱的刪。已注入解碼器的詞留在解碼器裡，
   * 下次載入才消失（ponytail: 解碼器沒有刪詞；要即時生效再加 LexiconIndex.remove）。
   */
  compact(at: number = this.now): void {
    this.added = 0;
    const L = X2_LIMITS;
    const w = (count: number, lastAt: number): number => count * recency(lastAt, at);
    const pairs: Array<{ k: string; word: string; w: number }> = [];
    for (const [k, m] of this.bySeq)
      for (const [word, r] of m) pairs.push({ k, word, w: w(r.count, r.lastAt) });
    for (const x of weakest(pairs, L.maxSeq, L.dropBelow)) {
      const m = this.bySeq.get(x.k)!;
      m.delete(x.word);
      if (m.size === 0) this.bySeq.delete(x.k);
    }
    const globals = [...this.global].map(([word, r]) => ({ word, w: w(r.count, r.lastAt) }));
    for (const x of weakest(globals, L.maxGlobal, L.dropBelow)) this.global.delete(x.word);
    // 舊檔的詞條沒有 lastAt：從現在開始算
    for (const p of this.phrases.values()) p.lastAt ??= at;
    const ps = [...this.phrases.values()];
    const mined = ps
      .filter((p) => !p.manual)
      .map((p) => ({ word: p.word, w: w(p.freq ?? 1, p.lastAt!) }));
    const manual = ps.filter((p) => p.manual).map((p) => ({ word: p.word, w: p.lastAt! }));
    for (const x of weakest(mined, L.maxMined, L.dropBelow)) this.phrases.delete(x.word);
    for (const x of weakest(manual, L.maxManual, -Infinity)) this.phrases.delete(x.word);
  }

  /** 注入尚未入格的詞條。 */
  drainPendingEntries(): LexiconEntry[] {
    const out: LexiconEntry[] = [];
    for (const e of this.phrases.values()) {
      // 舊 adapter.json 可能有非台灣繁體字的詞（詞典過濾前學到的），不入格；x2.rs 同步
      if (!this.injected.has(e.word) && isTraditionalWord(e.word)) {
        this.injected.add(e.word);
        out.push(e);
      }
    }
    return out;
  }

  toJSON(): UserAdapterData {
    const toObj = (m: Map<string, Map<string, SelectionRecord>>) =>
      Object.fromEntries([...m].map(([k, v]) => [k, Object.fromEntries(v)]));
    return {
      bySeq: toObj(this.bySeq),
      global: Object.fromEntries(this.global),
      phrases: [...this.phrases.values()],
    };
  }

  /** 讀回 toJSON 的資料並整理一次（at＝現在，決定衰減） */
  static fromJSON(
    data: UserAdapterData,
    opts?: UserAdapterOptions,
    at: number = Date.now(),
  ): UserAdapter {
    const a = new UserAdapter(opts);
    // 壞記錄（count／lastAt 不是有限數字）丟掉、壞詞條（word 不是字串）跳過，同 x2.rs
    const recs = (o: Record<string, SelectionRecord>) =>
      Object.entries(o ?? {}).filter(([, r]) => finite(r?.count) && finite(r?.lastAt));
    for (const [k, v] of Object.entries(data.bySeq ?? {})) {
      a.bySeq.set(k, new Map(recs(v)));
    }
    for (const [k, v] of recs(data.global)) a.global.set(k, v);
    let latest = -Infinity;
    for (const r of a.global.values()) latest = Math.max(latest, r.lastAt);
    for (const m of a.bySeq.values())
      for (const r of m.values()) latest = Math.max(latest, r.lastAt);
    for (const p of data.phrases ?? []) {
      if (typeof p?.word !== 'string') continue;
      if (!finite(p.freq)) delete p.freq;
      if (!finite(p.lastAt)) delete p.lastAt;
      else latest = Math.max(latest, p.lastAt);
      a.phrases.set(p.word, p);
    }
    a.now = at;
    // 時鐘跳到未來時，整理會把全部記錄當成過期刪光：跳過，等時鐘正常
    if (Number.isFinite(latest) && at - latest > CLOCK_JUMP_MS)
      console.warn(`x2：現在時間比學習檔最後一筆晚超過 365 天，跳過整理（時鐘錯了？）`);
    else a.compact(at);
    return a;
  }
}

/** 要刪的項目：衰減到 dropBelow 以下的全部，再從剩下最弱的刪到 cap 個（同分刪前面的）。 */
function weakest<T extends { w: number }>(items: T[], cap: number, dropBelow: number): T[] {
  const out = items.filter((x) => x.w < dropBelow);
  const keep = items.filter((x) => x.w >= dropBelow);
  if (keep.length > cap) out.push(...keep.sort((a, b) => a.w - b.w).slice(0, keep.length - cap));
  return out;
}

/** 現在時間比學習檔最後一筆晚超過這麼多，載入時不整理 */
const CLOCK_JUMP_MS = 365 * 86_400_000;

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** 選字次數 +1：舊次數先衰減到現在，一年前選過 100 次的詞再選一次不會回到滿額加成 */
function bump(m: Map<string, SelectionRecord>, word: string, at: number): void {
  const r = m.get(word);
  m.set(word, { count: r ? r.count * recency(r.lastAt, at) + 1 : 1, lastAt: at });
}

/** 半衰期 14 天的時間衰減（測試可傳固定 at 保持決定性）。 */
function recency(lastAt: number, now: number): number {
  const days = Math.max(0, (now - lastAt) / 86_400_000);
  return Math.pow(0.5, days / 14);
}
