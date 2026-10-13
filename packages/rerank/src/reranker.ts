/**
 * L6 神經重排：批次 pseudo-log-likelihood。
 *
 * 方法（架構文件 §4 L6 + 報告實測）：
 * - 每個分歧位置遮一次、全部塞同一批 → 一次前向算完所有候選的 PLL。
 * - 只做獨立 PLL：遮位 p 時其餘分歧位保持原字可見。
 * - 不用 int8 動態量化——報告實測句準 70%→55% 崩盤；此處固定 fp32 ONNX。
 * - 最終分數 = a·LM(+γ字級+U) + b·PLL；b 即 weight。
 */
import {
  AutoTokenizer,
  AutoModelForMaskedLM,
  Tensor,
  type PreTrainedTokenizer,
  type PreTrainedModel,
} from '@huggingface/transformers';
import type { DecodePath } from '@zhuyin/core';
import { diverseSelection, planRerank, toChars, type RerankPlan } from './divergence.js';
import { RERANK_MODEL } from './config.js';

export interface RerankerOptions {
  /** b：PLL 權重 */
  weight?: number;
  maxCandidates?: number;
  /** L5 原始 N-best 第 1、2 名分差大於此值則不跑 BERT（0=永遠重排）。CLI 預設 6：dev 無損，約省 40% 重排 */
  gapThreshold?: number;
  modelId?: string;
  dtype?: 'fp32' | 'fp16';
  /**
   * 專有名詞保護：LM 原首選含稀有字（charFreq < rareCharThreshold）時，
   * 重排贏家領先幅度須 ≥ 此值才允許翻轉（0=不保護）。
   */
  flipMargin?: number;
  rareCharThreshold?: number;
  /** 字頻查詢（通常接 LM 的字 unigram）；未提供則保護機制停用 */
  charFreq?: (ch: string) => number;
  /** 破音單字集合：PLL 對含破音單字的候選加重罰 */
  polySingle?: ReadonlySet<string>;
  /**
   * LM 信心門檻：L5 top-1 比 top-2 高超過此值則不翻轉。
   * 預設關閉：KN + 大語料 LM 上實測任何門檻（2/4/8）都不比不設好。
   */
  lmConfidentGap?: number;
}

export interface RerankResult {
  paths: DecodePath[];
  /** 各候選的 PLL（未觸發時為空） */
  pll: number[];
  plan: RerankPlan;
  elapsedMs: number;
}

export class PllReranker {
  private tokenizer!: PreTrainedTokenizer;
  private model!: PreTrainedModel;
  readonly opts: Required<RerankerOptions> & { polySingle: ReadonlySet<string> };

  private constructor(opts: RerankerOptions) {
    this.opts = {
      weight: opts.weight ?? 0.25,
      maxCandidates: opts.maxCandidates ?? 12,
      gapThreshold: opts.gapThreshold ?? 0,
      modelId: opts.modelId ?? RERANK_MODEL,
      dtype: opts.dtype ?? 'fp32',
      flipMargin: opts.flipMargin ?? 0,
      rareCharThreshold: opts.rareCharThreshold ?? 200,
      charFreq: opts.charFreq ?? (() => Number.MAX_SAFE_INTEGER),
      polySingle: opts.polySingle ?? new Set(),
      lmConfidentGap: opts.lmConfidentGap ?? Infinity,
    };
  }

  static async create(opts: RerankerOptions = {}): Promise<PllReranker> {
    const r = new PllReranker(opts);
    r.tokenizer = (await AutoTokenizer.from_pretrained(r.opts.modelId)) as PreTrainedTokenizer;
    r.model = (await AutoModelForMaskedLM.from_pretrained(r.opts.modelId, {
      dtype: r.opts.dtype,
    })) as PreTrainedModel;
    return r;
  }

  /**
   * 重排 N-best。paths 會依「原分數 + weight×PLL」重新排序；
   * breakdown 為 L5 的拆解，不含 b·PLL（PLL 另列於結果）。
   */
  async rerank(paths: readonly DecodePath[]): Promise<RerankResult> {
    const t0 = performance.now();
    // L5 信心夠（原始 N-best 第 1、2 名分差 > gapThreshold）就不跑 BERT
    const lmGap = paths.length >= 2 ? paths[0]!.score - paths[1]!.score : Infinity;
    if (this.opts.gapThreshold > 0 && lmGap > this.opts.gapThreshold) {
      const plan: RerankPlan = {
        candidateIdx: [],
        maskPositions: [],
        skip: true,
        reason: 'gap-above-threshold',
      };
      return { paths: [...paths], pll: [], plan, elapsedMs: performance.now() - t0 };
    }
    const texts = paths.map((p) => p.words.join(''));
    // 斷詞多樣性選擇：先跨家族取樣，再做門檻/分歧判斷
    const selIdx = diverseSelection(
      paths.map((p) => p.breakdown.map((b) => b.spanLen)),
      this.opts.maxCandidates,
    );
    const subScores = selIdx.map((i) => paths[i]!.score);
    const subTexts = selIdx.map((i) => texts[i]!);
    // 分差門檻已在上面以原始排名判斷；這裡只做候選與分歧位規劃
    const plan = planRerank(subScores, subTexts, { maxCandidates: this.opts.maxCandidates });
    // 映射回原陣列下標
    const origPlan: RerankPlan = {
      ...plan,
      candidateIdx: plan.candidateIdx.map((j) => selIdx[j]!),
    };
    if (plan.skip) {
      return { paths: [...paths], pll: [], plan: origPlan, elapsedMs: performance.now() - t0 };
    }

    // 注意：candidateIdx 是子集相對索引，必須查 subTexts（已映射回原位）而非 texts
    const candTexts = plan.candidateIdx.map((i) => toChars(subTexts[i]!));
    const baseEnc = await this.encode(candTexts.map((c) => c.join('')));
    const maskId = BigInt(this.tokenizer.mask_token_id ?? 103);

    // 變體：每個（分歧位, 候選）一列
    const variantIds: bigint[][] = [];
    const targets: Array<{ row: number; tokenIdx: number; targetId: bigint; candIdx: number }> = [];
    let row = 0;
    for (const p of plan.maskPositions) {
      for (let ci = 0; ci < candTexts.length; ci++) {
        const ids = baseEnc.ids[ci]!.slice();
        const tokIdx = p + 1; // [CLS] 偏移
        if (tokIdx >= ids.length - 1) continue; // 越界防禦（不推入，candIdx 明確記錄）
        targets.push({ row, tokenIdx: tokIdx, targetId: ids[tokIdx]!, candIdx: ci });
        ids[tokIdx] = maskId;
        variantIds.push(ids);
        row++;
      }
    }
    if (variantIds.length === 0) {
      return { paths: [...paths], pll: [], plan: origPlan, elapsedMs: performance.now() - t0 };
    }

    const logits = await this.forward(variantIds);
    // log-softmax over vocab，逐變體取目標字
    const pllByCandidate = new Array<number>(candTexts.length).fill(0);
    const V = Number(logits.dims[2]!);
    const S = Number(logits.dims[1]!);
    const data = logits.data as Float32Array;
    for (const t of targets) {
      const off = t.row * S * V + t.tokenIdx * V;
      let maxv = -Infinity;
      for (let v = 0; v < V; v++) {
        if (data[off + v]! > maxv) maxv = data[off + v]!;
      }
      let sum = 0;
      let logp = 0;
      const tid = Number(t.targetId);
      for (let v = 0; v < V; v++) {
        const e = Math.exp(data[off + v]! - maxv);
        sum += e;
        if (v === tid) logp = data[off + v]! - maxv;
      }
      pllByCandidate[t.candIdx]! += logp - Math.log(sum);
    }

    const combined = paths.map((p) => ({ ...p }));
    origPlan.candidateIdx.forEach((origIdx, ci) => {
      combined[origIdx]!.score += this.opts.weight * (pllByCandidate[ci] ?? 0);
    });

    // 重排語意：被 PLL 評審過的子集依新分數排序、整體排在未評審者之前。
    // （PLL 恆為負，若讓未評審者以原始分參賽，會壓過所有受審候選。）
    const selSet = new Set(origPlan.candidateIdx);
    const judged = origPlan.candidateIdx.map((i) => combined[i]!).sort((x, y) => y.score - x.score);

    // 專有名詞保護：LM 原首選含稀有字（可能是人名/地名片段）時，
    // 除非 PLL 贏家以 ≥ flipMargin 的優勢勝出，否則維持原首選在首位。
    if (this.opts.flipMargin > 0 && paths.length > 0 && judged[0] !== undefined) {
      const origTop = combined[0]!;
      const origText = texts[0]!;
      const rareChars = toChars(origText).filter(
        (ch) => this.opts.charFreq(ch) < this.opts.rareCharThreshold,
      );
      const gap = judged[0].score - origTop.score;
      if (
        rareChars.length > 0 &&
        judged[0].words.join('') !== origText &&
        gap < this.opts.flipMargin
      ) {
        const restJudged = judged.filter((p) => p !== judged[0]);
        judged.splice(0, judged.length, origTop, ...restJudged);
      }
    }

    // LM 信心門檻：LM top-1 比 top-2 高超過 threshold → LM 已有明確偏好，PLL 不翻
    if (paths.length >= 2) {
      const lmGap = paths[0]!.score - paths[1]!.score;
      const lmConfident = lmGap > this.opts.lmConfidentGap;
      const pllTop = judged[0];
      if (lmConfident && pllTop && pllTop.words.join('') !== paths[0]!.words.join('')) {
        const restJudged = judged.filter((p) => p !== pllTop);
        judged.splice(0, judged.length, paths[0]!, ...restJudged);
      }
    }

    const rest = combined.filter((_p, i) => !selSet.has(i)).sort((x, y) => y.score - x.score);

    return {
      paths: [...judged, ...rest],
      pll: plan.candidateIdx.map((_, ci) => pllByCandidate[ci] ?? 0),
      plan: origPlan,
      elapsedMs: performance.now() - t0,
    };
  }

  /** [CLS] x... [SEP]，純 CJK 下字↔token 一一對應；不符者丟錯（呼叫端已保證）。 */
  private async encode(texts: string[]): Promise<{ ids: bigint[][] }> {
    const enc = await this.tokenizer(texts, { padding: false, truncation: true });
    const idsList = enc.input_ids.tolist() as bigint[][];
    // 驗證 1:1 對齊（CJK 逐字）
    for (let i = 0; i < texts.length; i++) {
      const n = toChars(texts[i]!).length;
      if (idsList[i]!.length !== n + 2) {
        throw new Error(`tokenizer 對齊失敗：${texts[i]!} tokens=${idsList[i]!.length} chars=${n}`);
      }
    }
    return { ids: idsList };
  }

  private async forward(batchIds: bigint[][]): Promise<Tensor> {
    const S = Math.max(...batchIds.map((b) => b.length));
    const B = batchIds.length;
    const ids = new BigInt64Array(B * S);
    const att = new BigInt64Array(B * S);
    for (let b = 0; b < B; b++) {
      for (let s = 0; s < S; s++) {
        const id = batchIds[b]![s];
        const has = id !== undefined;
        ids[b * S + s] = has ? id : BigInt(0);
        att[b * S + s] = has ? 1n : 0n;
      }
    }
    const out = await this.model({
      input_ids: new Tensor('int64', ids, [B, S]),
      attention_mask: new Tensor('int64', att, [B, S]),
    });
    return out.logits as Tensor;
  }
}
