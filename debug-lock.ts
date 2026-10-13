// L7 防閃動評估（L6 改過的詞加分）：逐音節打字、每音節間 L6 都跑完（最壞閃動情境）。
// 量最終準確率、已顯示字被改掉的字數、L6→L5 回滾次數。npx tsx debug-lock.ts [nColl] [nWritten]
import { syllableToKeyCodes } from './packages/core/src/index.js';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';
import { ImeEngine } from './packages/cli/src/engine.js';
import { PllReranker } from './packages/rerank/src/reranker.js';

const rt = await loadRuntime();
const rr = await PllReranker.create({ weight: 0.5, maxCandidates: 16, gapThreshold: 6, flipMargin: 0.75, charFreq: (ch) => rt.lm.char.uni.get(ch) ?? 0 });
const sets = {
  口語: (await loadEvalSamples('eval/colloquial.jsonl')).slice(0, Number(process.argv[2] ?? 150)),
  書面: (await loadEvalSamples('eval/written.jsonl')).slice(0, Number(process.argv[3] ?? 100)),
};
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const diff = (a: string, b: string): number => {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) d++;
  return d;
};

for (const bonus of [1, 2, 4, 8]) {
  const row: string[] = [`stickBonus=${bonus}`.padEnd(20)];
  for (const [name, ss] of Object.entries(sets)) {
    let ok = 0, revised = 0, rollback = 0;
    for (const s of ss) {
      let pending: Promise<unknown> = Promise.resolve();
      const disp: Array<{ src: 'L5' | 'L6'; text: string }> = [];
      const engine = new ImeEngine(rt.decoder, rt.legalSyllables, undefined, undefined, {
        rerank: (p) => (pending = rr.rerank(p).then((r) => r.paths)) as Promise<typeof p>,
        onUpdate: (st) => disp.push({ src: 'L6', text: st.composition }),
        stickBonus: bonus,
      });
      for (const syl of s.syllables) {
        let st;
        for (const code of syllableToKeyCodes(syl)) st = engine.onKey({ code, timestampMs: 0 });
        disp.push({ src: 'L5', text: st!.composition });
        await pending;
        await tick();
      }
      for (let i = 1; i < disp.length; i++) {
        const d = diff(disp[i - 1]!.text, disp[i]!.text);
        revised += d;
        if (d > 0 && disp[i - 1]!.src === 'L6' && disp[i]!.src === 'L5') rollback++;
      }
      if (engine.commit() === s.text) ok++;
    }
    const n = ss.length;
    row.push(`${name} 句準 ${((ok / n) * 100).toFixed(1)} 改字/句 ${(revised / n).toFixed(2)} 回滾/句 ${(rollback / n).toFixed(2)}`);
  }
  console.log(row.join(' | '));
}
process.exit(0);
