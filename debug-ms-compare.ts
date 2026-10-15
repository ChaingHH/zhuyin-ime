// 和微軟注音對比（只到 L5）：讀 ms-bopomofo.ps1 的輸出，同句跑本引擎。
// ZHUYIN_NO_USER=1 [ZHUYIN_LM_MIN_BI=.. ZHUYIN_LM_MIN_TRI=.. ZHUYIN_LM_QUANT=..] npx tsx debug-ms-compare.ts <ms.tsv> [diffs.txt]
import { readFileSync, writeFileSync } from 'node:fs';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';

const ms = new Map<string, string>();
for (const line of readFileSync(process.argv[2]!, 'utf8').split(/\r?\n/)) {
  const [set, text, out] = line.split('\t');
  if (text) ms.set(`${set}\t${text}`, out ?? '');
}
const rt = await loadRuntime({ a: 1, gamma: 0.5 });
const charsOk = (out: string, ref: string): number => {
  const a = [...out];
  return [...ref].filter((c, i) => a[i] === c).length;
};

const diffs: string[] = [];
for (const set of ['colloquial', 'written']) {
  const st = { n: 0, chars: 0, ours: 0, oursC: 0, ms: 0, msC: 0, both: 0, oursOnly: 0, msOnly: 0 };
  for (const s of await loadEvalSamples(`eval/${set}.jsonl`)) {
    const m = ms.get(`${set}\t${s.text}`);
    if (m === undefined) continue;
    const o = rt.decoder.decode(s.syllables, { nBest: 1 })[0]?.words.join('') ?? '';
    st.n++;
    st.chars += [...s.text].length;
    st.oursC += charsOk(o, s.text);
    st.msC += charsOk(m, s.text);
    const okO = o === s.text;
    const okM = m === s.text;
    if (okO) st.ours++;
    if (okM) st.ms++;
    if (okO && okM) st.both++;
    else if (okO) st.oursOnly++;
    else if (okM) st.msOnly++;
    if (okO !== okM) diffs.push(`${okO ? '本引擎對' : '微軟對'}\t${s.text}\n\t本引擎 ${o}\n\t微軟   ${m}`);
  }
  const pct = (x: number, d: number): string => ((x / d) * 100).toFixed(1);
  console.log(
    `${set} n=${st.n} | 本引擎 句 ${pct(st.ours, st.n)} 字 ${pct(st.oursC, st.chars)} | 微軟 句 ${pct(st.ms, st.n)} 字 ${pct(st.msC, st.chars)} | 都對 ${st.both} 只有本引擎對 ${st.oursOnly} 只有微軟對 ${st.msOnly}`,
  );
}
if (process.argv[3]) writeFileSync(process.argv[3], diffs.join('\n'), 'utf8');
