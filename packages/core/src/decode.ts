/**
 * L4 詞格建構 + L5 解碼。
 *
 * 目標函數（Phase 1，無 L3/X 模組）：
 *   Score = Σ_i [ a·logP_word(w_i | 前兩詞) + γ·logP_char(w_i 的字 | 前兩字) ]
 *
 * 規則來自架構文件：
 * - 詞級與字級是 **log-linear 相加**，不是線性內插。
 * - N-best 必須用 list-Viterbi：每個（前兩詞）狀態保留 K 條部分路徑，
 *   樸素「最後兩詞不同」做法的差異會全擠在句尾。
 */
import type { LexiconEntry } from './index.js';
import type { Hypothesis } from './l3.js';

/** LM 側介面（結構化型別；@zhuyin/lm 的 LanguageModel 天然滿足）。 */
export interface Scorer {
  wordLogProb(w: string, w1: string, w2: string): number;
  charSequenceLogProb(word: string, charContext: readonly [string, string]): number;
}

/** 與訓練時一致的句首填充符。 */
export const BOS = '\u0002';
/** 與訓練時一致的句尾符。 */
export const EOS = '\u0003';

export interface DecoderOptions {
  /** 詞級權重 */
  a?: number;
  /** 字級第二專家權重（log-linear） */
  gamma?: number;
  /** 每狀態保留的部分路徑數（list-Viterbi K） */
  nBest?: number;
  /** 全域 beam 上限（成本控制） */
  beamWidth?: number;
  /**
   * 稀有字 IDF 加成：多字詞的每個字獲得 charIdf(ch) 的加成 × 此係數。
   * 對抗「高頻同音單字壓過低頻實質詞」（如 陰莖增大 vs 因更曾大）。
   * 0 = 關閉。
   */
  idfBonus?: number;
  /** 字的 IDF 查詢（呼叫端預先算好）；未提供則關閉加成 */
  charIdf?: (ch: string) => number;
  /** 破音字單字的 log 罰分（破音字幾乎不以單字存在） */
  polyPenalty?: number;
}

export interface WordBreakdown {
  word: string;
  /** a·logP_word 項 */
  wordTerm: number;
  /** γ·logP_char 項 */
  charTerm: number;
  /** X2 使用者適應修飾 U(w)（log-space 加成） */
  uTerm: number;
  /** L3 通道項：−（把觀察音節更正為 reading 的代價）；未更正為 0 */
  chTerm: number;
  /** 該詞消耗的音節數（引擎對齊用） */
  spanLen: number;
  /** 採用的讀音（L3 更正後的意圖音節；未更正時等於觀察音節） */
  reading: readonly string[];
}

/**
 * 修飾器（X2 使用者適應、L7 防閃動）：回傳詞的 log-space 加成；0 表示無修飾。
 * pos／spanLen 為詞在音節序列中的起點與長度，供位置相關的修飾使用。
 */
export type ScoreModifier = (word: string, pos: number, spanLen: number) => number;

export interface DecodeCallOptions {
  nBest?: number;
  modifier?: ScoreModifier;
  /**
   * L3 假設：每個位置的候選意圖音節（第一個須為觀察音節本身、代價 0）。
   * 每個詞最多更正一個音節。未提供＝只用觀察音節（與無 L3 完全相同）。
   */
  alternatives?: ReadonlyArray<ReadonlyArray<Hypothesis>>;
  /**
   * 使用者選字固定的詞段：解碼只走「該段恰好是這個詞」的路徑，
   * 跨過段邊界的詞一律不考慮。各段不可重疊（呼叫端保證）。
   */
  fixed?: ReadonlyArray<FixedSpan>;
}

/** 使用者選定的詞段：從第 pos 個音節起、len 個音節固定為 word */
export interface FixedSpan {
  pos: number;
  len: number;
  word: string;
}

/** 格中一條詞邊的候選（每次解碼每個 (起點, 長度) 只算一次） */
export interface SpanCand {
  word: string;
  reading: readonly string[];
  /** 通道代價（≥0） */
  cost: number;
}

export interface DecodePath {
  words: string[];
  score: number;
  breakdown: WordBreakdown[];
}

interface IndexEntry {
  word: string;
  reading: readonly string[];
}

interface PartialPath {
  pos: number;
  w1: string;
  w2: string;
  c1: string;
  c2: string;
  score: number;
  /** lazy 回溯鏈：避免每步複製詞序與拆解陣列 */
  parent: PartialPath | null;
  word: string;
  wordTerm: number;
  charTerm: number;
  uTerm: number;
  chTerm: number;
  spanLen: number;
  reading: readonly string[];
}

const UNK_WORD = '\u25A1'; // □
const UNK_PENALTY = Math.log(1e-7);
/**
 * 組字區裡的原樣字元（目前只有組字中按的空格）：不含任何注音符號的 token。
 * 解碼時原樣輸出、自成一詞，詞不能跨過它。
 */
export const isLiteralToken = (t: string): boolean => !/[ㄅ-ㄯ]/u.test(t);

/** spanCache 標記：此 span 被固定段擋住（不同於「查無詞」，不補 UNK） */
const BLOCKED: SpanCand[] = [];

export class Decoder {
  private readonly scorer: Scorer;
  private readonly opts: Required<DecoderOptions>;
  private index = new Map<string, IndexEntry[]>();
  private polyMap = new Map<string, number>(); // 詞 → 讀音數
  private polySingle = new Set<string>(); // 破音單字集合（用於重罰）
  private maxSpan = 1;

  constructor(scorer: Scorer, opts: DecoderOptions = {}) {
    this.scorer = scorer;
    this.opts = {
      a: opts.a ?? 0.8,
      gamma: opts.gamma ?? 0.5,
      nBest: opts.nBest ?? 4,
      beamWidth: opts.beamWidth ?? 200,
      idfBonus: opts.idfBonus ?? 0,
      charIdf: opts.charIdf ?? (() => 0),
      polyPenalty: opts.polyPenalty ?? 2.5,
    };
  }

  get config(): Required<DecoderOptions> {
    return this.opts;
  }

  /** 破音單字集合：供 PLL 重排時加重罰 */
  get polySingleChars(): ReadonlySet<string> {
    return this.polySingle;
  }

  /** 建立讀音索引：canonical 音節序列 → 詞候選（按詞頻排序）。單字詞同時是 OOV 音節的回退來源。 */
  loadLexicon(entries: readonly LexiconEntry[]): void {
    this.index = new Map();
    this.polyMap = new Map();
    this.polySingle = new Set();
    let maxSpan = 1;
    const withFreq: Array<{ e: LexiconEntry; reading: readonly string[]; f: number }> = [];
    for (const e of entries) {
      const f = e.freq ?? 0;
      const prev = this.polyMap.get(e.word) ?? 0;
      this.polyMap.set(e.word, Math.max(prev, e.readings.length));
      if ([...e.word].length === 1 && e.readings.length > 1) {
        this.polySingle.add(e.word);
      }
      for (const reading of e.readings) {
        if (reading.length > this.maxSpanCap()) continue;
        withFreq.push({ e, reading, f });
        if (reading.length > maxSpan) maxSpan = reading.length;
      }
    }
    // 高頻優先；解碼時每個 span 只取前 entryCap 個，控制格密度
    withFreq.sort((x, y) => y.f - x.f);
    for (const { e, reading } of withFreq) {
      const key = reading.join(' ');
      let list = this.index.get(key);
      if (!list) {
        list = [];
        this.index.set(key, list);
      }
      list.push({ word: e.word, reading });
    }
    this.maxSpan = Math.min(maxSpan, this.maxSpanCap());
  }

  /** 每個 span 展開的最多候選詞數（高頻優先）。 */
  entryCap = 48;
  /** L3 更正讀音每個 key 取的最多候選詞數（控制單音節更正爆量） */
  altEntryCap = 8;
  /** 單音節只在原讀音查無詞時才套用 L3 更正（見 spanCands） */
  altSingleOnlyIfEmpty = true;

  /**
   * (起點, 長度) 的候選詞：原讀音 + 每詞最多一處 L3 更正。同詞取最低代價。
   * cap：原讀音取前幾個詞（高頻優先）；選字視窗要列全部時傳 Infinity。
   */
  spanCands(
    sequence: readonly string[],
    pos: number,
    len: number,
    alts: ReadonlyArray<ReadonlyArray<Hypothesis>> | undefined,
    cap = this.entryCap,
  ): SpanCand[] {
    const obs = sequence.slice(pos, pos + len);
    if (obs.some(isLiteralToken))
      return len === 1 ? [{ word: obs[0]!, reading: obs, cost: 0 }] : [];
    const best = new Map<string, SpanCand>();
    const take = (reading: readonly string[], cost: number, cap: number): void => {
      const entries = this.index.get(reading.join(' '));
      if (!entries) return;
      for (let i = 0; i < Math.min(cap, entries.length); i++) {
        const w = entries[i]!.word;
        const prev = best.get(w);
        if (!prev || cost < prev.cost) best.set(w, { word: w, reading, cost });
      }
    };
    take(obs, 0, cap);
    // 單音節更正只在觀察音節查無任何詞（多半是不合法音節）時才做：
    // 單音節替代每格會多出上百個單字候選、解碼慢 5–10 倍，且 LM 只是在近音單字裡挑。
    // 多音節更正查詢稀疏（只有真實存在的詞），成本低、價值高，一律做。
    if (alts && len === 1 && this.altSingleOnlyIfEmpty && best.size > 0) return [...best.values()];
    if (alts) {
      for (let i = 0; i < len; i++) {
        for (const h of alts[pos + i] ?? []) {
          if (h.cost === 0) continue;
          const r = obs.slice();
          r[i] = h.syl;
          take(r, h.cost, this.altEntryCap);
        }
      }
    }
    return [...best.values()];
  }

  private maxSpanCap(): number {
    return 10;
  }

  get stats(): { spans: number; maxSpan: number } {
    return { spans: this.index.size, maxSpan: this.maxSpan };
  }

  /** 解碼音節序列，回傳 N-best（含逐詞分數拆解）。 */
  decode(sequence: readonly string[], callOpts: DecodeCallOptions = {}): DecodePath[] {
    const n = sequence.length;
    if (n === 0) return [];
    const nBest = callOpts.nBest ?? this.opts.nBest;
    const modifier = callOpts.modifier;
    const fixed = callOpts.fixed ?? [];

    // buckets[pos][stateKey] = 該狀態的 top-K 部分路徑
    const buckets: Array<Map<string, PartialPath[]>> = Array.from(
      { length: n + 1 },
      () => new Map(),
    );
    const seed: PartialPath = {
      pos: 0,
      w1: '',
      w2: '',
      c1: BOS,
      c2: BOS,
      score: 0,
      parent: null,
      word: '',
      wordTerm: 0,
      charTerm: 0,
      uTerm: 0,
      chTerm: 0,
      spanLen: 0,
      reading: [],
    };
    buckets[0]!.set('\t', [seed]);
    // (起點, 長度) → 候選詞；與狀態無關，整次解碼共用
    const spanCache = new Map<number, SpanCand[]>();

    for (let pos = 0; pos < n; pos++) {
      const stateGroups = buckets[pos]!;
      if (stateGroups.size === 0) continue;
      const maxLen = Math.min(this.maxSpan, n - pos);
      const touched = new Set<Map<string, PartialPath[]>>();

      // 同一狀態（前兩詞）的所有路徑共享 LM 查詢結果：
      // 詞級上下文相同、字級尾二字亦由詞序決定而相同 → 每組每邊算一次。
      for (const [stateKey, groupPaths] of stateGroups) {
        if (groupPaths.length === 0) continue;
        const [w1, w2] = stateKey.split('\t');
        // 組內字級上下文取代表路徑（同狀態 ⇒ 相同）
        const rep = groupPaths[0]!;

        for (let len = 1; len <= maxLen; len++) {
          const ck = pos * 64 + len;
          let capped = spanCache.get(ck);
          if (!capped) {
            capped = this.spanCands(sequence, pos, len, callOpts.alternatives);
            const f = fixed.find((x) => x.pos < pos + len && pos < x.pos + x.len);
            if (f) {
              // 與固定段重疊：只有恰好等於該段的那個詞能走（找不到就走不通，不補 UNK）
              const exact = f.pos === pos && f.len === len;
              capped = exact ? capped.filter((c) => c.word === f.word) : [];
              if (exact && capped.length === 0) {
                const all = this.spanCands(sequence, pos, len, callOpts.alternatives, Infinity);
                capped = all.filter((c) => c.word === f.word);
              }
              if (capped.length === 0) capped = BLOCKED;
            }
            spanCache.set(ck, capped);
          }
          if (capped === BLOCKED) continue;
          // 詞邊必須落在「實際結束位置」的桶，不是 pos+1
          const target = buckets[pos + len]!;
          touched.add(target);
          if (capped.length === 0) {
            if (len === 1) {
              // OOV 音節：以未知詞邊保證格連通
              for (const p of groupPaths) {
                this.extend(p, UNK_WORD, UNK_PENALTY, 0, 0, 0, 1, [sequence[pos]!], target);
              }
            }
            continue;
          }
          const lpws = new Array<number>(capped.length);
          for (let i = 0; i < capped.length; i++) {
            let lp = this.scorer.wordLogProb(capped[i]!.word, w1!, w2!);
            // 破音字單字重罰：破音字幾乎不以單字存在
            const w = capped[i]!.word;
            if (this.polySingle.has(w) && [...w].length === 1) {
              lp -= this.opts.polyPenalty;
            }
            lpws[i] = lp;
          }
          const lpcs =
            this.opts.gamma === 0
              ? null
              : capped.map((ent) => this.scorer.charSequenceLogProb(ent.word, [rep.c1, rep.c2]));
          // U(w) 每組只查一次（同狀態共享；修飾器理應與路徑無關）
          const us = modifier ? capped.map((ent) => modifier(ent.word, pos, len)) : null;
          // 稀有字 IDF：低頻成字構成的詞獲得加成（對抗高頻同音單字路徑）
          const idfs =
            this.opts.idfBonus > 0
              ? capped.map((ent) => {
                  let sum = 0;
                  for (const ch of ent.word) sum += this.opts.charIdf(ch);
                  return this.opts.idfBonus * sum;
                })
              : null;
          for (let i = 0; i < capped.length; i++) {
            const ent = capped[i]!;
            const lpw = lpws[i]!;
            const lpc = lpcs ? lpcs[i]! : 0;
            const u = (us ? us[i]! : 0) + (idfs ? idfs[i]! : 0);
            for (const p of groupPaths) {
              this.extend(p, ent.word, lpw, lpc, u, -ent.cost, len, ent.reading, target);
            }
          }
        }
      }

      // list-Viterbi 剪枝：每狀態 top-K，全域 beam 上限
      for (const bucket of touched) {
        const pruned: PartialPath[] = [];
        for (const [stateKey, paths] of bucket) {
          if (paths.length > nBest) {
            paths.sort((x, y) => y.score - x.score);
            bucket.set(stateKey, paths.slice(0, nBest));
          }
          pruned.push(...bucket.get(stateKey)!.slice(0, nBest));
        }
        pruned.sort((x, y) => y.score - x.score);
        if (pruned.length > this.opts.beamWidth) {
          const keep = new Set(pruned.slice(0, this.opts.beamWidth));
          for (const [stateKey, paths] of bucket) {
            bucket.set(
              stateKey,
              paths.filter((pp) => keep.has(pp)),
            );
          }
        }
      }
    }

    // 句尾項：P(EOS | 末兩詞) 與 P(EOS | 末兩字)。LM 沒訓練過 EOS 時對所有路徑近乎常數。
    // 句尾項併入末詞的拆解，維持「拆解之和 = 總分」。
    const finals = [...buckets[n]!.values()].flat().map((p) => {
      const eosW = this.opts.a * this.scorer.wordLogProb(EOS, p.w1, p.w2);
      const eosC =
        this.opts.gamma === 0
          ? 0
          : this.opts.gamma * this.scorer.charSequenceLogProb(EOS, [p.c1, p.c2]);
      return {
        ...p,
        wordTerm: p.wordTerm + eosW,
        charTerm: p.charTerm + eosC,
        score: p.score + eosW + eosC,
      };
    });
    finals.sort((x, y) => y.score - x.score);
    return finals.slice(0, nBest).map((p) => this.materialize(p));
  }

  private extend(
    p: PartialPath,
    word: string,
    lpw: number,
    lpc: number,
    uBonus: number,
    chTerm: number,
    spanLen: number,
    reading: readonly string[],
    target: Map<string, PartialPath[]>,
  ): void {
    const wordTerm = this.opts.a * lpw;
    const charTerm = this.opts.gamma * lpc;
    let c1 = p.c1;
    let c2 = p.c2;
    for (const ch of word) {
      c1 = c2;
      c2 = ch;
    }
    const np: PartialPath = {
      pos: p.pos + spanLen,
      w1: p.w2,
      w2: word,
      c1,
      c2,
      score: p.score + wordTerm + charTerm + uBonus + chTerm,
      parent: p,
      word,
      wordTerm,
      charTerm,
      uTerm: uBonus,
      chTerm,
      spanLen,
      reading,
    };
    const stateKey = `${np.w1}\t${np.w2}`;
    let list = target.get(stateKey);
    if (!list) {
      list = [];
      target.set(stateKey, list);
    }
    list.push(np);
  }

  private materialize(p: PartialPath): DecodePath {
    // 回溯鏈 → 詞序與拆解（seed 的空詞不計）
    const chain: WordBreakdown[] = [];
    for (let cur = p; cur.parent !== null; cur = cur.parent) {
      chain.push({
        word: cur.word,
        wordTerm: cur.wordTerm,
        charTerm: cur.charTerm,
        uTerm: cur.uTerm,
        chTerm: cur.chTerm,
        spanLen: cur.spanLen,
        reading: cur.reading,
      });
    }
    chain.reverse();
    return {
      words: chain.map((c) => c.word),
      score: p.score,
      breakdown: chain,
    };
  }

  /** 增量加入詞條（X2 挖詞／使用者造詞），不重建整個索引。 */
  addEntry(entry: LexiconEntry): void {
    for (const reading of entry.readings) {
      if (reading.length > this.maxSpanCap()) continue;
      if (reading.length > this.maxSpan) this.maxSpan = reading.length;
      const key = reading.join(' ');
      let list = this.index.get(key);
      if (!list) {
        list = [];
        this.index.set(key, list);
      }
      if (!list.some((x) => x.word === entry.word)) {
        // 新詞無頻次證據，插到尾端（不搶高頻候選的位子）
        list.push({ word: entry.word, reading });
      }
    }
  }

  /** 該讀音下是否已存在指定詞（挖詞去重用）。 */
  hasEntry(reading: readonly string[], word: string): boolean {
    return this.index.get(reading.join(' '))?.some((x) => x.word === word) ?? false;
  }
}
