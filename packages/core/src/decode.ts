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
  /** 該詞消耗的音節數（引擎對齊用） */
  spanLen: number;
}

/**
 * 修飾器（X2 使用者適應、L7 防閃動）：回傳詞的 log-space 加成；0 表示無修飾。
 * pos／spanLen 為詞在音節序列中的起點與長度，供位置相關的修飾使用。
 */
export type ScoreModifier = (word: string, pos: number, spanLen: number) => number;

export interface DecodeCallOptions {
  nBest?: number;
  modifier?: ScoreModifier;
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
  spanLen: number;
}

const UNK_WORD = '\u25A1'; // □
const UNK_PENALTY = Math.log(1e-7);

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
      spanLen: 0,
    };
    buckets[0]!.set('\t', [seed]);

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
          const key = sequence.slice(pos, pos + len).join(' ');
          const entries = this.index.get(key);
          // 詞邊必須落在「實際結束位置」的桶，不是 pos+1
          const target = buckets[pos + len]!;
          touched.add(target);
          if (!entries || entries.length === 0) {
            if (len === 1) {
              // OOV 音節：以未知詞邊保證格連通
              for (const p of groupPaths) {
                this.extend(p, UNK_WORD, UNK_PENALTY, 0, 0, 1, target);
              }
            }
            continue;
          }
          const capped = entries.length > this.entryCap ? entries.slice(0, this.entryCap) : entries;
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
              this.extend(p, ent.word, lpw, lpc, u, len, target);
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
    spanLen: number,
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
      score: p.score + wordTerm + charTerm + uBonus,
      parent: p,
      word,
      wordTerm,
      charTerm,
      uTerm: uBonus,
      spanLen,
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
        spanLen: cur.spanLen,
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
