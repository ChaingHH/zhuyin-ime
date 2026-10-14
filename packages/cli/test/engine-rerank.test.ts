import { describe, it, expect } from 'vitest';
import { Decoder, syllableToKeyCodes, type DecodePath, type LexiconEntry } from '@zhuyin/core';
import { ImeEngine, type EngineState } from '../src/engine.js';

// 會 > 惠（L5）；假 L6 把順序反過來
const SCORER = {
  wordLogProb: (w: string): number => (w === '會' ? -1 : -2),
  charSequenceLogProb: (): number => 0,
};
const LEXICON: LexiconEntry[] = [
  { word: '會', readings: [['ㄏㄨㄟˋ']], provenance: ['moedict'] },
  { word: '惠', readings: [['ㄏㄨㄟˋ']], provenance: ['moedict'] },
];
const SYL = 'ㄏㄨㄟˋ';

/** 假重排：反轉順序；resolve 時機由測試手動控制 */
function deferredRerank(): {
  rerank: (p: DecodePath[]) => Promise<DecodePath[]>;
  calls: Array<{ paths: DecodePath[]; resolve: () => void }>;
} {
  const calls: Array<{ paths: DecodePath[]; resolve: () => void }> = [];
  return {
    calls,
    rerank: (paths) =>
      new Promise((res) => calls.push({ paths, resolve: () => res([...paths].reverse()) })),
  };
}

function setup(): {
  engine: ImeEngine;
  updates: EngineState[];
  calls: ReturnType<typeof deferredRerank>['calls'];
  type: () => EngineState;
} {
  const decoder = new Decoder(SCORER);
  decoder.loadLexicon(LEXICON);
  const { rerank, calls } = deferredRerank();
  const updates: EngineState[] = [];
  const engine = new ImeEngine(decoder, new Set([SYL]), undefined, undefined, {
    rerank,
    onUpdate: (s) => updates.push(s),
  });
  const type = (): EngineState => {
    let st!: EngineState;
    for (const code of syllableToKeyCodes(SYL)) st = engine.onKey({ code, timestampMs: 0 });
    return st;
  };
  return { engine, updates, calls, type };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('L6 非同步重排（先顯示 L5 再替換）', () => {
  it('onKey 立即回傳 L5，重排完成後 onUpdate 替換', async () => {
    const { engine, updates, calls, type } = setup();
    expect(type().composition).toBe('會');
    expect(calls).toHaveLength(1);
    calls[0]!.resolve();
    await flush();
    expect(updates.map((u) => u.composition)).toEqual(['惠']);
    expect(engine.getCandidates()[0]!.words.join('')).toBe('惠');
  });

  it('使用者已繼續打字 → 舊結果丟棄，結束後只補跑最新序列', async () => {
    const { updates, calls, type } = setup();
    type();
    type(); // 第一個重排還沒完成
    expect(calls).toHaveLength(1); // 同時最多一個
    calls[0]!.resolve();
    await flush();
    expect(updates).toHaveLength(0); // 過期
    expect(calls).toHaveLength(2);
    expect(calls[1]!.paths[0]!.words).toEqual(['會', '會']);
    calls[1]!.resolve();
    await flush();
    expect(updates).toHaveLength(1);
  });

  it('送出不等 BERT：未完成用 L5，完成後用重排結果；送出後的遲到結果丟棄', async () => {
    const a = setup();
    a.type();
    expect(a.engine.commit()).toBe('會');
    a.calls[0]!.resolve();
    await flush();
    expect(a.updates).toHaveLength(0);

    const b = setup();
    b.type();
    b.calls[0]!.resolve();
    await flush();
    expect(b.engine.commit()).toBe('惠');
  });

  it('切換 L6：舊重排器的遲到結果丟棄；關閉後不再重排', async () => {
    const { engine, updates, calls, type } = setup();
    type();
    const next = deferredRerank();
    engine.setRerankHooks({ rerank: next.rerank, onUpdate: (s) => updates.push(s) });
    calls[0]!.resolve(); // 舊重排器回來了
    await flush();
    expect(updates).toHaveLength(0);
    expect(engine.getCandidates()[0]!.words.join('')).toBe('會');
    type();
    expect(next.calls).toHaveLength(1); // 新重排器接手

    engine.setRerankHooks(undefined);
    type();
    expect(next.calls).toHaveLength(1);
  });
});

describe('L7 防閃動（L6 改過的詞加分）', () => {
  it('L6 改過的詞，下一個音節的 L5 不會改回去；加分綁定位置不外溢', async () => {
    const decoder = new Decoder(SCORER);
    decoder.loadLexicon(LEXICON);
    const { rerank, calls } = deferredRerank();
    const typeSyl = (engine: ImeEngine): EngineState => {
      let st!: EngineState;
      for (const code of syllableToKeyCodes(SYL)) st = engine.onKey({ code, timestampMs: 0 });
      return st;
    };
    const mk = (stickBonus: number): ImeEngine =>
      new ImeEngine(decoder, new Set([SYL]), undefined, undefined, { rerank, stickBonus });

    const sticky = mk(5);
    typeSyl(sticky);
    calls.at(-1)!.resolve(); // L6：會 → 惠
    await flush();
    expect(typeSyl(sticky).composition).toBe('惠會'); // 第 2 個位置沒有加分

    const free = mk(0);
    typeSyl(free);
    calls.at(-1)!.resolve();
    await flush();
    expect(typeSyl(free).composition).toBe('會會'); // 不加分：L5 改回去（閃動）
  });
});

describe('Backspace 與組字中畫面', () => {
  it('退掉已完成音節會重解碼；打到一半的音節不讓已解碼文字消失', () => {
    const decoder = new Decoder(SCORER);
    decoder.loadLexicon(LEXICON);
    const engine = new ImeEngine(decoder, new Set([SYL]));
    const key = (code: string): EngineState => engine.onKey({ code, timestampMs: 0 });
    const keys = syllableToKeyCodes(SYL);
    for (const c of [...keys, ...keys]) key(c);
    expect(engine.getCandidates()[0]!.words.join('')).toBe('會會');

    const partial = key(keys[0]!);
    expect(partial.composition.startsWith('會會')).toBe(true); // 已解碼文字保留
    expect(partial.composition.length).toBe(3);

    expect(key('Backspace').composition).toBe('會會'); // 退部分槽位
    const back = key('Backspace'); // 退已完成音節
    expect(back.composition).toBe('會');
    expect(back.candidates[0]!.words).toEqual(['會']);
    expect(engine.commit()).toBe('會');

    for (const c of keys) key(c);
    key('Backspace');
    expect(key('Backspace').composition).toBe(''); // 全部退光
    expect(engine.getCandidates()).toEqual([]);
  });
});
