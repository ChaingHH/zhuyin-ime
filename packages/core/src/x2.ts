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
 */
import type { LexiconEntry } from './index.js';

export interface UserAdapterOptions {
  /** 總開關。關閉時 modifierFor 恆回 0。 */
  enabled?: boolean;
  /** 每次選字帶來的加成係數（× ln(1+count)） */
  boostPerCount?: number;
  /** 單詞加成上限（log-space；2.2 ≈ e^2.2 ≈ 9 倍相對權重） */
  maxSeqBoost?: number;
  /** 全域（跨上下文）選字統計的權重折減 */
  globalFactor?: number;
  /** 手動使用者造詞的加成（仍非絕對覆寫） */
  manualPhraseBoost?: number;
}

interface SelectionRecord {
  count: number;
  lastAt: number;
}

export interface UserAdapterData {
  bySeq: Record<string, Record<string, SelectionRecord>>;
  global: Record<string, SelectionRecord>;
  phrases: LexiconEntry[];
}

const DEFAULTS = {
  enabled: true,
  boostPerCount: 0.55,
  maxSeqBoost: 2.2,
  globalFactor: 0.35,
  /** 手動造詞＝使用者明確意圖，加成必須壓過常規 LM 差距（仍有界、非絕對覆寫） */
  manualPhraseBoost: 8.0,
};

export class UserAdapter {
  private readonly opts: Required<UserAdapterOptions>;
  private readonly bySeq = new Map<string, Map<string, SelectionRecord>>();
  private readonly global = new Map<string, SelectionRecord>();
  /** 手動造詞＋挖詞結果（帶讀音，交給 Decoder.addEntry 入格） */
  readonly phrases = new Map<string, LexiconEntry & { manual?: boolean }>();
  /** 已注入 decoder 的詞（避免重複 addEntry） */
  private injected = new Set<string>();

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
    const key = seq.join(' ');
    let m = this.bySeq.get(key);
    if (!m) {
      m = new Map();
      this.bySeq.set(key, m);
    }
    const rec = m.get(word) ?? { count: 0, lastAt: at };
    rec.count++;
    rec.lastAt = at;
    m.set(word, rec);

    const g = this.global.get(word) ?? { count: 0, lastAt: at };
    g.count++;
    g.lastAt = at;
    this.global.set(word, g);
  }

  /**
   * U(w)：給定上下文音節與候選詞，回傳 log-space 加成。
   * 有界：seqBoost 封頂於 maxSeqBoost；全域統計另乘 globalFactor 且封頂一半。
   */
  modifierFor(seq: readonly string[], word: string, at: number = Date.now()): number {
    if (!this.opts.enabled) return 0;

    // 手動詞條：最強（但仍有界）加成，且僅在讀音相符時由呼叫端保證 seq 一致
    if (this.phrases.get(word)?.manual === true) {
      return this.opts.manualPhraseBoost;
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
  setUserPhrase(word: string, readings: readonly string[]): void {
    this.phrases.set(word, {
      word,
      readings: [readings.slice()],
      provenance: ['user'],
      manual: true,
    });
  }

  /**
   * 從送出字串挖掘新詞（「讓 IME 學習造詞」項）：
   * 引擎把解碼路徑中連續的 UNK（□）span 交進來。
   * 首次出現即入格（覆蓋缺口是實測失敗案例的直接修法），
   * 但 freq 記錄出現次數供日後排序；重複出現不重複入格。
   */
  mineWord(word: string, reading: readonly string[], at: number = Date.now()): boolean {
    void at;
    const existing = this.phrases.get(word);
    if (existing) {
      if (!existing.manual) (existing as { freq?: number }).freq = (existing.freq ?? 1) + 1;
      return false;
    }
    if (word.length < 2) return false;
    this.phrases.set(word, {
      word,
      readings: [reading.slice()],
      provenance: ['mined'],
      freq: 1,
    });
    return true;
  }

  /** 注入尚未入格的詞條。 */
  drainPendingEntries(): LexiconEntry[] {
    const out: LexiconEntry[] = [];
    for (const e of this.phrases.values()) {
      if (!this.injected.has(e.word)) {
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

  static fromJSON(data: UserAdapterData, opts?: UserAdapterOptions): UserAdapter {
    const a = new UserAdapter(opts);
    for (const [k, v] of Object.entries(data.bySeq ?? {})) {
      a.bySeq.set(k, new Map(Object.entries(v)));
    }
    for (const [k, v] of Object.entries(data.global ?? {})) {
      a.global.set(k, v);
    }
    for (const p of data.phrases ?? []) {
      a.phrases.set(p.word, p);
    }
    return a;
  }
}

/** 半衰期 14 天的時間衰減（測試可傳固定 at 保持決定性）。 */
function recency(lastAt: number, now: number): number {
  const days = Math.max(0, (now - lastAt) / 86_400_000);
  return Math.pow(0.5, days / 14);
}
