import { performance } from 'node:perf_hooks';
import { CompositionBuffer, DACHEN, isLiteralToken, syllableToKeyCodes } from '@zhuyin/core';
import { loadEvalSamples, loadRuntime, type EvalSample, type LoadedRuntime } from './runtime.js';

export interface EvalReport {
  samples: number;
  charAcc: number;
  sentAcc: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  config: { a: number; gamma: number };
}

/** 評測：走完整 L0→L5（合成鍵流過 L1/L2，再解碼）， */
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
  } = {},
  /** 已載入的 runtime（多檔、sweep 共用一份）；a、γ 會改寫到它的解碼器設定上 */
  rt?: LoadedRuntime,
): Promise<EvalReport> {
  const a = opts.a ?? 1;
  const gamma = opts.gamma ?? 0.5;
  // 一律不載入使用者學習資料，評測數字才不受 adapter.json 影響
  const { decoder, legalSyllables } =
    rt ??
    (await loadRuntime({
      a,
      gamma,
      idfBonus: opts.idfBonus,
      baseline: opts.baseline,
      noUser: true,
    }));
  decoder.config.a = a;
  decoder.config.gamma = gamma;
  let samples = await loadEvalSamples(evalFile);
  if (opts.limit) samples = samples.slice(0, opts.limit);

  // L0-L2 往返驗證：把音節序列合成為鍵流再重組，必須與原序列一致
  if (opts.viaKeystrokes !== false) {
    const bad = samples.filter((s) => !verifyRoundtrip(s, legalSyllables));
    if (bad.length > 0) {
      console.warn(`[roundtrip] ${bad.length}/${samples.length} 筆不一致，例：${bad[0]!.text}`);
    }
  }

  const enginelessDecoder = decoder; // 直接量測解碼延遲
  let charOk = 0;
  let charTotal = 0;
  let sentOk = 0;
  const latencies: number[] = [];

  for (const sample of samples) {
    const t0 = performance.now();
    const paths = enginelessDecoder.decode(sample.syllables, {
      nBest: opts.decK ?? 4,
    });
    latencies.push(performance.now() - t0);
    // 沒有結果也要計入分母；逐字比較用 code point，非 BMP 字才對得上
    const out = paths[0]?.words.join('') ?? '';
    const ref = sample.text;
    const outChars = [...out];
    const refChars = [...ref];
    const len = Math.min(outChars.length, refChars.length);
    let ok = 0;
    for (let i = 0; i < len; i++) {
      if (outChars[i] === refChars[i]) ok++;
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
  return report;
}

function verifyRoundtrip(sample: EvalSample, legal: ReadonlySet<string>): boolean {
  // 以 CompositionBuffer 逐鍵餵入，完成的音節序列須與樣本一致
  // 原樣 token（中英評測集的英文）不走鍵盤，跳過
  const syls = sample.syllables.filter((s) => !isLiteralToken(s));
  const buf = new CompositionBuffer(DACHEN, legal);
  for (const syl of syls) {
    for (const code of syllableToKeyCodes(syl)) buf.onKeyEvent({ code, timestampMs: 0 });
  }
  return buf.sequence.join(' ') === syls.join(' ');
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
  },
): Promise<void> {
  const rt = await loadRuntime({
    idfBonus: opts.idfBonus,
    baseline: opts.baseline,
    noUser: true,
  });
  for (const file of files) {
    const report = await runEval(file, opts, rt);
    const domain = file.includes('written') ? '書面' : file.includes('mixed') ? '中英' : '口語';
    const line =
      `[eval:${domain}] n=${report.samples} 字準=${(report.charAcc * 100).toFixed(2)}% ` +
      `句準=${(report.sentAcc * 100).toFixed(2)}% p50=${report.latencyP50Ms.toFixed(1)}ms ` +
      `p95=${report.latencyP95Ms.toFixed(1)}ms (a=${report.config.a} γ=${report.config.gamma})`;
    console.log(line);
  }
}

export async function cmdSweep(
  files: string[],
  grid: Array<{ a: number; gamma: number }>,
  limit?: number,
): Promise<void> {
  console.log('a\\γ' + grid.map((g) => `\tγ=${g.gamma}`).join(''));
  const rt = await loadRuntime({ noUser: true });
  for (const a of [...new Set(grid.map((g) => g.a))]) {
    const row: string[] = [`a=${a}`];
    for (const g of grid.filter((x) => x.a === a)) {
      const r = await runEval(files[0]!, { ...g, limit }, rt);
      row.push(`${(r.charAcc * 100).toFixed(2)}%/${(r.sentAcc * 100).toFixed(1)}%`);
    }
    console.log(row.join('\t'));
  }
}
