// 使用者詞學不起來的回歸（docs/MEMORY.md §7「狀態欄」）：真模型下，選一次「欄」送出之後，
// 單打與各種上下文是否變成狀態欄。對照「執行中加的詞照未知詞算」（舊）與「用拆分分數算」（新）。
// 也跑 debug-x2-learn.ts 的學習模擬（同一個 adapter 依序打完評測句、不選字）看一般句準有沒有掉。
// ZHUYIN_DATA=<data> npx tsx debug-user-phrase.ts [學習模擬句數，0＝不跑]
import { readFileSync } from 'node:fs';
import {
  Decoder,
  LexiconIndex,
  UserAdapter,
  syllableToKeyCodes,
  type LexiconEntry,
  type Scorer,
} from '@zhuyin/core';
import { BackoffLM } from '@zhuyin/lm';
import { ImeEngine } from './packages/cli/src/engine.js';
import { loadEvalSamples } from './packages/cli/src/runtime.js';
import { segment } from './packages/data-pipeline/src/build/evalset.js';

const DATA = process.env['ZHUYIN_DATA'] ?? 'data';
const learnN = Number(process.argv[2] ?? 0);
const lm = await BackoffLM.load(`${DATA}/models/lm.bo.bin`);
const lexBytes = readFileSync(`${DATA}/processed/lexicon.bin`);
const legal = (
  JSON.parse(readFileSync(`${DATA}/processed/syllables.json`, 'utf8')) as { syllables: string[] }
).syllables;
const lexMap = new Map<string, LexiconEntry>();
for (const l of readFileSync(`${DATA}/processed/lexicon.jsonl`, 'utf8').split('\n'))
  if (l) {
    const e = JSON.parse(l) as LexiconEntry;
    lexMap.set(e.word, e);
  }

// 舊行為：不告訴解碼器 LM 認得哪些詞 → 執行中加的詞照未知詞算
const oldScorer: Scorer = {
  wordLogProb: (w, w1, w2) => lm.wordLogProb(w, w1, w2),
  charSequenceLogProb: (w, c) => lm.charSequenceLogProb(w, c),
};
function engine(scorer: Scorer, adapter: UserAdapter): ImeEngine {
  const d = new Decoder(scorer, { a: 1, gamma: 0.5 });
  d.useLexicon(LexiconIndex.fromBytes(lexBytes));
  return new ImeEngine(d, legal, undefined, adapter);
}
const press = (e: ImeEngine, code: string) => e.onKey({ code, timestampMs: 0 });
function type(e: ImeEngine, syls: readonly string[]): string {
  let comp = '';
  for (const s of syls) for (const c of syllableToKeyCodes(s)) comp = press(e, c).composition;
  return comp;
}

const contexts = ['狀態欄', '下方的狀態欄', '顯示在狀態欄', '打開狀態欄', '狀態欄的圖示'];
for (const [label, scorer] of [
  ['舊（未知詞）', oldScorer],
  ['新（拆分）', lm as Scorer],
] as const) {
  const adapter = new UserAdapter();
  const e = engine(scorer, adapter);
  // 教一次：打 狀態ㄌㄢˊ、開選字視窗、選「欄」、送出
  type(e, ['ㄓㄨㄤˋ', 'ㄊㄞˋ', 'ㄌㄢˊ']);
  const items = press(e, 'ArrowDown').menu?.items ?? [];
  const i = items.indexOf('欄');
  press(e, `Digit${i + 1}`);
  const taught = e.commit();
  const row = [`${label} 教：${taught}（欄在第 ${i + 1} 個）`];
  for (const text of contexts) {
    const syls = segment(text, lexMap, 6, 1)!.syllables;
    const got = type(e, syls);
    press(e, 'Escape'); // 不送出、不學習
    row.push(`${got === text ? '✓' : '✗'}${got}`);
  }
  console.log(row.join(' | '));
}

// 學習模擬（debug-x2-learn.ts）：一般打字有沒有被挖詞的新分數拖累
if (learnN > 0)
  for (const [label, scorer] of [
    ['不學習', lm as Scorer],
    ['學習＋舊', oldScorer],
    ['學習＋新', lm as Scorer],
  ] as const) {
    const adapter = new UserAdapter({ enabled: label !== '不學習' });
    const e = engine(scorer, adapter);
    const row = [label];
    for (const f of ['colloquial', 'written']) {
      const samples = (await loadEvalSamples(`eval/${f}.jsonl`)).slice(0, learnN);
      let ok = 0;
      for (const s of samples) {
        type(e, s.syllables);
        if (e.commit() === s.text) ok++;
      }
      row.push(`${f} ${((100 * ok) / samples.length).toFixed(2)}%`);
    }
    console.log(row.join(' | '));
  }
