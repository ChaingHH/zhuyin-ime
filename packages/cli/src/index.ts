import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Channel } from '@zhuyin/core';
import { ImeEngine } from './engine.js';
import { loadRuntime, saveAdapter } from './runtime.js';
import { cmdEval, cmdSweep } from './eval.js';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(thisDir, '..', '..', '..');

function argNum(names: string[], def?: number): number | undefined {
  for (let i = 0; i < process.argv.length; i++) {
    if (names.includes(process.argv[i]!)) {
      const v = Number.parseFloat(process.argv[i + 1] ?? '');
      return Number.isNaN(v) ? def : v;
    }
  }
  return def;
}

// 美式鍵盤、未按 Shift 時鍵碼產生的字元（行模式沒有 KeyboardEvent.key，英文模式要用）
const PUNCT: Record<string, string> = {
  Space: ' ',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Backquote: '`',
};
function keyOfCode(code: string): string | undefined {
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(code);
  if (m) return (m[1] ?? m[2])!.toLowerCase();
  return PUNCT[code];
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  switch (cmd) {
    case 'type': {
      const { decoder, legalSyllables, adapter, lm } = await loadRuntime();
      let committed = '';
      // --rerank：先顯示 L5，BERT 重排完成且首選改變時再印出替換結果（L7）
      let hooks: import('./engine.js').RerankHooks | undefined;
      if (process.argv.includes('--rerank')) {
        const { RerankWorker } = await import('@zhuyin/rerank');
        // BERT 放背景執行緒：在主執行緒跑會卡住事件迴圈，重排期間的按鍵要排隊
        const rr = await RerankWorker.create({
          weight: 0.5,
          maxCandidates: 16,
          gapThreshold: 6,
          flipMargin: 0.75,
          charCounts: Object.fromEntries(lm.char.uni),
        });
        hooks = {
          rerank: (paths) => rr.rerank(paths),
          onUpdate: (st) => console.log(`  ${'[L6]'.padEnd(10)} => ${committed}${st.composition}`),
        };
      }
      const engine = new ImeEngine(decoder, legalSyllables, undefined, adapter, hooks);
      // L3 打錯／模糊音容錯：預設開，--no-l3 關閉
      if (!process.argv.includes('--no-l3')) engine.channel = new Channel(legalSyllables);
      console.log(
        [
          '互動打字台（行模式）：',
          '  一行 = 空白分隔鍵碼（如 KeyR KeyU KeyP Space）',
          '  Enter=送出 top-1；#2=改選第 2 候選送出（納入學習）',
          '  ShiftLeft／ShiftRight＝單按 Shift，切換注音／英文（英文模式下鍵碼直接輸出字元）',
          '  :phrase 詞 音節…（手動造詞，如 :phrase 降息 ㄐㄧㄤˋ ㄒㄧ）',
          '  :adapt on|off（X2 開關）；:quit 離開',
        ].join('\n'),
      );
      const rl = createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (trimmed === ':quit') {
          rl.close();
          return;
        }
        if (trimmed.startsWith(':adapt')) {
          const v = trimmed.split(/\s+/)[1];
          adapter.setEnabled(v !== 'off');
          console.log(`  X2 適應：${adapter.enabled ? 'on' : 'off'}`);
          return;
        }
        if (trimmed.startsWith(':phrase')) {
          const parts = trimmed.split(/\s+/).slice(1);
          const word = parts[0] ?? '';
          const reading = parts.slice(1);
          if (word && reading.length > 0) {
            adapter.setUserPhrase(word, reading);
            decoder.addEntry({ word, readings: [reading], provenance: ['user'] });
            console.log(`  已造詞：${word} (${reading.join(' ')})`);
          } else {
            console.log('  用法：:phrase 詞 音節…');
          }
          return;
        }
        for (const token of trimmed.split(/\s+/).filter(Boolean)) {
          if (token === 'ShiftLeft' || token === 'ShiftRight') {
            // 行模式沒有「按住」，單獨一個 Shift 鍵碼就是單按
            committed += engine.toggleMode();
            console.log(`  切換為${engine.mode === 'english' ? '英文' : '注音'}：${committed}`);
          } else if (engine.mode === 'english' && token === 'Backspace') {
            committed = [...committed].slice(0, -1).join('');
            console.log(`  ${token.padEnd(10)} => ${committed}`);
          } else if (token === 'Enter') {
            committed += engine.commit();
            console.log(`  已送出：${committed}`);
          } else if (/^#\d+$/.test(token)) {
            const k = Number.parseInt(token.slice(1), 10) - 1;
            const cands = engine.getCandidates();
            if (k >= 0 && k < cands.length) {
              committed += engine.commit(k);
              saveAdapter(adapter).catch(() => {});
              console.log(`  已送出（第${k + 1}候選）：${committed}`);
            } else {
              console.log('  無該候選');
            }
          } else {
            const st = engine.onKey({
              code: token,
              key: keyOfCode(token),
              timestampMs: performance.now(),
            });
            if (st.text) committed += st.text;
            console.log(
              `  ${token.padEnd(10)} => ${committed}${st.composition}${st.lastLegal ? '' : ' [!]'}`,
            );
          }
        }
      });
      rl.on('close', () => {
        saveAdapter(adapter)
          .then(() => {
            console.log(`總計送出：${committed}（X2 狀態已存檔）`);
            process.exit(0);
          })
          .catch(() => process.exit(0));
      });
      break;
    }

    case 'replay': {
      const file = process.argv[3];
      if (!file) throw new Error('用法: zhuyin replay <keystrokes.jsonl>');
      const { decoder, legalSyllables } = await loadRuntime();
      const engine = new ImeEngine(decoder, legalSyllables);
      const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
      let t = 0;
      for (const line of lines) {
        const ev = JSON.parse(line) as {
          code: string;
          tMs?: number;
          expected?: string;
        };
        t = ev.tMs ?? t;
        const st = engine.onKey({ code: ev.code, timestampMs: ev.tMs ?? t++ });
        if (st.candidates.length > 0 || !st.lastLegal) {
          console.log(
            `${ev.code.padEnd(10)} => ${st.composition}${st.lastLegal ? '' : ' [不合法音節]'}`,
          );
        }
      }
      console.log(`最終送出：${engine.commit()}`);
      break;
    }

    case 'eval': {
      const limit = argNum(['-n'], undefined);
      const a = argNum(['-a']);
      const gamma = argNum(['-g']);
      const hasRerank = process.argv.includes('--rerank');
      const rerank = hasRerank
        ? {
            weight: argNum(['-b'], 0.5),
            gapThreshold: argNum(['--gap'], 6),
            maxCandidates: argNum(['--maxc'], 16),
            flipMargin: argNum(['--flip'], 0.75),
          }
        : undefined;
      await cmdEval(
        [path.join(REPO, 'eval', 'colloquial.jsonl'), path.join(REPO, 'eval', 'written.jsonl')],
        {
          a,
          gamma,
          limit,
          rerank,
          kev: process.argv.includes('--kev')
            ? {
                weight: argNum(['--kw'], 3),
                top: argNum(['--ktop'], 16),
                mode: process.argv.includes('--knoul') ? ('noul' as const) : ('choice' as const),
              }
            : undefined,
          idfBonus: argNum(['--idf'], 0),
          decK: argNum(['--deck'], 28),
          baseline: process.argv.includes('--baseline')
            ? (process.argv[process.argv.indexOf('--baseline') + 1] as 'classic' | 'bigram')
            : undefined,
        },
      );
      break;
    }

    case 'sweep': {
      const limit = argNum(['-n'], 300);
      const grid: Array<{ a: number; gamma: number }> = [];
      for (const a of [1.2, 1, 0.8]) {
        for (const g of [0, 0.3, 0.5, 0.8]) grid.push({ a, gamma: g });
      }
      await cmdSweep([path.join(REPO, 'eval', 'colloquial.jsonl')], grid, limit);
      break;
    }

    case 'web': {
      // 網頁測試台：--port N（預設 8787）、--l6 off|bert|kev（預設 bert；--no-rerank＝off）
      // 網頁上可再切換 L6
      const { startWeb } = await import('./web.js');
      const l6At = process.argv.indexOf('--l6');
      const l6 = (
        l6At >= 0 ? process.argv[l6At + 1] : process.argv.includes('--no-rerank') ? 'off' : 'bert'
      ) as import('./web.js').L6Mode;
      await startWeb(argNum(['--port'], 8787)!, l6, !process.argv.includes('--no-l3'));
      break;
    }

    default:
      console.log('用法: zhuyin <type|replay|eval|sweep|web> [args]');
      process.exitCode = cmd === undefined ? 0 : 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
