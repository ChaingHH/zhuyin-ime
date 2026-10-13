/**
 * n-gram 語言模型 runtime（預設 interpolated Kneser-Ney；stupid backoff 保留為對照）。
 *
 * 設計對應架構文件 L5：
 * - 詞級三元 P_word(w | 前兩詞) 與字級三元 P_char(c | 前兩字) 為兩個獨立專家，
 *   在解碼器以 log-linear 相加（權重 a、γ），不做線性內插。
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { HashTable } from './hashtable.js';

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
  /** 首詞作為二元上下文：後接計數總和、後接型別數 N1+(w •) */
  biTotals: Map<string, number>;
  biTypes: Map<string, number>;
  /**
   * "w1 w2" → 欄 0：二元計數；欄 1／2：作為三元上下文時的後接計數總和／型別數。
   * 大表放 typed array（見 hashtable.ts）。
   */
  bi: HashTable;
  /** "w1 w2\tw" → 三元計數 */
  tri: HashTable;
}

const BACKOFF = 0.4;

function emptyIndex(): NgramIndex {
  return {
    uni: new Map(),
    total: 0,
    cont: new Map(),
    contTotal: 0,
    biTotals: new Map(),
    biTypes: new Map(),
    bi: new HashTable(3),
    tri: new HashTable(1),
  };
}

const inc = (m: Map<string, number>, k: string, v: number): void => {
  m.set(k, (m.get(k) ?? 0) + v);
};

/** 一筆 n-gram 計數併入索引。order：1=uni、2=bi（"w1 w2"）、3=tri（"w1 w2\tw"）。 */
function addEntry(idx: NgramIndex, order: number, key: string, count: number): void {
  if (order === 1) {
    inc(idx.uni, key, count);
    idx.total += count;
  } else if (order === 2) {
    const sp = key.indexOf(' ');
    const c1 = key.slice(0, sp);
    idx.bi.add(key, 0, count);
    inc(idx.biTotals, c1, count);
    inc(idx.biTypes, c1, 1);
    inc(idx.cont, key.slice(sp + 1), 1);
    idx.contTotal++;
  } else {
    const ctx = key.slice(0, key.indexOf('\t'));
    idx.tri.add(key, 0, count);
    idx.bi.add(ctx, 1, count);
    idx.bi.add(ctx, 2, 1);
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

  /** 載入 .json（舊格式）或 .tsv（逐行 section\tcount\tkey，train.ts 輸出）。 */
  static async load(file: string): Promise<LanguageModel> {
    const lm = new LanguageModel();
    const add = (sec: string, key: string, count: number): void => {
      const s = SECTIONS[sec];
      if (s) addEntry(lm[s[0]], s[1], key, count);
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
      return lm;
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
    return lm;
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
      const c = idx.bi.get(`${c2} ${w}`);
      p = Math.max(c - D, 0) / bt + ((D * idx.biTypes.get(c2)!) / bt) * p;
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
    // 舊行為保留：退回二元時以 c1（較早的詞）為上下文
    const biCount = idx.bi.get(`${c1} ${w}`);
    if (biCount) {
      // P(w | c1) = count(c1,w) / count(c1,*)——正規化在「上下文」上，不是詞自身頻率
      const total1 = idx.biTotals.get(c1) ?? 0;
      return Math.log(BACKOFF * (biCount / total1));
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
