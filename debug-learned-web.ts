// 學習資料頁的刪除（native/src/learned_web.rs、pime.rs delete_learned）端到端檢查：
// 開一個後端（暫存的 adapter.json、ZHUYIN_NO_OPEN 不開瀏覽器），打「狀態欄」選字學成使用者詞，
// 從右鍵選單開學習資料頁，檢查安全限制（token、Host、Origin），刪掉這個詞，再打一次確認學習沒了、檔案也存了。
//   ZHUYIN_DATA=data npx tsx debug-learned-web.ts
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { syllableToKeyCodes } from '@zhuyin/core';

const dir = mkdtempSync(join(tmpdir(), 'zhuyin-web-'));
const adapterFile = join(dir, 'adapter.json');
const child = spawn(
  process.env['ZHUYIN_EXE'] ?? 'native/target/release/zhuyin-native.exe',
  ['pime'],
  {
    env: {
      ...process.env,
      ZHUYIN_ADAPTER: adapterFile,
      ZHUYIN_CONFIG: join(dir, 'config.json'),
      ZHUYIN_LOG: 'off',
      ZHUYIN_NO_OPEN: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
let url = '';
createInterface({ input: child.stderr }).on('line', (l) => {
  const m = /學習資料頁 (http\S+)/.exec(l);
  if (m) url = m[1]!;
});
let waiting: ((r: Record<string, unknown>) => void) | null = null;
createInterface({ input: child.stdout }).on('line', (l) => {
  if (!l.startsWith('PIME_MSG|')) return;
  const w = waiting;
  waiting = null;
  w?.(JSON.parse(l.slice(l.indexOf('|', 9) + 1)) as Record<string, unknown>);
});
let seq = 0;
const call = (msg: Record<string, unknown>): Promise<Record<string, unknown>> =>
  new Promise((res) => {
    waiting = res;
    child.stdin.write(`c|${JSON.stringify({ ...msg, seqNum: ++seq })}\n`);
  });
const keyStates = new Array<number>(256).fill(0);
const VK: Record<string, [number, number]> = {
  ArrowDown: [0x28, 0],
  Enter: [0x0d, 0x0d],
  Space: [0x20, 0x20],
  Minus: [0xbd, 0x2d],
  Semicolon: [0xba, 0x3b],
  Comma: [0xbc, 0x2c],
  Period: [0xbe, 0x2e],
  Slash: [0xbf, 0x2f],
};
const press = async (code: string): Promise<Record<string, unknown>> => {
  const m = /^(?:Key|Digit)(.)$/.exec(code);
  const [keyCode, charCode] = m
    ? [m[1]!.charCodeAt(0), m[1]!.toLowerCase().charCodeAt(0)]
    : VK[code]!;
  const ev = { keyCode, charCode, repeatCount: 1, scanCode: 0, isExtended: false, keyStates };
  const f = await call({ method: 'filterKeyDown', ...ev });
  return f['return'] ? call({ method: 'onKeyDown', ...ev }) : f;
};
const check = (ok: boolean, what: string): void => {
  if (!ok) throw new Error(`檢查失敗：${what}`);
  console.log(`  ✓ ${what}`);
};
const http = (
  method: string,
  u: string,
  headers: Record<string, string> = {},
  body = '',
): Promise<{ status: number; text: string }> =>
  new Promise((res, rej) => {
    const req = request(u, { method, headers }, (r) => {
      let text = '';
      r.on('data', (d: Buffer) => (text += d.toString()));
      r.on('end', () => res({ status: r.statusCode ?? 0, text }));
    });
    req.on('error', rej);
    req.end(body);
  });

const ZT = ['ㄓㄨㄤˋ', 'ㄊㄞˋ', 'ㄌㄢˊ'].flatMap((s) => syllableToKeyCodes(s));
const typeZt = async (): Promise<string> => {
  for (const c of ZT) await press(c);
  return String((await press('Enter'))['commitString'] ?? '');
};

await call({ method: 'init', isWindows8Above: true });
await call({ method: 'onActivate', isKeyboardOpen: true });
const before = await typeZt();
console.log(`學習前：${before}`);
// 選「欄」（↓ 開最後一個字的清單，預設詞典第 3 個），送出 → 規則 4 學成使用者詞「狀態欄」
for (const c of ZT) await press(c);
await press('ArrowDown');
await press('Digit3');
await press('Enter');
check((await typeZt()) === '狀態欄', '選一次「欄」之後直接打出「狀態欄」');

await call({ method: 'onCommand', id: 5, type: 2 });
for (let i = 0; i < 50 && !url; i++) await new Promise((r) => setTimeout(r, 20));
check(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/.test(url), `右鍵選單開出本機網址（${url}）`);
if (process.env['KEEP']) {
  // 手動測頁面：後端留著 10 分鐘，用瀏覽器開 url 點刪除；adapter.json 在 dir
  console.log(`KEEP ${url} ${adapterFile}`);
  await new Promise((r) => setTimeout(r, 600_000));
}
const { origin, host } = new URL(url);
const token = new URL(url).searchParams.get('t')!;

const page = await http('GET', url);
check(
  page.status === 200 && page.text.includes('狀態欄') && page.text.includes(token),
  '頁面有學到的詞和 token',
);
check((await http('GET', `${origin}/?t=${'0'.repeat(32)}`)).status === 403, '錯的 token 拒絕');
check(
  (await http('GET', url, { Host: `localhost:${new URL(url).port}` })).status === 403,
  'Host 不對（DNS rebinding）拒絕',
);
const body = JSON.stringify({ kind: 'phrase', word: '狀態欄', reading: null });
const del = (headers: Record<string, string>) =>
  http(
    'POST',
    `${origin}/delete?t=${token}`,
    { 'Content-Type': 'application/json', ...headers },
    body,
  );
check((await del({})).status === 403, '沒有 Origin 的 POST 拒絕');
check((await del({ Origin: 'http://evil.example' })).status === 403, '別的網站的 POST 拒絕');
const ok = await del({ Origin: origin, Host: host });
check(ok.status === 200 && JSON.parse(ok.text).ok === true, '頁面自己的刪除成功');
check(JSON.parse((await del({ Origin: origin })).text).ok === false, '再刪一次回 ok:false');

check(!(await http('GET', url)).text.includes('"狀態欄"'), '重新整理後頁面沒有這個詞');
const saved = readFileSync(adapterFile, 'utf8');
check(!saved.includes('"狀態欄"'), 'adapter.json 已存檔、沒有這個詞');
check((await typeZt()) === before, `刪掉後打回學習前的樣子（${before}）`);

// 關分頁就停：頁面 pagehide 送 POST /close；開著的頁面數歸零、3 秒內沒有新的頁面就停。上面 GET 過兩次頁面＝兩個頁面
const close = () => http('POST', `${origin}/close?t=${token}`, { Origin: origin });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
check(
  (await http('GET', `${origin}/ping?t=${token}`)).status === 200,
  '頁面的定時 ping 有回應（不算新頁面）',
);
await close();
await close();
await http('GET', url); // 重新整理：先 close 再 GET
await sleep(3500);
check((await http('GET', url)).status === 200, '重新整理（close 後馬上載入）服務不會停');
check(
  (await http('POST', `${origin}/close?t=${token}`)).status === 404,
  '沒有 Origin 的 close 不算',
);
await close();
await close();
await sleep(3500);
check(
  await http('GET', url).then(
    () => false,
    () => true,
  ),
  '所有頁面都關掉 3 秒後服務停了',
);
const old = url;
url = '';
await call({ method: 'onCommand', id: 5, type: 2 });
for (let i = 0; i < 50 && !url; i++) await sleep(20);
check(
  !!url && url !== old && (await http('GET', url)).status === 200,
  '再從右鍵選單開，會開一個新的服務',
);

child.stdin.end();
console.log('學習資料頁刪除檢查通過');
