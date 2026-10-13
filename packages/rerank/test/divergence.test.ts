import { describe, it, expect } from 'vitest';
import {
  divergentPositions,
  planRerank,
  diverseSelection,
  boundarySignature,
  DivergenceLengthError,
} from '../src/divergence.js';

describe('分歧位置計算', () => {
  it('只標出候選間不一致的字位', () => {
    expect(divergentPositions(['今天天氣很好', '今天天氣真壞'])).toEqual([4, 5]);
  });

  it('單一候選或全一致 → 空陣列', () => {
    expect(divergentPositions(['相同句子'])).toEqual([]);
    expect(divergentPositions(['相同', '相同'])).toEqual([]);
  });

  it('長度不一致丟 DivergenceLengthError（同音節序列不可能，防呼叫端 bug）', () => {
    expect(() => divergentPositions(['三個字', '兩字'])).toThrow(DivergenceLengthError);
  });
});

describe('重排決策（純函式）', () => {
  const texts = ['降息了', '將錫了'];

  it('單候選跳過', () => {
    const p = planRerank([-1], ['只有一句']);
    expect(p.skip).toBe(true);
    expect(p.reason).toBe('single-candidate');
  });

  it('差距大於門檻跳過（延遲控制閥）', () => {
    const p = planRerank([-1, -9], texts, { gapThreshold: 4 });
    expect(p.skip).toBe(true);
    expect(p.reason).toBe('gap-above-threshold');
  });

  it('無分歧跳過', () => {
    const p = planRerank([-1, -1.1], ['一樣', '一樣'], { gapThreshold: 0 });
    expect(p.skip).toBe(true);
    expect(p.reason).toBe('no-divergence');
  });

  it('正常觸發：候選截取與遮位正確', () => {
    const p = planRerank([-1, -1.2, -5], [...texts, '醬西了'], {
      maxCandidates: 2,
      gapThreshold: 0,
    });
    expect(p.skip).toBe(false);
    expect(p.candidateIdx).toEqual([0, 1]);
    expect(p.maskPositions).toEqual([0, 1]);
  });

  it('maxCandidates 截斷後分歧位以子集計算', () => {
    // 第三候選在位 2 不同但被截掉 → 只看前兩個
    const p = planRerank([-1, -1.1, -1.2], ['aa b', 'aa b', 'xx y'], {
      maxCandidates: 3,
      gapThreshold: 0,
    });
    expect(p.candidateIdx.length).toBe(3);
    expect(p.maskPositions).toEqual([0, 1, 3]);
    const p2 = planRerank([-1, -1.1, -1.2], ['aa b', 'aa b', 'xx y'], {
      maxCandidates: 2,
      gapThreshold: 0,
    });
    expect(p2.maskPositions).toEqual([]);
    expect(p2.reason).toBe('no-divergence');
  });
});

describe('斷詞多樣性選擇', () => {
  it('跨家族輪替取樣：深處的不同斷詞家族代表會入選', () => {
    // 家族 A（2,1）佔據 rank1-4，家族 B（1,2）在 rank5-6，家族 C（3）rank7
    const spanLens = [[2, 1], [2, 1], [2, 1], [2, 1], [1, 2], [1, 2], [3]];
    const sel = diverseSelection(spanLens, 6);
    expect(sel).toContain(0); // A 最佳
    expect(sel).toContain(4); // B 代表（rank5）
    expect(sel).toContain(6); // C 代表（rank7）——盲取 top-6 會漏掉
    expect(sel).toHaveLength(6);
  });

  it('k 用盡時按家族輪替公平分配', () => {
    const spanLens = [
      [2, 1],
      [2, 1],
      [2, 1],
      [1, 1, 1],
    ];
    const sel = diverseSelection(spanLens, 3);
    expect(sel.filter((i) => i < 3)).toHaveLength(2);
    expect(sel).toContain(3);
  });

  it('邊界特徵相同視為同家族', () => {
    expect(boundarySignature([2, 1])).toBe(boundarySignature([2, 1]));
    expect(boundarySignature([2, 1])).not.toBe(boundarySignature([1, 2]));
  });

  it('k 大於候選數時全取', () => {
    const sel = diverseSelection([[1], [2]], 8);
    expect(sel).toEqual([0, 1]);
  });
});
