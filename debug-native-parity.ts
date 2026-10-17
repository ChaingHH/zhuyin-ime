// Rust 引擎（native/）與 TS 的對拍：同樣輸入、輸出格式與 native/src/main.rs 相同，兩邊的檔案應完全相同。
// 資料目錄：ZHUYIN_DATA（同 Rust）；ZHUYIN_A＝詞級權重（預設 1）。
//   npx tsx debug-native-parity.ts keys <out>                    L1/L2：評測句按鍵 → 音節序列
//   npx tsx debug-native-parity.ts dump <out> [nBest] [l3]       L4/L5（＋L3）N-best
//   npx tsx debug-native-parity.ts l3 <noisy.txt> <out> <s>      L3：同 debug-l3.ts 的乾淨＋有錯輸入，印句準
//   npx tsx debug-native-parity.ts events <out> [句數]           產生重播事件（選字、游標、標點、Esc…）
//   npx tsx debug-native-parity.ts replay <events> <out> [adapter-out]
//                                    引擎重播（ZHUYIN_CLOCK 固定時鐘、ZHUYIN_ADAPTER 起始使用者資料、ZHUYIN_L3）
import { readFileSync, writeFileSync } from 'node:fs';
import {
  Channel,
  CompositionBuffer,
  DACHEN,
  Decoder,
  LexiconIndex,
  UserAdapter,
  syllableToKeyCodes,
  type UserAdapterData,
} from '@zhuyin/core';
import { BackoffLM } from '@zhuyin/lm';
import { ImeEngine } from './packages/cli/src/engine.js';
import { injectNoise, rng } from './packages/cli/src/noise.js';
import { loadEvalSamples } from './packages/cli/src/runtime.js';

const DATA = process.env['ZHUYIN_DATA'] ?? 'data';
const [mode, ...args] = process.argv.slice(2);
const legal = new Set(
  (JSON.parse(readFileSync(`${DATA}/processed/syllables.json`, 'utf8')) as { syllables: string[] })
    .syllables,
);
const samples = [
  ...(await loadEvalSamples('eval/colloquial.jsonl')),
  ...(await loadEvalSamples('eval/written.jsonl')),
];

async function makeDecoder(): Promise<Decoder> {
  const lm = await BackoffLM.load(`${DATA}/models/lm.bo.bin`);
  const d = new Decoder(lm, { a: Number(process.env['ZHUYIN_A'] ?? 1), gamma: 0.5 });
  d.useLexicon(LexiconIndex.fromBytes(readFileSync(`${DATA}/processed/lexicon.bin`)));
  return d;
}

/** debug-l3.ts 的代價：初始值 × s */
const scaled = (s: number): Channel =>
  new Channel(legal, {
    sub: 6 * s,
    extra: 7 * s,
    miss: 8 * s,
    toneAdj: 5 * s,
    tone: 7 * s,
    fuzzy: 5 * s,
  });

if (mode === 'keys') {
  const out = samples.map((s) => {
    const buf = new CompositionBuffer(DACHEN, legal);
    for (const code of s.syllables.flatMap((x) => syllableToKeyCodes(x)))
      buf.onKeyEvent({ code, timestampMs: 0 });
    return buf.sequence.join(' ');
  });
  writeFileSync(args[0]!, out.join('\n'));
} else if (mode === 'dump') {
  const dec = await makeDecoder();
  const nBest = Number(args[1] ?? 4);
  const ch = args[2] === 'l3' ? new Channel(legal) : undefined;
  const out: string[] = [];
  for (const s of samples)
    for (const p of dec.decode(s.syllables, {
      nBest,
      alternatives: ch ? s.syllables.map((x) => ch.expand(x)) : undefined,
    })) {
      let l = `${p.words.join('|')}\t${p.score}`;
      if (ch) l += `\t${p.breakdown.map((b) => b.reading.join(' ')).join('|')}`;
      out.push(l);
    }
  writeFileSync(args[0]!, out.join('\n'));
} else if (mode === 'l3') {
  // 前一半乾淨、後一半有錯（同 debug-l3.ts：key=cog=0.03、每句種子 1000+i，各檔分開編號）
  const files = ['colloquial', 'written'];
  const sets = await Promise.all(files.map((f) => loadEvalSamples(`eval/${f}.jsonl`)));
  const noisy = sets.map((ss) =>
    ss.map((s, i) =>
      injectNoise(s.syllables, legal, { key: 0.03, cognitive: 0.03 }, rng(1000 + i)),
    ),
  );
  const inputs = [...sets.map((ss) => ss.map((s) => s.syllables)), ...noisy].flat();
  writeFileSync(args[0]!, inputs.map((x) => x.join(' ')).join('\n'));
  const dec = await makeDecoder();
  const ch = scaled(Number(args[2]));
  const out = inputs.map((obs) => {
    const p = dec.decode(obs, { alternatives: obs.map((x) => ch.expand(x)) })[0];
    return p ? `${p.words.join('|')}\t${p.score}` : '';
  });
  writeFileSync(args[1]!, out.join('\n'));
  // 句準（dev＝偶數句、test＝奇數句），排法同 debug-l3.ts
  let k = 0;
  const row: string[] = [];
  for (const input of ['乾淨', '有錯'])
    sets.forEach((ss, si) => {
      const ok = [0, 0];
      ss.forEach((s, i) => {
        if (out[k++]!.split('\t')[0]!.split('|').join('') === s.text) ok[i % 2]!++;
      });
      const pct = (j: number): string =>
        ((ok[j]! / Math.ceil((ss.length - j) / 2)) * 100).toFixed(1);
      row.push(`${input}${si === 0 ? '口語' : '書面'} ${pct(0)}/${pct(1)}`);
    });
  console.log(`L3 s=${args[2]} | ${row.join(' | ')}`);
} else if (mode === 'events') {
  const n = Number(args[1] ?? samples.length);
  const ev: string[] = [];
  samples.slice(0, n).forEach((s, si) => {
    const r = rng(si + 1);
    const key = (code: string, k = ''): number => ev.push(`k\t${code}\t${k}`);
    const typeSyl = (syl: string): void => {
      for (const c of syllableToKeyCodes(syl)) key(c);
    };
    s.syllables.forEach((syl, j) => {
      if (j > 0 && r() < 0.04) key('Space'); // 組字中的空格（原樣 token）
      if (j > 0 && r() < 0.03) key('Comma', '<'); // 全形標點
      const left = j > 1 && r() < 0.05 ? 1 + Math.floor(r() * 2) : 0;
      for (let i = 0; i < left; i++) key('ArrowLeft'); // 回頭在中間插音節
      if (r() < 0.04) {
        // 打到一半退格重打
        key(syllableToKeyCodes(syl)[0]!);
        key('Backspace');
      }
      typeSyl(syl);
      if (r() < 0.04) {
        key('Backspace'); // 刪掉剛打的音節再重打
        typeSyl(syl);
      }
      if (left > 0 && r() < 0.6) key('End');
      if (r() < 0.06) {
        // 選字視窗
        if (r() < 0.3) key('ArrowLeft');
        key('ArrowDown');
        const x = r();
        if (x < 0.3) key(`Digit${1 + Math.floor(r() * 3)}`);
        else if (x < 0.45) {
          key('Space');
          key('Digit2');
        } else if (x < 0.6) {
          // 反白往下（可能跨頁）、往上，再選反白
          for (let d = Math.floor(r() * 12); d > 0; d--) key('ArrowDown');
          if (r() < 0.5) key('ArrowUp');
          key('Enter');
        } else if (x < 0.7) {
          key('ArrowUp'); // 從第一個往上＝循環到最後一個
          key('PageUp');
          key('Enter');
        } else if (x < 0.85) key('Enter');
        else key('Escape');
        key('End');
      }
      if (j > 0 && r() < 0.02) {
        key('ArrowLeft');
        key('Delete');
        key('End');
      }
    });
    if (r() < 0.02) {
      ev.push('m'); // 英文模式打一個字再切回來
      key('KeyA', 'a');
      ev.push('m');
    } else if (r() < 0.03) key('Escape');
    else ev.push(`c\t${r() < 0.15 ? 1 : 0}`);
  });
  writeFileSync(args[0]!, ev.join('\n'));
} else if (mode === 'replay') {
  const clock = process.env['ZHUYIN_CLOCK'];
  if (clock) Date.now = () => Number(clock);
  const dec = await makeDecoder();
  const af = process.env['ZHUYIN_ADAPTER'];
  const adapter = af
    ? UserAdapter.fromJSON(JSON.parse(readFileSync(af, 'utf8')) as UserAdapterData)
    : new UserAdapter();
  for (const e of adapter.drainPendingEntries()) dec.addEntry(e);
  const eng = new ImeEngine(dec, legal, undefined, adapter);
  if (process.env['ZHUYIN_L3']) eng.channel = new Channel(legal);
  const out: string[] = [];
  for (const line of readFileSync(args[0]!, 'utf8').split('\n').filter(Boolean)) {
    const f = line.split('\t');
    if (f[0] === 'k') {
      const st = eng.onKey({ code: f[1]!, key: f[2] || undefined, timestampMs: 0 });
      const m = st.menu
        ? `${st.menu.items.join('|')}@${st.menu.page}/${st.menu.pages}#${st.menu.cursor}`
        : '';
      out.push(
        `${st.composition}\t${st.lastLegal}\t${st.cursor}\t${st.pending ?? ''}\t${m}\t${st.text ?? ''}`,
      );
    } else if (f[0] === 'c') out.push(`C\t${eng.commit(Number(f[1]))}`);
    else if (f[0] === 'm') out.push(`M\t${eng.toggleMode()}`);
    else throw new Error(`事件格式錯誤：${line}`);
  }
  writeFileSync(args[1]!, out.join('\n'));
  if (args[2]) writeFileSync(args[2], JSON.stringify(adapter.toJSON()));
} else {
  console.error('用法見檔頭');
  process.exit(2);
}
