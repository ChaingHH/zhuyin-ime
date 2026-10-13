// 準確率實驗台：載入一次 runtime，跑多組設定。dev = 偶數句、test = 奇數句。
// npx tsx debug-acc.ts [--fail N]
import { writeFileSync } from 'node:fs';
import { loadRuntime, loadEvalSamples, type EvalSample } from './packages/cli/src/runtime.js';

const rt = await loadRuntime({ a: 1, gamma: 0.5 });
const sets: Record<string, EvalSample[]> = {
  口語: await loadEvalSamples('eval/colloquial.jsonl'),
  書面: await loadEvalSamples('eval/written.jsonl'),
};

export function run(label: string, nBest = 4): void {
  const row: string[] = [label.padEnd(28)];
  const fails: string[] = [];
  for (const [name, ss] of Object.entries(sets)) {
    const ok = [0, 0];
    let oracle = 0;
    ss.forEach((s, i) => {
      const paths = rt.decoder.decode(s.syllables, { nBest });
      const out = paths[0]?.words.join('') ?? '';
      if (out === s.text) ok[i % 2]!++;
      else fails.push(`${name}\t${s.text}\n\t${out}`);
      if (paths.some((p) => p.words.join('') === s.text)) oracle++;
    });
    const half = (k: number): string =>
      ((ok[k]! / Math.ceil((ss.length - k) / 2)) * 100).toFixed(1);
    row.push(
      `${name} dev ${half(0)} test ${half(1)} all ${(((ok[0]! + ok[1]!) / ss.length) * 100).toFixed(1)} orc ${((oracle / ss.length) * 100).toFixed(0)}`,
    );
  }
  console.log(row.join(' | '));
  writeFileSync(`data/fails-${label.replace(/\W+/g, '_')}.txt`, fails.join('\n'));
}

const cfg = rt.decoder.config as { a: number; gamma: number; beamWidth: number };
const mode = process.argv[2] ?? 'base';
if (mode === 'base') run('base');
if (mode === 'grid') {
  for (const a of [0.8, 1, 1.2])
    for (const g of [0.3, 0.5, 0.8, 1.2]) {
      cfg.a = a;
      cfg.gamma = g;
      run(`a=${a} g=${g}`);
    }
}
if (mode === 'kn') {
  rt.lm.smoothing = 'kn';
  for (const d of [0.6, 0.75, 0.9]) {
    rt.lm.discount = d;
    for (const [a, g] of [
      [1, 0.5],
      [1, 1],
      [1, 0.3],
    ] as const) {
      cfg.a = a;
      cfg.gamma = g;
      run(`kn D=${d} a=${a} g=${g}`);
    }
  }
}
if (mode === 'tune') {
  rt.lm.smoothing = 'kn';
  rt.lm.discount = Number(process.env['D'] ?? 0.75);
  const c = cfg as unknown as Record<string, number>;
  const dec = rt.decoder as unknown as Record<string, number>;
  run('kn ref');
  for (const p of [0, 1, 4]) {
    c['polyPenalty'] = p;
    run(`poly=${p}`);
  }
  c['polyPenalty'] = 2.5;
  for (const e of [24, 96, 200]) {
    dec['entryCap'] = e;
    run(`entryCap=${e}`);
  }
  dec['entryCap'] = 48;
  for (const b of [100, 400]) {
    c['beamWidth'] = b;
    run(`beam=${b}`);
  }
  c['beamWidth'] = 200;
  run('nBest=8', 8);
}
if (mode === 'kn1') {
  rt.lm.smoothing = 'kn';
  rt.lm.discount = 0.75;
  for (const g of (process.env['G'] ?? '0.5').split(',').map(Number)) {
    cfg.gamma = g;
    run(`${process.env['ZHUYIN_LM']?.split('/').pop()} kn g=${g}`);
  }
}
if (mode === 'rr') {
  // PLL 每句只算一次，離線掃 b 與 LM 信心門檻
  rt.lm.smoothing = 'kn';
  rt.lm.discount = 0.75;
  cfg.gamma = Number(process.env['G'] ?? 0.3);
  const { PllReranker } = await import('./packages/rerank/src/reranker.js');
  const rr = await PllReranker.create({
    weight: 1,
    maxCandidates: Number(process.env['MAXC'] ?? 8),
    gapThreshold: 0,
    flipMargin: 0,
  });
  type Item = { ref: string; texts: string[]; lm: number[]; pll: Map<number, number>; set: string; i: number };
  const items: Item[] = [];
  for (const [name, ss] of Object.entries(sets)) {
    for (const [i, s] of ss.entries()) {
      const paths = rt.decoder.decode(s.syllables, { nBest: 28 });
      const r = paths.length > 1 ? await rr.rerank(paths) : null;
      const pll = new Map<number, number>();
      r?.plan.candidateIdx.forEach((ci, k) => pll.set(ci, r.pll[k] ?? 0));
      items.push({ ref: s.text, texts: paths.map((p) => p.words.join('')), lm: paths.map((p) => p.score), pll, set: name, i });
    }
  }
  writeFileSync(`data/rr-cache-${process.env['MAXC'] ?? 8}.json`, JSON.stringify(items.map((x) => ({ ...x, pll: [...x.pll] }))));
  for (const gap of [Infinity, 2, 4, 8])
    for (const b of [0, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2]) {
      const row: string[] = [`gap=${gap} b=${b}`.padEnd(20)];
      for (const name of Object.keys(sets)) {
        const ok = [0, 0];
        const its = items.filter((x) => x.set === name);
        for (const x of its) {
          let best = 0;
          if (x.pll.size > 0 && x.lm.length > 1 && x.lm[0]! - x.lm[1]! <= gap) {
            let bs = -Infinity;
            for (const [ci, p] of x.pll) {
              const sc = x.lm[ci]! + b * p;
              if (sc > bs) [bs, best] = [sc, ci];
            }
          }
          if (x.texts[best] === x.ref) ok[x.i % 2]!++;
        }
        const n = its.length;
        row.push(`${name} dev ${((ok[0]! / Math.ceil(n / 2)) * 100).toFixed(1)} test ${((ok[1]! / Math.floor(n / 2)) * 100).toFixed(1)} all ${(((ok[0]! + ok[1]!) / n) * 100).toFixed(1)}`);
      }
      console.log(row.join(' | '));
    }
}
if (mode === 'tune2') {
  cfg.gamma = 0.3;
  const c = cfg as unknown as Record<string, number>;
  for (const p of [1.5, 3.5]) {
    c['polyPenalty'] = p;
    run(`poly=${p}`);
  }
  c['polyPenalty'] = 2.5;
  for (const x of [0.05, 0.15]) {
    c['idfBonus'] = x;
    run(`idf=${x}`);
  }
}
if (mode === 'dect') {
  // 解碼延遲 vs K（不跑 BERT）
  const { performance } = await import('node:perf_hooks');
  const ss = [...sets['口語']!.slice(0, 200), ...sets['書面']!.slice(0, 100)];
  for (const k of [4, 8, 12, 16, 28]) {
    const t: number[] = [];
    for (const s of ss) {
      const t0 = performance.now();
      rt.decoder.decode(s.syllables, { nBest: k });
      t.push(performance.now() - t0);
    }
    t.sort((x, y) => x - y);
    console.log(`K=${k} p50=${t[150]!.toFixed(1)}ms p95=${t[285]!.toFixed(1)}ms`);
  }
}
if (mode === 'rrgap') {
  // 每句記錄 L5 分差、重排耗時、L5/L6 是否正確 → 模擬「分差 > T 跳過重排」
  const { PllReranker } = await import('./packages/rerank/src/reranker.js');
  const rr = await PllReranker.create({
    weight: 0.5,
    maxCandidates: 16,
    flipMargin: 0.75,
    charFreq: (ch) => rt.lm.char.uni.get(ch) ?? 0,
  });
  const rows: Array<{ set: string; i: number; gap: number; ms: number; l5: boolean; l6: boolean }> = [];
  for (const [name, ss] of Object.entries(sets)) {
    for (const [i, s] of ss.entries()) {
      const paths = rt.decoder.decode(s.syllables, { nBest: 28 });
      const l5 = paths[0]?.words.join('') === s.text;
      if (paths.length < 2) {
        rows.push({ set: name, i, gap: Infinity, ms: 0, l5, l6: l5 });
        continue;
      }
      const r = await rr.rerank(paths);
      rows.push({ set: name, i, gap: paths[0]!.score - paths[1]!.score, ms: r.elapsedMs, l5, l6: r.paths[0]?.words.join('') === s.text });
    }
  }
  writeFileSync('data/rrgap.json', JSON.stringify(rows));
  for (const T of [Infinity, 12, 8, 6, 4, 3, 2, 1]) {
    const out: string[] = [`T=${T}`.padEnd(8)];
    for (const name of Object.keys(sets)) {
      const rs = rows.filter((r) => r.set === name);
      const ok = [0, 0];
      const ms: number[] = [];
      for (const r of rs) {
        const run = r.gap <= T;
        if (run ? r.l6 : r.l5) ok[r.i % 2]!++;
        ms.push(run ? r.ms : 0);
      }
      ms.sort((x, y) => x - y);
      const n = rs.length;
      out.push(`${name} dev ${((ok[0]! / Math.ceil(n / 2)) * 100).toFixed(1)} test ${((ok[1]! / Math.floor(n / 2)) * 100).toFixed(1)} 跑 ${((rs.filter((r) => r.gap <= T).length / n) * 100).toFixed(0)}% p50 ${ms[n >> 1]!.toFixed(0)} p95 ${ms[Math.floor(n * 0.95)]!.toFixed(0)}ms`);
    }
    console.log(out.join(' | '));
  }
}
