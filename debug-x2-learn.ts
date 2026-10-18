/**
 * X2 學習模擬：同一個 adapter（從空的開始）依序打完評測句、每句送出，看學習有沒有拖累後面的句子。
 * 走引擎（按鍵→組字→解碼→commit 學習），不開 L3、不選字。
 * 用法：ZHUYIN_NO_USER=1 npx tsx debug-x2-learn.ts [句數]
 */
import { UserAdapter, syllableToKeyCodes } from '@zhuyin/core';
import { ImeEngine } from './packages/cli/src/engine.js';
import { loadEvalSamples, loadRuntime } from './packages/cli/src/runtime.js';

const limit = Number(process.argv[2] ?? Infinity);
const { decoder, legalSyllables } = await loadRuntime({ a: 1, gamma: 0.5 });
for (const learn of [false, true]) {
  const adapter = new UserAdapter({ enabled: learn });
  const engine = new ImeEngine(decoder, legalSyllables, undefined, adapter);
  for (const f of ['colloquial', 'written']) {
    const samples = (await loadEvalSamples(`eval/${f}.jsonl`)).slice(0, limit);
    let ok = 0;
    for (const s of samples) {
      for (const syl of s.syllables)
        for (const code of syllableToKeyCodes(syl)) engine.onKey({ code, timestampMs: 0 });
      if (engine.commit() === s.text) ok++;
    }
    console.log(`學習${learn ? '開' : '關'} ${f}: ${((100 * ok) / samples.length).toFixed(2)}%`);
  }
}
