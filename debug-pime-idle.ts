// 量 Rust PIME 後端的「記憶體跟著使用走」（docs/MEMORY.md §6）：
// 開行程 → 第一個鍵才載入 → 打 N 句 → 閒置卸載 → 再按鍵重新載入 → 最後一個 client 停用即卸載。
// 每個階段量私有記憶體與工作集，以及載入那一鍵的延遲。
// ZHUYIN_DATA=<data> npx tsx debug-pime-idle.ts [句數=300] [cold]
// cold：先用 robocopy /J（不經檔案快取）把模型複製到暫存目錄再跑，近似冷快取的第一次載入。
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { syllableToKeyCodes } from '@zhuyin/core';
import { loadEvalSamples } from './packages/cli/src/runtime.js';

const n = Number(process.argv[2] ?? 300);
const cold = process.argv[3] === 'cold';
let data = process.env['ZHUYIN_DATA'] ?? 'data';
let tmp = '';
if (cold) {
  tmp = mkdtempSync(join(tmpdir(), 'zhuyin-cold-'));
  for (const [dir, file] of [
    ['models', 'lm.bo.bin'],
    ['processed', 'lexicon.bin'],
    ['processed', 'syllables.json'],
  ]) {
    // robocopy 成功的結束碼是 1，execSync 會當成錯誤
    try {
      execSync(`robocopy /J /NJH /NJS /NP "${join(data, dir!)}" "${join(tmp, dir!)}" ${file}`);
    } catch {
      /* 結束碼 1＝已複製 */
    }
  }
  data = tmp;
}

const IDLE = 2;
// 學習檔：送出後停手 1 秒才寫（ZHUYIN_SAVE_SECS），連續打字時不寫
const adapterFile = join(tmpdir(), `zhuyin-idle-adapter-${process.pid}.json`);
rmSync(adapterFile, { force: true });
const child = spawn('native/target/release/zhuyin-native.exe', ['pime'], {
  env: {
    ...process.env,
    ZHUYIN_DATA: data,
    ZHUYIN_ADAPTER: adapterFile,
    ZHUYIN_CONFIG: 'off',
    ZHUYIN_IDLE_SECS: String(IDLE),
    ZHUYIN_SAVE_SECS: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const log: string[] = [];
child.stderr.on('data', (d: Buffer) => log.push(d.toString().trim()));
const lines = createInterface({ input: child.stdout });
let waiting: ((r: Record<string, unknown>) => void) | null = null;
lines.on('line', (l) => {
  const w = waiting;
  waiting = null;
  w?.(JSON.parse(l.slice(l.indexOf('|', 9) + 1)) as Record<string, unknown>);
});
let seq = 0;
const call = (msg: Record<string, unknown>, client = 'a'): Promise<Record<string, unknown>> =>
  new Promise((res) => {
    waiting = res;
    child.stdin.write(`${client}|${JSON.stringify({ ...msg, seqNum: ++seq })}\n`);
  });

const keyOf = (code: string): [number, number] => {
  const m = /^(Digit|Key)(.)$/.exec(code);
  if (m) return [m[2]!.toUpperCase().charCodeAt(0), m[2]!.toLowerCase().charCodeAt(0)];
  const t: Record<string, [number, number]> = {
    Space: [0x20, 0x20],
    Minus: [0xbd, 0x2d],
    Semicolon: [0xba, 0x3b],
    Comma: [0xbc, 0x2c],
    Period: [0xbe, 0x2e],
    Slash: [0xbf, 0x2f],
    Enter: [0x0d, 0x0d],
  };
  return t[code]!;
};
const keyStates = new Array<number>(256).fill(0);
const key = async (code: string): Promise<number> => {
  const [keyCode, charCode] = keyOf(code);
  const ev = { charCode, keyCode, repeatCount: 1, scanCode: 0, isExtended: false, keyStates };
  const t = performance.now();
  const f = await call({ method: 'filterKeyDown', ...ev });
  if (f['return']) await call({ method: 'onKeyDown', ...ev });
  return performance.now() - t;
};
const mem = (): string => {
  const o = execSync(
    `powershell -NoProfile -Command "$p = Get-Process -Id ${child.pid}; '{0} {1}' -f $p.PrivateMemorySize64, $p.WorkingSet64"`,
  )
    .toString()
    .trim()
    .split(' ')
    .map((x) => (Number(x) / 2 ** 20).toFixed(1));
  return `私有 ${o[0]}MB 工作集 ${o[1]}MB`;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const samples = [
  ...(await loadEvalSamples('eval/colloquial.jsonl')),
  ...(await loadEvalSamples('eval/written.jsonl')),
].slice(0, n);
const keysOf = (i: number): string[] => [
  ...samples[i]!.syllables.flatMap((s) => syllableToKeyCodes(s)),
  'Enter',
];
// 打一句；回傳第一鍵延遲、整句最慢一鍵（載入後頭幾次解碼要把映射的模型頁讀進來）
const sentence = async (i: number): Promise<string> => {
  const [first, ...rest] = keysOf(i);
  const t = await key(first!);
  let max = t;
  for (const c of rest) max = Math.max(max, await key(c));
  return `第一鍵 ${t.toFixed(1)}ms、這句最慢一鍵 ${max.toFixed(1)}ms`;
};

await call({
  method: 'init',
  id: 'x',
  isWindows8Above: true,
  isMetroApp: false,
  isUiLess: false,
  isConsole: false,
});
await call({ method: 'onActivate', isKeyboardOpen: true });
await sleep(200);
console.log(`啟用後（還沒載入）：${mem()}`);
const first = await sentence(0);
if (existsSync(adapterFile)) throw new Error('Enter 之後馬上寫了學習檔（應該等停手）');
console.log(`載入：${first}；打完 1 句：${mem()}`);
for (let i = 1; i < n; i++) await sentence(i);
console.log(`打完 ${n} 句：${mem()}`);
await sleep(IDLE * 1000 + 500);
if (!existsSync(adapterFile)) throw new Error('停手之後沒有寫學習檔');
console.log(`閒置 ${IDLE} 秒卸載後：${mem()}（學習檔已寫）`);
const again = await sentence(0);
console.log(`重新載入（檔案快取熱）：${again}；打完 1 句：${mem()}`);
const t = performance.now();
await call({ method: 'onDeactivate' });
console.log(`停用（最後一個 client）${(performance.now() - t).toFixed(1)}ms 後：${mem()}`);
console.log(log.filter((l) => l.includes('[pime]')).join('\n'));
child.kill();
if (tmp) rmSync(tmp, { recursive: true, force: true });
rmSync(adapterFile, { force: true });
