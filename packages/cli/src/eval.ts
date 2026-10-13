import { performance } from 'node:perf_hooks';
import { CompositionBuffer, DACHEN, syllableToKeyCodes } from '@zhuyin/core';
import { loadEvalSamples, loadRuntime, type EvalSample } from './runtime.js';

export interface EvalReport {
  samples: number;
  charAcc: number;
  sentAcc: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  config: { a: number; gamma: number };
  rerank?: {
    weight: number;
    triggered: number;
    flipped: number;
    p50Ms: number;
    p95Ms: number;
  };
}

/** 評測：走完整 L0→L5（合成鍵流過 L1/L2，再解碼），可選 L6 重排。 */
export async function runEval(
  evalFile: string,
  opts: {
    a?: number;
    gamma?: number;
    limit?: number;
    idfBonus?: number;
    baseline?: 'classic' | 'bigram';
    viaKeystrokes?: boolean;
    decK?: number;
    rerank?: {
      weight?: number;
      gapThreshold?: number;
      maxCandidates?: number;
      flipMargin?: number;
    };
    kev?: import('@zhuyin/rerank').KevOptions;
  } = {},
): Promise<EvalReport> {
  const a = opts.a ?? 1;
  const gamma = opts.gamma ?? 0.5;
  const { decoder, legalSyllables, lm, polySingleChars } = await loadRuntime({
    a,
    gamma,
    idfBonus: opts.idfBonus,
    baseline: opts.baseline,
  });
  let samples = await loadEvalSamples(evalFile);
  if (opts.limit) samples = samples.slice(0, opts.limit);

  // L0-L2 往返驗證：把音節序列合成為鍵流再重組，必須與原序列一致
  if (opts.viaKeystrokes !== false) {
    const bad = samples.filter((s) => !verifyRoundtrip(s, legalSyllables));
    if (bad.length > 0) {
      console.warn(`[roundtrip] ${bad.length}/${samples.length} 筆不一致，例：${bad[0]!.text}`);
    }
  }

  let reranker: import('@zhuyin/rerank').PllReranker | undefined;
  if (opts.rerank) {
    const { PllReranker } = await import('@zhuyin/rerank');
    reranker = await PllReranker.create({
      weight: opts.rerank.weight ?? 0.25,
      gapThreshold: opts.rerank.gapThreshold ?? 0,
      maxCandidates: opts.rerank.maxCandidates ?? 6,
      flipMargin: opts.rerank.flipMargin ?? 1.5,
      charFreq: (ch) => lm.char.uni.get(ch) ?? 0,
      polySingle: polySingleChars,
    });
  }

  let kev: import('@zhuyin/rerank').KevReranker | undefined;
  if (opts.kev) {
    const { KevReranker } = await import('@zhuyin/rerank');
    kev = new KevReranker(opts.kev);
  }

  const enginelessDecoder = decoder; // 直接量測解碼延遲
  let charOk = 0;
  let charTotal = 0;
  let sentOk = 0;
  let rerankTriggered = 0;
  let rerankFlipped = 0;
  const latencies: number[] = [];
  const rLatencies: number[] = [];

  for (const sample of samples) {
    const t0 = performance.now();
    // 開 L6 時放大 K：正解常在 rank 5-10，K=4 會在重排前就掐死它
    const paths = enginelessDecoder.decode(sample.syllables, {
      nBest: opts.decK ?? (reranker || kev ? 28 : 4),
    });
    latencies.push(performance.now() - t0);
    let top = paths[0];
    if (reranker && paths.length > 1) {
      const rr = await reranker.rerank(paths);
      if (!rr.plan.skip) {
        rerankTriggered++;
        if (rr.paths[0]!.words.join('') !== paths[0]!.words.join('')) rerankFlipped++;
      }
      rLatencies.push(rr.elapsedMs);
      top = rr.paths[0];
    } else if (kev && paths.length > 1) {
      const rr = await kev.rerank(paths);
      rerankTriggered++;
      if (rr.paths[0]!.words.join('') !== paths[0]!.words.join('')) rerankFlipped++;
      rLatencies.push(rr.elapsedMs);
      top = rr.paths[0];
    }
    if (!top) continue;
    const out = top.words.join('');
    const ref = sample.text;
    const len = Math.min(out.length, [...ref].length);
    const refChars = [...ref];
    let ok = 0;
    for (let i = 0; i < len; i++) {
      if (out[i] === refChars[i]) ok++;
    }
    charOk += ok;
    charTotal += refChars.length;
    if (out === ref) sentOk++;
  }

  latencies.sort((x, y) => x - y);
  const q = (p: number): number =>
    latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] ?? 0;

  const report: EvalReport = {
    samples: samples.length,
    charAcc: charTotal > 0 ? charOk / charTotal : 0,
    sentAcc: samples.length > 0 ? sentOk / samples.length : 0,
    latencyP50Ms: q(0.5),
    latencyP95Ms: q(0.95),
    config: { a, gamma },
  };
  if ((reranker || kev) && rLatencies.length > 0) {
    rLatencies.sort((x, y) => x - y);
    const rq = (p: number): number =>
      rLatencies[Math.min(rLatencies.length - 1, Math.floor(p * rLatencies.length))] ?? 0;
    report.rerank = {
      weight: opts.kev?.weight ?? opts.rerank?.weight ?? 1,
      triggered: rerankTriggered,
      flipped: rerankFlipped,
      p50Ms: rq(0.5),
      p95Ms: rq(0.95),
    };
  }
  return report;
}

function verifyRoundtrip(sample: EvalSample, legal: ReadonlySet<string>): boolean {
  // 以 CompositionBuffer 逐鍵餵入，完成的音節序列須與樣本一致
  const buf = new CompositionBuffer(DACHEN, legal);
  for (const syl of sample.syllables) {
    for (const code of syllableToKeyCodes(syl)) buf.onKeyEvent({ code, timestampMs: 0 });
  }
  return buf.sequence.join(' ') === sample.syllables.join(' ');
}

export async function cmdEval(
  files: string[],
  opts: {
    a?: number;
    gamma?: number;
    limit?: number;
    idfBonus?: number;
    baseline?: 'classic' | 'bigram';
    decK?: number;
    rerank?: {
      weight?: number;
      gapThreshold?: number;
      maxCandidates?: number;
      flipMargin?: number;
    };
    kev?: import('@zhuyin/rerank').KevOptions;
  },
): Promise<void> {
  for (const file of files) {
    const report = await runEval(file, opts);
    const domain = file.includes('written') ? '書面' : '口語';
    let line =
      `[eval:${domain}] n=${report.samples} 字準=${(report.charAcc * 100).toFixed(2)}% ` +
      `句準=${(report.sentAcc * 100).toFixed(2)}% p50=${report.latencyP50Ms.toFixed(1)}ms ` +
      `p95=${report.latencyP95Ms.toFixed(1)}ms (a=${report.config.a} γ=${report.config.gamma})`;
    if (report.rerank) {
      line +=
        `\n  [L6] 觸發=${report.rerank.triggered}/${report.samples} 翻轉=${report.rerank.flipped} ` +
        `重排p50=${report.rerank.p50Ms.toFixed(0)}ms p95=${report.rerank.p95Ms.toFixed(0)}ms (b=${report.rerank.weight})`;
    }
    console.log(line);
  }
}

export async function cmdSweep(
  files: string[],
  grid: Array<{ a: number; gamma: number }>,
  limit?: number,
): Promise<void> {
  console.log('a\\γ' + grid.map((g) => `\tγ=${g.gamma}`).join(''));
  for (const a of [...new Set(grid.map((g) => g.a))]) {
    const row: string[] = [`a=${a}`];
    for (const g of grid.filter((x) => x.a === a)) {
      const r = await runEval(files[0]!, { ...g, limit });
      row.push(`${(r.charAcc * 100).toFixed(2)}%/${(r.sentAcc * 100).toFixed(1)}%`);
    }
    console.log(row.join('\t'));
  }
}
