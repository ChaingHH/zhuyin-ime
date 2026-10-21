// PIME 後端的隨機按鍵壓力測試：照 DLL 的順序送 filterKeyDown／onKeyDown，記下 panic、逾時、最慢的回應。
//   ZHUYIN_DATA=data npx tsx debug-pime-fuzz.ts [按鍵數=20000] [種子=1]
// 後端的 stderr 有 "panicked" 就算失敗（handle 外層的 catch_unwind 會吞掉 panic、清掉組字，使用者看到的是字不見）。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const N = Number(process.argv[2] ?? 20000);
let seed = Number(process.argv[3] ?? 1);
const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;

const child = spawn(
  process.env['ZHUYIN_EXE'] ?? 'native/target/release/zhuyin-native.exe',
  ['pime'],
  {
    env: {
      ZHUYIN_ADAPTER: 'off',
      ZHUYIN_LOG: 'off',
      ZHUYIN_CONFIG: join(tmpdir(), `zhuyin-fuzz-${process.pid}.json`),
      ...process.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
let stderr = '';
child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
let exited = false;
child.on('exit', (c) => {
  exited = true;
  console.error(`後端結束 code=${c}`);
});
const lines = createInterface({ input: child.stdout });
let waiting: ((r: Record<string, unknown>) => void) | null = null;
lines.on('line', (l) => {
  if (!l.startsWith('PIME_MSG|')) return;
  const w = waiting;
  waiting = null;
  w?.(JSON.parse(l.slice(l.indexOf('|', 9) + 1)) as Record<string, unknown>);
});
let seq = 0;
let slowest = 0;
const call = (client: string, msg: Record<string, unknown>): Promise<Record<string, unknown>> =>
  new Promise((res, rej) => {
    const t0 = performance.now();
    const timer = setTimeout(() => rej(new Error(`${String(msg['method'])} 超過 2 秒`)), 2000);
    waiting = (r) => {
      clearTimeout(timer);
      slowest = Math.max(slowest, performance.now() - t0);
      res(r);
    };
    child.stdin.write(`${client}|${JSON.stringify({ ...msg, seqNum: ++seq })}\n`);
  });

// [VK, 字元碼]
const KEYS: [number, number][] = [
  ...'SUCLJ7Z'
    .split('')
    .map((c): [number, number] => [c.charCodeAt(0), c.toLowerCase().charCodeAt(0)]),
  [0x33, 0x33],
  [0x34, 0x34],
  [0x36, 0x36],
  [0x37, 0x37],
  [0x20, 0x20], // 聲調、空白
  [0x28, 0],
  [0x28, 0],
  [0x28, 0],
  [0x26, 0],
  [0x25, 0],
  [0x25, 0],
  [0x27, 0],
  [0x27, 0],
  [0x09, 9],
  [0x21, 0],
  [0x22, 0],
  [0x24, 0],
  [0x23, 0],
  [0x2e, 0],
  ...(process.env['FUZZ_LONG']
    ? []
    : ([
        [0x08, 8],
        [0x1b, 0x1b],
        [0x0d, 0x0d],
      ] as [number, number][])),
  [0x31, 0x31],
  [0x35, 0x35],
  [0x39, 0x39],
  [0x61, 0x31],
  [0x65, 0x35],
  [0x6b, 0x2b],
  [0x6e, 0x2e],
  [0xbc, 0x3c], // Shift+, → ，
];
const keyStates = new Array<number>(256).fill(0);
const ev = (vk: number, ch: number) => ({
  charCode: ch,
  keyCode: vk,
  repeatCount: 1,
  scanCode: 0,
  isExtended: false,
  keyStates,
});

await call('a', {
  method: 'init',
  id: '{64b60746-4570-4343-a34a-85c12f03a93a}',
  isWindows8Above: true,
});
await call('a', { method: 'onActivate', isKeyboardOpen: true });
await call('b', {
  method: 'init',
  id: '{64b60746-4570-4343-a34a-85c12f03a93a}',
  isWindows8Above: true,
});
await call('b', { method: 'onActivate', isKeyboardOpen: true });
let client = 'a';
for (let i = 0; i < N && !exited; i++) {
  const r = rnd();
  if (r < 0.005) client = client === 'a' ? 'b' : 'a';
  else if (r < 0.01) await call(client, { method: 'onCompositionTerminated', forced: true });
  else if (r < 0.02) {
    // 單按 Shift 切換中英
    keyStates[0x10] = 0x80;
    await call(client, { method: 'filterKeyDown', ...ev(0x10, 0) });
    keyStates[0x10] = 0;
    const f = await call(client, { method: 'filterKeyUp', ...ev(0x10, 0) });
    if (f['return']) await call(client, { method: 'onKeyUp', ...ev(0x10, 0) });
  } else if (r < 0.025) {
    keyStates[0x11] = 0x80;
    const f = await call(client, { method: 'filterKeyDown', ...ev(0x56, 0x16) });
    if (f['return']) await call(client, { method: 'onKeyDown', ...ev(0x56, 0x16) });
    keyStates[0x11] = 0;
  } else {
    const [vk, ch] = pick(KEYS);
    const f = await call(client, { method: 'filterKeyDown', ...ev(vk, ch) });
    if (f['return']) await call(client, { method: 'onKeyDown', ...ev(vk, ch) });
  }
  if (stderr.includes('panicked')) break;
}
child.stdin.end();
const panics = stderr.split('\n').filter((l) => /panicked|stack|overflow/.test(l));
console.log(
  `按鍵 ${N}、種子 ${process.argv[3] ?? 1}、最慢回應 ${slowest.toFixed(1)}ms、panic ${panics.length}`,
);
for (const l of panics.slice(0, 5)) console.log(l);
if (panics.length) process.exitCode = 1;
