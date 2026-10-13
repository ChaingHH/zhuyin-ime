/**
 * 分歧位置計算（純函式，無模型依賴）。
 *
 * 批次 PLL 的關鍵省算：N-best 各候選**一致**的字位對排序毫無貢獻，
 * 只需遮「分歧位」——這是 1349ms→93ms 的第一層來源（報告 §L6）。
 */

/** 候選句長度不一致時的行為：同音節序列解出的候選必然等長；違反視為呼叫端 bug。 */
export class DivergenceLengthError extends Error {}

export function toChars(text: string): string[] {
  return [...text];
}

/**
 * 回傳各候選不一致的字元索引（遞增）。
 */
export function divergentPositions(texts: readonly string[]): number[] {
  if (texts.length < 2) return [];
  const first = toChars(texts[0]!);
  const others = texts.slice(1).map(toChars);
  for (const c of others) {
    if (c.length !== first.length) {
      throw new DivergenceLengthError(`候選長度不一：${first.length} vs ${c.length}`);
    }
  }
  const pos: number[] = [];
  for (let i = 0; i < first.length; i++) {
    const ref = first[i]!;
    if (others.some((c) => c[i] !== ref)) pos.push(i);
  }
  return pos;
}

export interface RerankPlan {
  /** 參與重排的候選索引（原 paths 陣列的下標） */
  candidateIdx: number[];
  /** 需遮罩的字元位（相對候選句） */
  maskPositions: number[];
  /** 不重排的原因（skip 時有意義） */
  skip: boolean;
  reason?: 'single-candidate' | 'gap-above-threshold' | 'no-divergence';
}

/** 斷詞邊界特徵：各詞消耗的音節數序列（同構即同家族）。 */
export function boundarySignature(spanLens: readonly number[]): string {
  return spanLens.join(',');
}

/**
 * 斷詞多樣性候選選擇。
 *
 * 按 LM 分數盲取 top-K 會被同一斷詞家族的同音變體塞滿，
 * 結構不同的正解（例如 [憑][條碼] vs [平調][碼]）排在深處就永遠進不了重排。
 * 此處先依邊界特徵分組、跨家族輪替取樣——每個家族的代表都有機會讓 PLL 評判。
 */
export function diverseSelection(
  spanLensPerPath: readonly (readonly number[])[],
  k: number,
): number[] {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < spanLensPerPath.length; i++) {
    const sig = boundarySignature(spanLensPerPath[i]!);
    let g = groups.get(sig);
    if (!g) {
      g = [];
      groups.set(sig, g);
    }
    g.push(i);
  }
  // 家族按其最佳成員的名次排序（名次即加入順序）
  const ordered = [...groups.values()];
  ordered.sort((a, b) => a[0]! - b[0]!);
  const out: number[] = [];
  let took = true;
  while (out.length < k && took) {
    took = false;
    for (const g of ordered) {
      if (g.length > 0 && out.length < k) {
        out.push(g.shift()!);
        took = true;
      }
    }
  }
  return out.sort((a, b) => a - b);
}

/** 純決策：要不要重排、重排哪些。方便單測與延遲歸因。 */
export function planRerank(
  scores: readonly number[],
  texts: readonly string[],
  opts: { maxCandidates?: number; gapThreshold?: number } = {},
): RerankPlan {
  const maxK = opts.maxCandidates ?? 8;
  if (scores.length < 2) {
    return { candidateIdx: [], maskPositions: [], skip: true, reason: 'single-candidate' };
  }
  const gap = scores[0]! - scores[1]!;
  if ((opts.gapThreshold ?? 0) > 0 && gap > (opts.gapThreshold ?? 0)) {
    return {
      candidateIdx: [],
      maskPositions: [],
      skip: true,
      reason: 'gap-above-threshold',
    };
  }
  const candidateIdx = scores.map((_, i) => i).slice(0, Math.min(maxK, scores.length));
  const maskPositions = divergentPositions(candidateIdx.map((i) => texts[i]!));
  if (maskPositions.length === 0) {
    return {
      candidateIdx,
      maskPositions,
      skip: true,
      reason: 'no-divergence',
    };
  }
  return { candidateIdx, maskPositions, skip: false };
}
