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
import { LexiconIndex } from './lexicon.js';

/** LM 側介面（結構化型別；@zhuyin/lm 的 LanguageModel 天然滿足）。 */
export interface Scorer {
  wordLogProb(w: string, w1: string, w2: string): number;
  charSequenceLogProb(word: string, charContext: readonly [string, string]): number;
  /** 詞級 LM 有沒有這個詞（一元表裡有）。沒提供＝執行中加的詞照一般詞算（見 partsLogProb） */
  knowsWord?(w: string): boolean;
}

/** 與訓練時一致的句首填充符。 */
export const BOS = '\u0002';
/** 與訓練時一致的句尾符。 */
export const EOS = '\u0003';
/**
 * 英文類別符號（私用區字元）：訓練語料（build-big-corpus.ts CORPUS_EN=1）把一串英文詞換成它，
 * 解碼器把組字區裡的英文原樣 token 當成它來查 LM（詞、字兩個專家都是）。
 */
export const EN_CLASS = '';

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
/** LM 看到的詞：含拉丁字母的原樣 token（英文）換成 EN_CLASS，其他不變 */
export const lmToken = (w: string): string =>
  /[A-Za-z]/.test(w) && isLiteralToken(w) ? EN_CLASS : w;

/** spanCache 標記：此 span 被固定段擋住（不同於「查無詞」，不補 UNK） */
const BLOCKED: SpanCand[] = [];

export class Decoder {
  private readonly scorer: Scorer;
  private readonly opts: Required<DecoderOptions>;
  /** 讀音 → 詞，高頻在前（lexicon.ts） */
  private lex = LexiconIndex.build([], 10);
  private maxSpan = 1;
  /** decode 內每組每邊分數的暫存（重用，不夠大才放大；decode 不可重入） */
  private lpwBuf = new Float64Array(64);
  private lpcBuf = new Float64Array(64);
  private uBuf = new Float64Array(64);

  private growBufs(n: number): void {
    const size = Math.max(n, this.lpwBuf.length * 2);
    this.lpwBuf = new Float64Array(size);
    this.lpcBuf = new Float64Array(size);
    this.uBuf = new Float64Array(size);
  }

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

  /** 破音單字集合 */
  get polySingleChars(): ReadonlySet<string> {
    return this.lex.polySingle;
  }

  /** 目前的詞典索引（可存成位元組，下次用 useLexicon 直接載入） */
  get lexicon(): LexiconIndex {
    return this.lex;
  }

  /** 換上已建好的詞典索引（例如從 lexicon.bin 讀回來的） */
  useLexicon(lex: LexiconIndex): void {
    this.lex = lex;
    this.maxSpan = Math.min(lex.maxSpan, this.maxSpanCap());
  }

  /** 建立讀音索引：canonical 音節序列 → 詞候選（按詞頻排序）。單字詞同時是 OOV 音節的回退來源。 */
  loadLexicon(entries: readonly LexiconEntry[]): void {
    this.useLexicon(LexiconIndex.build(entries, this.maxSpanCap()));
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
      this.lex.each(reading, cap, (w) => {
        const prev = best.get(w);
        if (!prev || cost < prev.cost) best.set(w, { word: w, reading, cost });
      });
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
    return { spans: this.lex.size, maxSpan: this.maxSpan };
  }

  /** 解碼音節序列，回傳 N-best（含逐詞分數拆解）。 */
  decode(sequence: readonly string[], callOpts: DecodeCallOptions = {}): DecodePath[] {
    const n = sequence.length;
    if (n === 0) return [];
    const nBest = callOpts.nBest ?? this.opts.nBest;
    const modifier = callOpts.modifier;
    // 越界的固定段（編輯後殘留）直接忽略，不讓整個格斷掉
    const fixed = (callOpts.fixed ?? []).filter((f) => f.pos + f.len <= n);

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
    // floors[q]：位置 q 上次全域剪枝的門檻。剪完後該桶有 beam 條分數 ≥ 門檻的路徑，之後只會被
    // 更高分的換掉，所以分數嚴格低於門檻的新路徑一定會在下次剪枝被刪：直接不建（結果不變）
    const floors = new Float64Array(n + 1).fill(-Infinity);
    // counts[q]：位置 q 目前的路徑數；超過 2×beam 就先剪一次，門檻才早點生效
    // （一個位置的路徑大多來自前一兩個位置的短詞，最後才進來）
    const counts = new Uint32Array(n + 1);
    const beam = this.opts.beamWidth;

    for (let pos = 0; pos < n; pos++) {
      const stateGroups = buckets[pos]!;
      if (stateGroups.size === 0) continue;
      const maxLen = Math.min(this.maxSpan, n - pos);
      const touched = new Set<number>();

      // 同一狀態（前兩詞）的所有路徑共享 LM 查詢結果：
      // 詞級上下文相同、字級尾二字亦由詞序決定而相同 → 每組每邊算一次。
      for (const [stateKey, groupPaths] of stateGroups) {
        if (groupPaths.length === 0) continue;
        const [w1, w2] = stateKey.split('\t');
        // 組內字級上下文取代表路徑（同狀態 ⇒ 相同）
        const rep = groupPaths[0]!;
        const charCtx: readonly [string, string] = [rep.c1, rep.c2];

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
              // 選字清單最後一項「注音本身」：照原樣輸出那個音節（同原樣 token），不查詞典
              if (exact && capped.length === 0 && len === 1 && f.word === sequence[pos])
                capped = [{ word: f.word, reading: [f.word], cost: 0 }];
              if (capped.length === 0) capped = BLOCKED;
            }
            spanCache.set(ck, capped);
          }
          if (capped === BLOCKED) continue;
          // 詞邊必須落在「實際結束位置」的桶，不是 pos+1
          const target = buckets[pos + len]!;
          let floor = floors[pos + len]!;
          touched.add(pos + len);
          if (capped.length === 0) {
            if (len === 1) {
              // OOV 音節：以未知詞邊保證格連通
              for (const p of groupPaths) {
                counts[pos + 1]! += this.extend(
                  p,
                  UNK_WORD,
                  UNK_PENALTY,
                  0,
                  0,
                  0,
                  1,
                  [sequence[pos]!],
                  target,
                  nBest,
                );
              }
            }
            continue;
          }
          // 每組每邊的分數放進重用的暫存陣列：這段每鍵跑上萬次，每次新建陣列是主要垃圾來源
          const m = capped.length;
          if (m > this.lpwBuf.length) this.growBufs(m);
          const lpws = this.lpwBuf;
          const lpcs = this.lpcBuf;
          const us = this.uBuf;
          for (let i = 0; i < m; i++) {
            const w = lmToken(capped[i]!.word);
            let lp =
              this.runtimeWords.has(w) && this.scorer.knowsWord?.(w) === false
                ? this.partsLogProb(w, w1!, w2!)
                : this.scorer.wordLogProb(w, w1!, w2!);
            // 破音字單字重罰：破音字幾乎不以單字存在
            if (this.lex.polySingle.has(w) && [...w].length === 1) {
              lp -= this.opts.polyPenalty;
            }
            lpws[i] = lp;
            lpcs[i] = this.opts.gamma === 0 ? 0 : this.scorer.charSequenceLogProb(w, charCtx);
            // U(w) 每組只查一次（同狀態共享；修飾器理應與路徑無關）
            let u = modifier ? modifier(w, pos, len) : 0;
            // 稀有字 IDF：低頻成字構成的詞獲得加成（對抗高頻同音單字路徑）
            if (this.opts.idfBonus > 0) {
              let sum = 0;
              for (const ch of w) sum += this.opts.charIdf(ch);
              u += this.opts.idfBonus * sum;
            }
            us[i] = u;
          }
          const a = this.opts.a;
          const gamma = this.opts.gamma;
          for (let i = 0; i < m; i++) {
            const ent = capped[i]!;
            const word = ent.word;
            // LM 上下文（狀態鍵、w2、尾兩字）用 LM 看到的詞；輸出用原字
            const lw = lmToken(word);
            const wordTerm = a * lpws[i]!;
            const charTerm = gamma * lpcs[i]!;
            const uTerm = us[i]!;
            const chTerm = -ent.cost;
            // 組內路徑依分數由高到低：最高分都低於門檻就整個跳過（連鍵字串都不組）
            if (groupPaths[0]!.score + wordTerm + charTerm + uTerm + chTerm < floor) continue;
            // 同組同詞 ⇒ 新狀態（w2, word）與尾兩字都相同：鍵、清單、尾字只算一次。
            // 先算分數，進不了該狀態前 nBest 的路徑不建物件（每鍵上萬條，大多會被剪掉）
            const key = `${w2}\t${lw}`;
            let list = target.get(key);
            let c1 = '';
            let c2 = '';
            for (const p of groupPaths) {
              const score = p.score + wordTerm + charTerm + uTerm + chTerm;
              if (score < floor) break;
              if (list) {
                if (!Decoder.admits(list, score, nBest)) continue;
              } else {
                list = [];
                target.set(key, list);
              }
              if (c2 === '') {
                c1 = rep.c1;
                c2 = rep.c2;
                for (const ch of lw) {
                  c1 = c2;
                  c2 = ch;
                }
              }
              const np: PartialPath = {
                pos: p.pos + len,
                w1: p.w2,
                w2: lw,
                c1,
                c2,
                score,
                parent: p,
                word,
                wordTerm,
                charTerm,
                uTerm,
                chTerm,
                spanLen: len,
                reading: ent.reading,
              };
              counts[pos + len]! += Decoder.insert(list, np, nBest);
              if (counts[pos + len]! > 2 * beam) {
                floor = floors[pos + len] = Decoder.pruneBeam(target, beam);
                counts[pos + len] = beam;
                // 剪枝換掉了各狀態的陣列，重新取
                list = target.get(key);
                if (!list) break;
              }
            }
          }
        }
      }

      // list-Viterbi 剪枝：每狀態 top-K 已在插入時做完（insert），這裡只剩全域 beam 上限
      for (const q of touched) {
        if (counts[q]! <= beam) continue;
        floors[q] = Decoder.pruneBeam(buckets[q]!, beam);
        counts[q] = beam;
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
    // 同一串字的不同斷詞／讀音只留最高分那條，否則 N-best 會被同字路徑佔滿
    const out: DecodePath[] = [];
    const seen = new Set<string>();
    for (const p of finals) {
      if (out.length >= nBest) break;
      const m = this.materialize(p);
      const text = m.words.join('');
      if (seen.has(text)) continue;
      seen.add(text);
      out.push(m);
    }
    // 固定段的詞走不通（不在候選）時整個格斷掉：不帶固定段重解，畫面才不會變空
    if (out.length === 0 && fixed.length > 0) return this.decode(sequence, { ...callOpts, fixed: [] });
    return out;
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
    nBest: number,
  ): number {
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
    return Decoder.admits(list, np.score, nBest) ? Decoder.insert(list, np, nBest) : 0;
  }

  /** 狀態清單（分數由高到低、最多 nBest 條）收不收這個分數 */
  private static admits(list: PartialPath[], score: number, nBest: number): boolean {
    return list.length < nBest || score > list[list.length - 1]!.score;
  }

  /**
   * 依分數由高到低插入、超過 nBest 就丟最後一條。同分排在既有路徑之後，
   * 所以結果等同「全部收進來、穩定排序、取前 nBest」（原本的剪枝），只是被剪的路徑不必先建物件。
   */
  private static insert(list: PartialPath[], np: PartialPath, nBest: number): number {
    let i = list.length;
    list.push(np);
    while (i > 0 && list[i - 1]!.score < np.score) {
      list[i] = list[i - 1]!;
      i--;
    }
    list[i] = np;
    if (list.length <= nBest) return 1;
    list.pop();
    return 0;
  }

  /**
   * 全域 beam：只留分數前 beam 名，回傳門檻（第 beam 名的分數）。同分依桶的迭代順序保留前面的，
   * 等同原本「串接各狀態、穩定排序、取前 beam」。呼叫前須確定總數 > beam。
   */
  private static pruneBeam(bucket: Map<string, PartialPath[]>, beam: number): number {
    let total = 0;
    for (const paths of bucket.values()) total += paths.length;
    const scores = new Float64Array(total);
    let k = 0;
    for (const paths of bucket.values()) for (const pp of paths) scores[k++] = pp.score;
    scores.sort();
    const t = scores[total - beam]!;
    let ties = beam;
    for (let j = total - beam; j < total; j++) if (scores[j]! > t) ties--;
    for (const [stateKey, paths] of bucket) {
      bucket.set(
        stateKey,
        paths.filter((pp) => pp.score > t || (pp.score === t && ties-- > 0)),
      );
    }
    return t;
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

  /**
   * 執行中加的詞（使用者詞、挖詞）多半不在詞級 LM 裡，照未知詞算是約 −31，使用者詞的加成 8 也救不回來
   *（狀態欄輸給壯|泰|蘭）。改用它拆成 LM 認得的詞的最佳分數：同一串字 LM 本來就給得出的機率，
   * 和格裡「狀態|欄」那條路徑的詞級分數相同（含破音單字罰分），使用者詞的加成再加在上面。
   * 只拆 2–6 字（最多 31 種切法）；拆不出來（有一段 LM 不認得）就照舊。
   */
  private partsLogProb(w: string, w1: string, w2: string): number {
    const chars = [...w];
    const n = chars.length;
    let best = -Infinity;
    if (n >= 2 && n <= 6) {
      for (let mask = 1; mask < 1 << (n - 1); mask++) {
        let s = 0;
        let c1 = w1;
        let c2 = w2;
        let start = 0;
        let ok = true;
        for (let k = 1; k <= n && ok; k++) {
          if (k < n && (mask & (1 << (k - 1))) === 0) continue;
          const piece = chars.slice(start, k).join('');
          if (!this.scorer.knowsWord!(piece)) {
            ok = false;
            break;
          }
          let lp = this.scorer.wordLogProb(piece, c1, c2);
          if (k - start === 1 && this.lex.polySingle.has(piece)) lp -= this.opts.polyPenalty;
          s += lp;
          c1 = c2;
          c2 = piece;
          start = k;
        }
        if (ok && s > best) best = s;
      }
    }
    return best === -Infinity ? this.scorer.wordLogProb(w, w1, w2) : best;
  }

  /** 執行中加的詞（addEntry），詞級分數走 partsLogProb */
  private readonly runtimeWords = new Set<string>();

  /** 增量加入詞條（X2 挖詞／使用者造詞），不重建整個索引。 */
  addEntry(entry: LexiconEntry): void {
    this.runtimeWords.add(entry.word);
    for (const reading of entry.readings) {
      if (reading.length > this.maxSpanCap()) continue;
      if (reading.length > this.maxSpan) this.maxSpan = reading.length;
      // 新詞無頻次證據，接在尾端（不搶高頻候選的位子）
      this.lex.add(reading, entry.word);
    }
  }

  /** 該讀音下是否已存在指定詞（挖詞去重用）。 */
  hasEntry(reading: readonly string[], word: string): boolean {
    return this.lex.has(reading, word);
  }
}
