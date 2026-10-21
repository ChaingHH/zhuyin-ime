// L3 評測：乾淨輸入＋X3 注入錯誤的輸入，比較 L3 關閉／開啟（代價乘 s）。
// dev = 偶數句、test = 奇數句。npx tsx debug-l3.ts [keyErr] [cogErr] [s1,s2,...]
import { performance } from 'node:perf_hooks';
import { Channel } from './packages/core/src/index.js';
import { loadRuntime, loadEvalSamples } from './packages/cli/src/runtime.js';
import { injectNoise, rng } from './packages/cli/src/noise.js';

const keyErr = Number(process.argv[2] ?? 0.03);
const cogErr = Number(process.argv[3] ?? 0.03);
const scales = (process.argv[4] ?? '0.6,1,1.5').split(',').map(Number);

const rt = await loadRuntime();
const legal = [...rt.legalSyllables];
const sets = {
  口語: await loadEvalSamples('eval/colloquial.jsonl'),
  書面: await loadEvalSamples('eval/written.jsonl'),
};
// 每句固定種子 → 每個設定看到同一組錯誤
const noisy = Object.fromEntries(
  Object.entries(sets).map(([name, ss]) => [
    name,
    ss.map((s, i) =>
      injectNoise(s.syllables, legal, { key: keyErr, cognitive: cogErr }, rng(1000 + i)),
    ),
  ]),
) as Record<string, string[][]>;
for (const [name, ss] of Object.entries(sets)) {
  const changed = ss.filter((s, i) => noisy[name]![i]!.join(' ') !== s.syllables.join(' ')).length;
  console.log(
    `[noise] ${name} 有錯的句子 ${((changed / ss.length) * 100).toFixed(1)}%（key=${keyErr} cog=${cogErr}）`,
  );
}

function run(label: string, ch: Channel | null): void {
  const row: string[] = [label.padEnd(10)];
  const lat: number[] = [];
  for (const input of ['乾淨', '有錯'] as const) {
    for (const [name, ss] of Object.entries(sets)) {
      const ok = [0, 0];
      ss.forEach((s, i) => {
        const obs = input === '乾淨' ? s.syllables : noisy[name]![i]!;
        const t0 = performance.now();
        const out = rt.decoder.decode(obs, {
          alternatives: ch ? obs.map((x) => ch.expand(x)) : undefined,
        });
        lat.push(performance.now() - t0);
        if (out[0]?.words.join('') === s.text) ok[i % 2]!++;
      });
      const n = ss.length;
      const pct = (k: number): string => ((ok[k]! / Math.ceil((n - k) / 2)) * 100).toFixed(1);
      row.push(`${input}${name} ${pct(0)}/${pct(1)}`);
    }
  }
  if (ch) {
    // 涵蓋率：注入錯誤的音節裡，正確音節出現在 ch.expand(觀察) 的比例（L3 的上限）
    let err = 0;
    let hit = 0;
    for (const [name, ss] of Object.entries(sets))
      ss.forEach((s, i) =>
        noisy[name]![i]!.forEach((o, j, all) => {
          if (all.length !== s.syllables.length) return;
          if (o === s.syllables[j]) return;
          err++;
          if (ch.expand(o).some((h) => h.syl === s.syllables[j])) hit++;
        }),
      );
    row.push(`涵蓋 ${hit}/${err} ${((hit / err) * 100).toFixed(1)}%`);
  }
  lat.sort((x, y) => x - y);
  row.push(
    `p50 ${lat[lat.length >> 1]!.toFixed(0)}ms p95 ${lat[Math.floor(lat.length * 0.95)]!.toFixed(0)}ms`,
  );
  console.log(row.join(' | '));
}

console.log('（每格 dev/test 句準）');
run('L3 關', null);
for (const s of scales) {
  const ch = new Channel(legal, {
    sub: 6 * s,
    extra: 7 * s,
    miss: 8 * s,
    toneAdj: 5 * s,
    tone: 7 * s,
    fuzzy: 5 * s,
    nasal: process.env.NASAL ? Number(process.env.NASAL) : undefined,
    maxAlts: process.env.MAXALTS ? Number(process.env.MAXALTS) : undefined,
  });
  run(`L3 s=${s}`, ch);
}
process.exit(0);
