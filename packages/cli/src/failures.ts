import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvalSamples, loadRuntime } from './runtime.js';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(thisDir, '..', '..', '..');

interface FailureCase {
  text: string;
  out: string;
  /** 差異位置標記：^ 指向錯字 */
  diff: string;
  wrongChars: string[];
  syllables: string[];
}

function diffMark(ref: string[], out: string[]): string {
  let m = '';
  for (let i = 0; i < ref.length; i++) {
    m += ref[i] === out[i] ? '　' : '^';
  }
  return m;
}

async function showFailures(
  file: string,
  limit: number,
  rerank?: { weight?: number },
): Promise<void> {
  const { decoder } = await loadRuntime();
  let rr: import('@zhuyin/rerank').PllReranker | undefined;
  if (rerank) {
    const { PllReranker } = await import('@zhuyin/rerank');
    rr = await PllReranker.create({ weight: rerank.weight ?? 1 });
  }
  const samples = await loadEvalSamples(file);
  const domain = file.includes('written') ? '書面' : '口語';

  const failures: FailureCase[] = [];
  for (const s of samples) {
    let paths = decoder.decode(s.syllables, rr ? { nBest: 12 } : undefined);
    if (rr && paths.length > 1) paths = (await rr.rerank(paths)).paths;
    const out = paths[0]?.words.join('') ?? '';
    if (out === s.text) continue;
    const ref = [...s.text];
    const outs = [...out];
    const wrong: string[] = [];
    for (let i = 0; i < Math.min(ref.length, outs.length); i++) {
      if (ref[i] !== outs[i]) wrong.push(`${ref[i]}→${outs[i]}`);
    }
    if (outs.length !== ref.length) wrong.push(`[長度 ${ref.length}≠${outs.length}]`);
    failures.push({
      text: s.text,
      out,
      diff: diffMark(ref, outs),
      wrongChars: wrong,
      syllables: s.syllables,
    });
  }

  console.log(
    `\n=== ${domain} 失敗案例：${failures.length}/${samples.length} 句 ` +
      `(${((1 - failures.length / samples.length) * 100).toFixed(1)}% 句準) ===`,
  );

  // 錯字數由多到少取前 limit 個
  failures.sort(
    (a, b) =>
      b.wrongChars.filter((w) => !w.startsWith('[')).length -
      a.wrongChars.filter((w) => !w.startsWith('[')).length,
  );
  for (const f of failures.slice(0, limit)) {
    console.log(`\n正確：${f.text}\n解碼：${f.out}\n位置：${f.diff}`);
    console.log(`錯字：${f.wrongChars.join('　')}`);
  }

  // 錯字型態統計
  const stat = new Map<string, number>();
  for (const f of failures) {
    for (const w of f.wrongChars) {
      if (w.startsWith('[')) continue;
      stat.set(w, (stat.get(w) ?? 0) + 1);
    }
  }
  const top = [...stat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(`\n--- ${domain} 高頻錯字對（前 15）---`);
  for (const [pair, n] of top) console.log(`${pair} ×${n}`);
}

async function main(): Promise<void> {
  const which = process.argv[3] ?? 'both';
  const limit = Number.parseInt(process.argv[4] ?? '10', 10);
  const rerank = process.argv.includes('--rerank') ? { weight: argB() } : undefined;
  if (which === 'colloquial' || which === 'both') {
    await showFailures(path.join(REPO, 'eval', 'colloquial.jsonl'), limit, rerank);
  }
  if (which === 'written' || which === 'both') {
    await showFailures(path.join(REPO, 'eval', 'written.jsonl'), limit, rerank);
  }
}

function argB(): number {
  const i = process.argv.indexOf('-b');
  const v = i >= 0 ? Number.parseFloat(process.argv[i + 1] ?? '') : NaN;
  return Number.isNaN(v) ? 0.25 : v;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
