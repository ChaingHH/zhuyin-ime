// 直接驅動 PIME 後端（模擬 PIMETextService：init → onActivate → 每鍵 filterKeyDown／onKeyDown，
// 一行一則 `<client>|<json>`，回 `PIME_MSG|<client>|<json>`），量冷啟動、逐鍵來回延遲、準確率、後端記憶體與 CPU。
// 不經 TSF／視窗，所以不佔鍵盤；數字是「模型＋IPC」，不含 TSF 本身的開銷。
// npx tsx debug-pime.ts chewing|mcbopomofo|zhuyin [句數上限]
// zhuyin＝本專案的 Rust 後端（native/target/release/zhuyin-native.exe pime），要設 ZHUYIN_DATA；
// 學習預設關（ZHUYIN_ADAPTER=off，句準才和 `zhuyin-native eval` 可比），ZHUYIN_L3=0 關 L3。
// zhuyin 會先跑一小段行為檢查（Shift 切換、標點、Esc、選字視窗），不符就丟例外。
// 注意：新酷音會把打過的詞學進 %APPDATA%\PIME\chewing\chewing.sqlite3。
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { syllableToKeyCodes } from '@zhuyin/core';
import { loadEvalSamples } from './packages/cli/src/runtime.js';

const PIME = 'C:\\Program Files (x86)\\PIME';
const BACKENDS = {
  chewing: {
    exe: `${PIME}\\python\\python3\\python.exe`,
    args: ['server.py'],
    cwd: `${PIME}\\python`,
    guid: '{F80736AA-28DB-423A-92C9-5540F501C939}',
  },
  mcbopomofo: {
    exe: `${PIME}\\node\\node.exe`,
    args: ['server.js'],
    cwd: `${PIME}\\node`,
    guid: '{5340c1d9-706e-4b6b-b022-2e763fa5f674}',
  },
  zhuyin: {
    exe: 'native/target/release/zhuyin-native.exe',
    args: ['pime'],
    cwd: '.',
    guid: '{64b60746-4570-4343-a34a-85c12f03a93a}',
  },
} as const;

const which = process.argv[2] as keyof typeof BACKENDS;
const be = BACKENDS[which];
if (!be) throw new Error('用法：debug-pime.ts chewing|mcbopomofo|zhuyin [句數]');
const limit = Number(process.argv[3] ?? Infinity);

// KeyboardEvent.code → [VK, 字元碼]
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
    Escape: [0x1b, 0x1b],
    ArrowDown: [0x28, 0],
    ArrowUp: [0x26, 0],
    ShiftLeft: [0x10, 0],
  };
  const v = t[code];
  if (!v) throw new Error(`無對應鍵：${code}`);
  return v;
};

const t0 = performance.now();
const child = spawn(be.exe, be.args, {
  cwd: be.cwd,
  env: {
    ZHUYIN_ADAPTER: 'off',
    // 行為檢查會改設定檔（只用左 Shift），不能碰使用者的 %APPDATA%\PIME\zhuyin\config.json
    ZHUYIN_CONFIG: join(tmpdir(), `zhuyin-config-${process.pid}.json`),
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', () => {});
const lines = createInterface({ input: child.stdout });
let waiting: ((r: Record<string, unknown>) => void) | null = null;
lines.on('line', (l) => {
  if (!l.startsWith('PIME_MSG|')) return;
  const json = l.slice(l.indexOf('|', 9) + 1);
  const w = waiting;
  waiting = null;
  w?.(JSON.parse(json) as Record<string, unknown>);
});
let seq = 0;
const call = (msg: Record<string, unknown>): Promise<Record<string, unknown>> =>
  new Promise((res) => {
    waiting = res;
    child.stdin.write(`bench|${JSON.stringify({ ...msg, seqNum: ++seq })}\n`);
  });

const keyStates = new Array<number>(256).fill(0);
const key = async (code: string): Promise<string> => (await press(code)).out;
// 一次按鍵（down＋必要時 onKeyDown）；char 覆寫字元碼（Shift+, → '<'）
const press = async (
  code: string,
  char?: string,
): Promise<{ out: string; last: Record<string, unknown>; eaten: boolean }> => {
  const [keyCode, cc] = keyOf(code);
  const charCode = char ? char.charCodeAt(0) : cc;
  const ev = { charCode, keyCode, repeatCount: 1, scanCode: 0, isExtended: false, keyStates };
  const f = await call({ method: 'filterKeyDown', ...ev });
  let out = (f['commitString'] as string | undefined) ?? '';
  let last = f;
  if (f['return']) {
    last = await call({ method: 'onKeyDown', ...ev });
    out += (last['commitString'] as string | undefined) ?? '';
  }
  return { out, last, eaten: !!f['return'] };
};
// 單按 Shift：down 放行、up 攔下並在 onKeyUp 切換
// right：右 Shift（掃描碼 0x36）
const shiftTap = async (right = false): Promise<Record<string, unknown>> => {
  const ev = {
    charCode: 0,
    keyCode: 0x10,
    repeatCount: 1,
    scanCode: right ? 0x36 : 0x2a,
    isExtended: false,
  };
  keyStates[0x10] = 0x80;
  await call({ method: 'filterKeyDown', ...ev, keyStates });
  keyStates[0x10] = 0;
  const f = await call({ method: 'filterKeyUp', ...ev, keyStates });
  return f['return'] ? call({ method: 'onKeyUp', ...ev, keyStates }) : f;
};
const check = (ok: boolean, what: string): void => {
  if (!ok) throw new Error(`行為檢查失敗：${what}`);
};
async function smoke(): Promise<void> {
  // 標點：組字區空時直接輸出全形
  check((await press('Comma', '<')).out === '，', 'Shift+, → ，');
  // Esc 取消組字
  await press('Digit1');
  check((await press('Escape')).last['compositionString'] === '', 'Esc 清空組字區');
  // ↓ 開選字視窗、1 選字、Enter 送出
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c); // ㄋㄧˇ
  const menu = await press('ArrowDown');
  check(
    menu.last['showCandidates'] === true && (menu.last['candidateList'] as string[]).length > 0,
    '↓ 開選字視窗',
  );
  const pick = await press('Digit2');
  const want = (menu.last['candidateList'] as string[])[1]!;
  check(
    pick.last['showCandidates'] === false && pick.last['compositionString'] === want,
    `2 選第二候選 ${want}`,
  );
  check((await press('Enter')).out === want, 'Enter 送出選的字');
  // 組字中單按 Shift：先送出，再切英文；英文模式放行字母
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c);
  const sw = await shiftTap();
  check(
    typeof sw['commitString'] === 'string' && (sw['commitString'] as string).length === 1,
    'Shift 先送出組字',
  );
  check(!(await press('KeyA')).eaten, '英文模式放行字母');
  await shiftTap();
  check((await press('KeyA')).eaten, '切回注音後攔下注音鍵');
  await press('Escape');

  // 選字視窗（微軟注音鍵位）：↓ 開、反白在第一個；↓ 移到第二個；Enter 選反白
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c);
  check((await press('ArrowDown')).last['candidateCursor'] === 0, '↓ 開視窗、反白第一個');
  const down = await press('ArrowDown');
  check(down.last['candidateCursor'] === 1, '↓ 反白移到第二個');
  check((await press('ArrowUp')).last['candidateCursor'] === 0, '↑ 反白移回第一個');
  await press('ArrowDown');
  const sel = (down.last['candidateList'] as string[])[1]!;
  check((await press('Enter')).last['compositionString'] === sel, `Enter 選反白的 ${sel}`);
  await press('Escape');

  // 語言列圖示（左鍵＝onCommand id 1）：PIME 的 DLL 在 onCommand 沒有 edit session，
  // 回應裡有 showMessage／commitString／compositionString 會讓宿主程式當掉
  const noSession = (r: Record<string, unknown>, what: string): void =>
    check(
      !('showMessage' in r) && !('commitString' in r) && !('compositionString' in r),
      `${what} 的回應不能有需要 edit session 的欄位：${JSON.stringify(r)}`,
    );
  const click = await call({ method: 'onCommand', id: 1, type: 0 });
  noSession(click, '點圖示');
  check(!(await press('KeyA')).eaten, '點圖示切到英文');
  noSession(await call({ method: 'onCommand', id: 1, type: 0 }), '再點圖示');
  check((await press('KeyA')).eaten, '再點圖示切回注音（組字中）');
  noSession(await call({ method: 'onCommand', id: 1, type: 0 }), '組字中點圖示');
  check((await press('KeyA')).eaten, '組字中點圖示不切換');
  await press('Escape');
  // 右鍵選單（onMenu 回傳選單陣列；選了之後 onCommand 帶選項 id、type 2）
  const menuReply = await call({ method: 'onMenu', id: 'windows-mode-icon' });
  const items = menuReply['return'] as Array<{ id: number; checked?: boolean }>;
  check(Array.isArray(items) && items.some((i) => i.id === 2), '右鍵選單有「只用左 Shift」');
  // 只用左 Shift：右 Shift 不切換、左 Shift 照樣切換；再選一次恢復
  noSession(await call({ method: 'onCommand', id: 2, type: 2 }), '選單：只用左 Shift');
  check(!(await shiftTap(true))['return'], '只用左 Shift 時右 Shift 不切換');
  check((await press('KeyA')).eaten, '右 Shift 後仍是注音');
  await press('Escape');
  await shiftTap();
  check(!(await press('KeyA')).eaten, '左 Shift 照樣切英文');
  await shiftTap();
  await call({ method: 'onCommand', id: 2, type: 2 });
  await shiftTap(true);
  check(!(await press('KeyA')).eaten, '恢復後右 Shift 也能切換');
  await shiftTap();
}

const init = await call({
  method: 'init',
  id: be.guid,
  isWindows8Above: true,
  isMetroApp: false,
  isUiLess: false,
  isConsole: false,
});
await call({ method: 'onActivate', isKeyboardOpen: true });
const coldMs = performance.now() - t0;
if (which === 'zhuyin') {
  await smoke();
  console.log('[zhuyin] 行為檢查通過');
}

const samples = [
  ...(await loadEvalSamples('eval/colloquial.jsonl')).map((s) => ({ ...s, set: 'colloquial' })),
  ...(await loadEvalSamples('eval/written.jsonl')).map((s) => ({ ...s, set: 'written' })),
].slice(0, limit);
const proc = (): { ws: number; priv: number; peak: number; cpu: number } => {
  const o = execSync(
    `powershell -NoProfile -Command "$p = Get-Process -Id ${child.pid}; '{0} {1} {2} {3}' -f $p.WorkingSet64, $p.PrivateMemorySize64, $p.PeakWorkingSet64, $p.TotalProcessorTime.TotalMilliseconds"`,
  )
    .toString()
    .trim()
    .split(' ')
    .map(Number);
  return { ws: o[0]! / 2 ** 20, priv: o[1]! / 2 ** 20, peak: o[2]! / 2 ** 20, cpu: o[3]! };
};
const before = proc();
const lat: number[] = [];
const commitLat: number[] = [];
const ok: Record<string, [number, number]> = { colloquial: [0, 0], written: [0, 0] };
const fails: string[] = [];
for (const s of samples) {
  let out = '';
  for (const code of s.syllables.flatMap((syl) => syllableToKeyCodes(syl))) {
    const t = performance.now();
    out += await key(code);
    lat.push(performance.now() - t);
  }
  const t = performance.now();
  out += await key('Enter');
  commitLat.push(performance.now() - t);
  const c = ok[s.set]!;
  c[1]++;
  if (out === s.text) c[0]++;
  else if (fails.length < 5) fails.push(`${s.text} → ${out}`);
}
const after = proc();
child.kill();

const sorted = [...lat].sort((x, y) => x - y);
const pct = (p: number): string =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!.toFixed(2);
const acc = (k: string): string => ((ok[k]![0] / Math.max(1, ok[k]![1])) * 100).toFixed(1);
console.log(`[${which}] init=${JSON.stringify(init).slice(0, 80)}`);
console.log(
  `${which} | ${samples.length} 句 ${lat.length} 鍵 | 句 口語 ${acc('colloquial')} 書面 ${acc('written')} | ` +
    `冷啟動 ${coldMs.toFixed(0)}ms | 每鍵 p50 ${pct(0.5)} p95 ${pct(0.95)} p99 ${pct(0.99)} max ${sorted.at(-1)!.toFixed(2)} ms | ` +
    `Enter ${(commitLat.reduce((a, b) => a + b, 0) / commitLat.length).toFixed(2)}ms | ` +
    `CPU ${((after.cpu - before.cpu) / lat.length).toFixed(2)} ms/鍵 | ` +
    `後端 WS ${after.ws.toFixed(0)}MB private ${after.priv.toFixed(0)}MB peak ${after.peak.toFixed(0)}MB`,
);
for (const f of fails) console.log(`  ✗ ${f}`);
