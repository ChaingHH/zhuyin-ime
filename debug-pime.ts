// 直接驅動 PIME 後端（模擬 PIMETextService：init → onActivate → 每鍵 filterKeyDown／onKeyDown，
// 一行一則 `<client>|<json>`，回 `PIME_MSG|<client>|<json>`），量冷啟動、逐鍵來回延遲、準確率、後端記憶體與 CPU。
// 不經 TSF／視窗，所以不佔鍵盤；數字是「模型＋IPC」，不含 TSF 本身的開銷。
// npx tsx debug-pime.ts chewing|mcbopomofo|zhuyin [句數上限]
// zhuyin＝本專案的 Rust 後端（native/target/release/zhuyin-native.exe pime，ZHUYIN_EXE 可換），要設 ZHUYIN_DATA；
// 學習預設關（ZHUYIN_ADAPTER=off，句準才和 `zhuyin-native eval` 可比），ZHUYIN_L3=0 關 L3。
// ZHUYIN_LAYOUT=eten|hsu|ibm|eten26：行為檢查（大千）後從右鍵選單換排列，句子照那個排列打。
// zhuyin 會先跑一小段行為檢查（Shift 切換、標點、Esc、選字視窗），不符就丟例外。
// 注意：新酷音會把打過的詞學進 %APPDATA%\PIME\chewing\chewing.sqlite3。
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { LAYOUT_KEYS, syllableToKeyCodes, type LayoutName } from '@zhuyin/core';
import { loadEvalSamples } from './packages/data-pipeline/src/build/evalset.js';

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
    exe: process.env['ZHUYIN_EXE'] ?? 'native/target/release/zhuyin-native.exe',
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
  const np = /^Numpad(\d)$/.exec(code);
  if (np) return [0x60 + Number(np[1]), np[1]!.charCodeAt(0)];
  const t: Record<string, [number, number]> = {
    NumpadMultiply: [0x6a, 0x2a],
    NumpadAdd: [0x6b, 0x2b],
    NumpadSubtract: [0x6d, 0x2d],
    NumpadDecimal: [0x6e, 0x2e],
    NumpadDivide: [0x6f, 0x2f],
    Space: [0x20, 0x20],
    Minus: [0xbd, 0x2d],
    Semicolon: [0xba, 0x3b],
    Comma: [0xbc, 0x2c],
    Equal: [0xbb, 0x3d],
    Quote: [0xde, 0x27],
    Period: [0xbe, 0x2e],
    Slash: [0xbf, 0x2f],
    BracketLeft: [0xdb, 0x5b],
    Enter: [0x0d, 0x0d],
    Escape: [0x1b, 0x1b],
    ArrowDown: [0x28, 0],
    ArrowUp: [0x26, 0],
    ArrowLeft: [0x25, 0],
    ArrowRight: [0x27, 0],
    Tab: [0x09, 0x09],
    Home: [0x24, 0],
    PageUp: [0x21, 0],
    ControlLeft: [0x11, 0],
    ShiftLeft: [0x10, 0],
  };
  const v = t[code];
  if (!v) throw new Error(`無對應鍵：${code}`);
  return v;
};

const configFile = join(tmpdir(), `zhuyin-config-${process.pid}.json`);
const t0 = performance.now();
const child = spawn(be.exe, be.args, {
  cwd: be.cwd,
  env: {
    ZHUYIN_ADAPTER: 'off',
    ZHUYIN_LOG: 'off',
    // 行為檢查會改設定檔（Shift 選項），不能碰使用者的 %APPDATA%\PIME\zhuyin\config.json
    ZHUYIN_CONFIG: configFile,
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
/** 目前送訊息的 client（PIMELauncher 每個程式一個 id；行為檢查會換成第二個程式） */
let client = 'bench';
const call = (msg: Record<string, unknown>): Promise<Record<string, unknown>> =>
  new Promise((res, rej) => {
    const seqNum = ++seq;
    const t0 = performance.now();
    // PIMETextService.dll 等回應最多 2 秒（PIMEClient.cpp callRpcPipe），逾時就當 RPC 失敗
    const timer = setTimeout(
      () => rej(new Error(`${String(msg['method'])} 超過 2 秒沒回應`)),
      2000,
    );
    waiting = (r) => {
      clearTimeout(timer);
      if (which === 'zhuyin') checkReply(String(msg['method']), seqNum, r, performance.now() - t0);
      res(r);
    };
    child.stdin.write(`${client}|${JSON.stringify({ ...msg, seqNum })}\n`);
  });

/**
 * 回應格式檢查：照 PIME v2.0.0-beta 的 PIMETextService（PIMEClient.cpp、PIMELangBarButton.cpp）實際怎麼讀。
 * DLL 用 nlohmann::json，型別不符的 get／value 會丟例外；handleRpcResponse 之後沒有 try，
 * 例外直接讓宿主程式（Explorer、記事本…）當掉。沒有 edit session 的方法帶 showMessage 會解參考空指標。
 */
const KEY_METHODS = new Set([
  'filterKeyDown',
  'onKeyDown',
  'filterKeyUp',
  'onKeyUp',
  'onPreservedKey',
  'onCommand',
]);
const WITH_SESSION = new Set(['onKeyDown', 'onKeyUp']);
function checkReply(method: string, seqNum: number, r: Record<string, unknown>, ms: number): void {
  const bad = (what: string): never => {
    throw new Error(`回應格式錯誤（${method}）：${what}\n${JSON.stringify(r)}`);
  };
  const isInt = (v: unknown): boolean => Number.isInteger(v);
  const isUint = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;
  const isStr = (v: unknown): boolean => typeof v === 'string';
  const isBool = (v: unknown): boolean => typeof v === 'boolean';
  const opt = (k: string, ok: (v: unknown) => boolean, what: string): void => {
    if (k in r && !ok(r[k])) bad(`${k} 必須是 ${what}`);
  };
  if (ms > 1000) bad(`花了 ${ms.toFixed(0)}ms（DLL 2 秒就放棄）`);
  // callRpcMethod：seqNum 要對上（get<unsigned int>）；handleRpcResponse：value("success", false)
  if (r['seqNum'] !== seqNum) bad(`seqNum ${String(r['seqNum'])} ≠ ${seqNum}`);
  if (!isBool(r['success'])) bad('success 必須是 bool');
  // value("return", false)：有就必須是 bool；onMenu 的 return 是選單陣列（menuFromJson）
  if (method === 'onMenu') {
    const menu = (items: unknown): boolean =>
      Array.isArray(items) &&
      items.every(
        (i) =>
          typeof i === 'object' &&
          i !== null &&
          (!('id' in i) || isUint((i as Record<string, unknown>)['id'])) &&
          (!('text' in i) || isStr((i as Record<string, unknown>)['text'])) &&
          (!('checked' in i) || isBool((i as Record<string, unknown>)['checked'])) &&
          (!('enabled' in i) || isBool((i as Record<string, unknown>)['enabled'])) &&
          (!('submenu' in i) || menu((i as Record<string, unknown>)['submenu'])),
      );
    opt(
      'return',
      menu,
      '選單陣列 [{id: uint, text: string, checked?: bool, enabled?: bool, submenu?: [...]}]',
    );
    // TrackPopupMenu 選到 id 0 會當成取消：id 0 只能是分隔線（空字串）；其他 id 不能重複
    const flat = (items: unknown): Array<Record<string, unknown>> =>
      Array.isArray(items)
        ? items.flatMap((i: Record<string, unknown>) => [i, ...flat(i['submenu'])])
        : [];
    const all = flat(r['return']);
    if (all.some((i) => (i['id'] ?? 0) === 0 && (i['text'] ?? '') !== ''))
      bad('id 0 的選項只能是分隔線（text 空字串）');
    const ids = all.map((i) => i['id']).filter((id) => id);
    if (new Set(ids).size !== ids.length) bad('選單 id 重複');
  } else if (KEY_METHODS.has(method)) opt('return', isBool, 'bool');
  else if ('return' in r) bad('這個方法的 return 不會被讀');
  // updateMessageWindow 在檢查 session 之前執行：沒有 session 時 showMessage 會讓宿主程式當掉
  if ('showMessage' in r) {
    if (!WITH_SESSION.has(method)) bad('showMessage 只能出現在 onKeyDown／onKeyUp 的回應');
    const m = r['showMessage'] as Record<string, unknown>;
    if (!isStr(m?.['message']) || !isInt(m?.['duration']))
      bad('showMessage 要是 {message: string, duration: int}');
  }
  opt('hideMessage', isBool, 'bool');
  opt('setSelKeys', isStr, 'string');
  opt('compositionString', isStr, 'string');
  opt('commitString', isStr, 'string');
  opt('showCandidates', isBool, 'bool');
  opt('openKeyboard', isBool, 'bool');
  opt('candidateList', (v) => Array.isArray(v) && v.every(isStr), 'string 陣列（get<string>）');
  opt('compositionCursor', isUint, '非負整數');
  if ('compositionCursor' in r && isStr(r['compositionString'])) {
    // DLL 逐 UTF-16 碼元往前數，超過長度會讀到字串外
    if ((r['compositionCursor'] as number) > (r['compositionString'] as string).length)
      bad('compositionCursor 超過組字字串長度（UTF-16）');
  }
  opt('candidateCursor', isUint, '非負整數');
  if ('candidateCursor' in r && Array.isArray(r['candidateList'])) {
    if ((r['candidateCursor'] as number) >= (r['candidateList'] as unknown[]).length)
      bad('candidateCursor 超出候選清單');
  }
  // PIMELangBarButton::fromJson／updateFromJson；changeButton 的 id 用 get<string>（不是字串會丟例外）
  const button = (b: unknown): boolean => {
    if (typeof b !== 'object' || b === null) return false;
    const o = b as Record<string, unknown>;
    return (
      isStr(o['id']) &&
      (!('icon' in o) || isStr(o['icon'])) &&
      (!('commandId' in o) || isUint(o['commandId'])) &&
      (!('text' in o) || isStr(o['text'])) &&
      (!('tooltip' in o) || isStr(o['tooltip'])) &&
      (!('type' in o) || ['button', 'toggle', 'menu'].includes(o['type'] as string)) &&
      (!('enable' in o) || isBool(o['enable'])) &&
      (!('toggled' in o) || isBool(o['toggled']))
    );
  };
  opt('addButton', (v) => Array.isArray(v) && v.every(button), '按鈕陣列');
  opt('changeButton', (v) => Array.isArray(v) && v.every(button), '按鈕陣列（每個都要有字串 id）');
  opt('removeButton', (v) => Array.isArray(v) && v.every(isStr), 'string 陣列');
  opt(
    'customizeUI',
    (v) => {
      const o = v as Record<string, unknown>;
      return (
        typeof v === 'object' &&
        v !== null &&
        // 字型名：wcsncpy 進 LOGFONT.lfFaceName（PIMETextService.cpp:258，最多 31 個 UTF-16 碼元）
        (!('candFontName' in o) ||
          (isStr(o['candFontName']) &&
            (o['candFontName'] as string).length > 0 &&
            (o['candFontName'] as string).length <= 31)) &&
        (!('candFontSize' in o) ||
          (isInt(o['candFontSize']) && (o['candFontSize'] as number) > 0)) &&
        (!('candPerRow' in o) || (isInt(o['candPerRow']) && (o['candPerRow'] as number) >= 1)) &&
        (!('candUseCursor' in o) || isBool(o['candUseCursor']))
      );
    },
    '{candFontName?: 1–31 字元, candFontSize?: 正整數, candPerRow?: ≥1, candUseCursor?: bool}',
  );
  // updateStatus 最後才套用 customizeUI：和 candidateList 同一則回應時，新欄數晚一個鍵才看得到
  const ui = r['customizeUI'] as Record<string, unknown> | undefined;
  if (ui && 'candPerRow' in ui && 'candidateList' in r)
    bad('candPerRow 要在 candidateList 之前的回應送（例如 filterKeyDown），同一則會晚一鍵生效');
}

const keyStates = new Array<number>(256).fill(0);
const key = async (code: string): Promise<string> => (await press(code)).out;
// 一次按鍵（down＋必要時 onKeyDown）；char 覆寫字元碼（Shift+, → '<'）
const press = async (
  code: string,
  char?: string,
): Promise<{
  out: string;
  last: Record<string, unknown>;
  eaten: boolean;
  filter: Record<string, unknown>;
}> => {
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
  return { out, last, eaten: !!f['return'], filter: f };
};
// 單按 Shift：down 放行；沒在組字時 up 也放行、在 filterKeyUp 切換，組字中 up 攔下並在 onKeyUp 切換
// right：右 Shift（掃描碼 0x36）
// rollover：Shift 按著時才放開這個鍵（快打時前一個注音鍵常晚放開）。
// keyUp=false：模擬遊戲，DLL 拿不到 edit session，不會送 onKeyUp
const shiftTap = async (
  right = false,
  rollover?: string,
  keyUp = true,
): Promise<Record<string, unknown>> => {
  const ev = {
    charCode: 0,
    keyCode: 0x10,
    repeatCount: 1,
    scanCode: right ? 0x36 : 0x2a,
    isExtended: false,
  };
  keyStates[0x10] = 0x80;
  await call({ method: 'filterKeyDown', ...ev, keyStates });
  if (rollover) {
    const [keyCode, charCode] = keyOf(rollover);
    const up = await call({
      method: 'filterKeyUp',
      ...ev,
      keyCode,
      charCode,
      scanCode: 0,
      keyStates,
    });
    check(!up['return'], `Shift 按著時放開 ${rollover} 不該被攔下`);
  }
  keyStates[0x10] = 0;
  const f = await call({ method: 'filterKeyUp', ...ev, keyStates });
  return f['return'] && keyUp ? call({ method: 'onKeyUp', ...ev, keyStates }) : f;
};
const check = (ok: boolean, what: string): void => {
  if (!ok) throw new Error(`行為檢查失敗：${what}`);
};
async function smoke(): Promise<void> {
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
  // 右鍵選單（onMenu 回傳選單陣列；選了之後 onCommand 帶選項 id、type 2）。
  // 左、右 Shift 各一個開關：2＝左、3＝右，checked＝開著；沒有「切換中／英」（用左鍵點圖示）
  const shiftMenu = async (): Promise<string> => {
    const items = (await call({ method: 'onMenu', id: 'windows-mode-icon' }))['return'] as Array<{
      id: number;
      text: string;
      checked?: boolean;
    }>;
    check(
      Array.isArray(items) &&
        [2, 3, 5].every((id) => items.some((i) => i.id === id)) &&
        !items.some((i) => i.id === 1 || i.id === 4),
      `右鍵選單：查看學習資料＋左右兩個 Shift 開關，沒有切換中英（${JSON.stringify(items)}）`,
    );
    const on = (id: number): string => (items.find((i) => i.id === id)?.checked ? '1' : '0');
    return on(2) + on(3);
  };
  const toggles = async (right: boolean): Promise<boolean> => {
    const t = await shiftTap(right);
    const r = 'changeButton' in t;
    // 沒在組字：Shift 放開要傳給程式（遊戲等程式給不了 onKeyUp 的 edit session）
    if (r && t['return']) throw new Error('行為檢查失敗：沒在組字時 Shift 放開被攔下');
    if (r) await shiftTap(right); // 切回來，保持注音
    return r;
  };
  check((await shiftMenu()) === '11', '預設左右兩個開關都勾');
  check((await toggles(false)) && (await toggles(true)), '預設左右 Shift 都切換');
  // 關掉左 Shift
  noSession(await call({ method: 'onCommand', id: 2, type: 2 }), '選單：左 Shift 開關');
  check((await shiftMenu()) === '01', '左 Shift 開關取消勾選');
  check(readFileSync(configFile, 'utf8').includes('"right"'), 'config.json 寫入 "right"');
  check(!(await toggles(false)), '左 Shift 關掉後不切換');
  check((await press('KeyA')).eaten, '左 Shift 後仍是注音');
  await press('Escape');
  check(await toggles(true), '右 Shift 仍切換');
  // 再關掉右 Shift：兩邊都不切換
  noSession(await call({ method: 'onCommand', id: 3, type: 2 }), '選單：右 Shift 開關');
  check((await shiftMenu()) === '00', '兩個開關都取消');
  check(readFileSync(configFile, 'utf8').includes('"none"'), 'config.json 寫入 "none"');
  check(!(await toggles(false)) && !(await toggles(true)), '兩邊都關掉時 Shift 不切換');
  // 舊版設定檔的 "left" 照樣有效：onActivate 時重讀
  writeFileSync(configFile, '{"shiftToggle": "left"}');
  await call({ method: 'onActivate', isKeyboardOpen: true });
  check((await shiftMenu()) === '10', '設定檔 "left" 讀進來');
  check(!(await toggles(true)) && (await toggles(false)), '"left" 只有左 Shift 切換');
  // 恢復左右都切換
  noSession(await call({ method: 'onCommand', id: 3, type: 2 }), '選單：打開右 Shift');
  check((await shiftMenu()) === '11', '兩個開關都勾回來');
  check((await toggles(false)) && (await toggles(true)), '恢復後左右 Shift 都切換');

  // 標點：Shift 打半形，注音模式的 Ctrl＋原按鍵打全形；組字區空時直接輸出
  const withMods = async (mods: number[], code: string, char?: string) => {
    for (const m of mods) keyStates[m] = 0x80;
    const r = await press(code, char);
    for (const m of mods) keyStates[m] = 0;
    return r;
  };
  check((await press('Comma', '<')).out === '<', 'Shift+, → <');
  // Shift＋字母：同英文模式，組字區空就直接輸出，組字中併進英文 token
  check((await withMods([0x10], 'KeyA', 'A')).out === 'A', 'Shift+A → A');
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c); // ㄋㄧˇ
  await withMods([0x10], 'KeyA', 'A');
  check((await press('Enter')).out.endsWith('A'), '組字中 Shift+A 併進組字區');
  // CapsLock 開著（key 是大寫）但沒按 Shift：仍打注音
  const caps = await press('KeyA', 'A');
  check(caps.eaten && caps.out === '', 'CapsLock＋A 仍打注音');
  await press('Escape');
  // CapsLock＋Shift＋A（key 是小寫）：打英文 a
  check((await withMods([0x10], 'KeyA', 'a')).out === 'a', 'CapsLock＋Shift+A → a');
  check((await withMods([0x11], 'Comma')).out === '，', 'Ctrl+, → ，');
  check((await withMods([0x11, 0x10], 'BracketLeft')).out === '『', 'Ctrl+Shift+[ → 『');
  check(!(await withMods([0x11], 'KeyC')).eaten, 'Ctrl+C 交給程式');
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c); // ㄋㄧˇ
  await withMods([0x11], 'Period');
  check((await press('Enter')).out.endsWith('。'), '組字中 Ctrl+. 插入 。');
  await shiftTap(false);
  check(!(await withMods([0x11], 'Comma')).eaten, '英文模式 Ctrl+, 交給程式');
  await shiftTap(false);
  // 簡體輸出：Ctrl+Shift+F 切換（組字中馬上重畫），右鍵選單 id 20；只轉輸出
  const simpMenu = async () =>
    (
      (await call({ method: 'onMenu', id: 'windows-mode-icon' }))['return'] as Array<{
        id: number;
        checked?: boolean;
      }>
    ).find((i) => i.id === 20)?.checked;
  check((await simpMenu()) === false, '預設不是簡體輸出');
  const ctrlShiftF = () => withMods([0x11, 0x10], 'KeyF');
  const sf = await ctrlShiftF();
  check(sf.eaten && sf.out === '', 'Ctrl+Shift+F 攔下、不輸出');
  check(
    JSON.parse(readFileSync(configFile, 'utf8')).simplified === true,
    'config.json 寫入 simplified',
  );
  check((await simpMenu()) === true, '選單打勾');
  let comp = '';
  // ㄊㄡˊㄈㄚˇ
  for (const c of ['KeyW', 'Period', 'Digit6', 'KeyZ', 'Digit8', 'Digit3'])
    comp = String((await press(c)).last['compositionString']);
  check(comp === '头发', `組字區轉成簡體（${comp}）`);
  const cands = ((await press('ArrowDown')).last['candidateList'] as string[]).join(' ');
  check(cands.includes('发') && !/[頭髮]/.test(cands), `候選轉成簡體（${cands}）`);
  await press('Escape'); // 只關選字視窗
  check((await ctrlShiftF()).last['compositionString'] === '頭髮', '組字中切回繁體馬上重畫');
  check((await ctrlShiftF()).last['compositionString'] === '头发', '組字中切成簡體馬上重畫');
  check((await press('Enter')).out === '头发', 'Enter 送出簡體');
  noSession(await call({ method: 'onCommand', id: 20, type: 2 }), '選單切換簡體');
  check((await simpMenu()) === false, '選單關掉簡體');
  check(
    JSON.parse(readFileSync(configFile, 'utf8')).simplified === false,
    'config.json 寫入 false',
  );
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
  // 使用紀錄（開關與清除在學習資料頁，見 debug-learned-web.ts）：設定檔打開 → 選字後送出寫一行（picks 有這次的選字）
  const usageFile = join(tmpdir(), 'usage.jsonl');
  rmSync(usageFile, { force: true });
  const setUsage = async (on: boolean) => {
    const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
    writeFileSync(configFile, JSON.stringify({ ...cfg, usageLog: on }));
    await call({ method: 'onActivate', isKeyboardOpen: true });
  };
  await setUsage(true);
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c);
  await press('ArrowDown');
  await press('Digit2');
  const logged = (await press('Enter')).out;
  const rec = JSON.parse(readFileSync(usageFile, 'utf8').trim().split('\n').pop()!);
  check(
    rec.out === logged &&
      rec.syl === 'ㄋㄧˇ' &&
      rec.picks.length === 1 &&
      rec.picks[0].to === logged &&
      rec.keys === 5,
    `使用紀錄一行（${JSON.stringify(rec)}）`,
  );
  await setUsage(false);
  rmSync(usageFile, { force: true });
  // 組字中單按 Shift：不送出，切英文；英文併進組字區，空白整段送出；組字區空了就放行字母
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c);
  const sw = await shiftTap();
  const zh = sw['compositionString'];
  check(
    !('commitString' in sw) && typeof zh === 'string' && [...zh].length === 1,
    'Shift 不送出組字',
  );
  await press('KeyO', 'o');
  const en = await press('KeyK', 'k');
  check(en.eaten && en.last['compositionString'] === `${zh}ok`, '英文併進組字區');
  check(en.last['compositionCursor'] === [...`${zh}ok`].length, '游標在英文後面');
  check((await press('Space', ' ')).out === `${zh}ok `, '英文模式空白整段送出');
  check(!(await press('KeyA')).eaten, '英文模式放行字母');
  await shiftTap();
  check((await press('KeyA')).eaten, '切回注音後攔下注音鍵');
  await press('Escape');
  // 注音打到一半就切英文：不成字的注音丟掉，英文直接打
  await press('KeyS'); // ㄋ
  const half = await shiftTap();
  check(half['compositionString'] === '', '只有半個注音時切英文：清掉組字');
  check(!(await press('KeyK', 'k')).eaten, '接著的英文直接放行');
  await shiftTap();
  // 快打：按 ㄋ → 按 Shift → 才放開 ㄋ → 放開 Shift，照樣切換並丟掉半個注音
  await press('KeyS');
  const roll = await shiftTap(false, 'KeyS');
  check(roll['compositionString'] === '', 'Shift 按著時放開前一個注音鍵：照樣切換');
  check(!(await press('KeyK', 'k')).eaten, '快打切換後英文直接放行');
  await shiftTap();
  // 遊戲：沒有 onKeyUp。切換在 filterKeyUp 就生效，下一個鍵清掉畫面上的半個注音後放行
  await press('KeyS');
  await shiftTap(false, undefined, false);
  const g = await press('KeyK', 'k');
  check(
    g.eaten && g.last['compositionString'] === '' && g.last['return'] === false,
    `遊戲裡切英文：下一個鍵清掉半個注音並放行（${JSON.stringify(g.last)}）`,
  );
  check(!(await press('KeyK', 'k')).eaten, '遊戲裡切英文後英文直接放行');
  await shiftTap(false, undefined, false); // 沒在組字，不需要 onKeyUp
  check((await press('KeyA')).eaten, '遊戲裡切回注音');
  await press('Escape');
  // 遊戲：已成字的組字中切英文，英文照樣併進組字區
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c);
  await shiftTap(false, undefined, false);
  const ge = await press('KeyK', 'k');
  check(
    ge.eaten && [...String(ge.last['compositionString'])].length === 2,
    '遊戲裡組字中切英文：英文併進組字區',
  );
  await press('Escape');
  await shiftTap();
  for (const c of ['KeyS', 'KeyU', 'Digit3', 'KeyC']) await press(c); // ㄋㄧˇ＋ㄏ
  const mixed = await shiftTap();
  check([...String(mixed['compositionString'])].length === 1, '已成字的留著，半個注音丟掉');
  const mk = await press('KeyK', 'k');
  check(mk.eaten && String(mk.last['compositionString']).endsWith('k'), '英文接在已成字後面');
  await shiftTap();
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

  // 清單最後一項是注音本身：從第一頁 PageUp 循環到最後一頁，最後一個就是 ㄋㄧˇ
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c);
  await press('ArrowDown');
  const lastPage = (await press('PageUp')).last['candidateList'] as string[];
  check(lastPage.at(-1) === 'ㄋㄧˇ', `清單最後一項是注音本身（${lastPage.at(-1)}）`);
  await press('Escape');
  await press('Escape');
  // 選字後游標跳到選定那段後面：ㄋㄧˇ ㄏㄠˇ，Home，↓，1（最長的詞）
  const niHao = ['KeyS', 'KeyU', 'Digit3', 'KeyC', 'KeyL', 'Digit3'];
  for (const c of niHao) await press(c);
  await press('Home');
  const open = await press('ArrowDown');
  const first = (open.last['candidateList'] as string[])[0]!;
  const picked = await press('Digit1');
  check(
    picked.last['compositionCursor'] === first.length,
    `選字後游標在選定那段後面（${String(picked.last['compositionCursor'])} ≠ ${first.length}）`,
  );
  await press('Escape');
  // 視窗外 ↑：不開視窗、游標不動，連按會換掉游標處的詞
  for (const c of niHao) await press(c);
  const before = (await press('Home')).last['compositionString'];
  let changed = false;
  for (let i = 0; i < 3; i++) {
    const up = await press('ArrowUp');
    check(
      up.last['showCandidates'] === false && up.last['compositionCursor'] === 0,
      '↑ 不開視窗、游標不動',
    );
    changed ||= up.last['compositionString'] !== before;
  }
  check(changed, '連按 ↑ 會換掉游標處的詞');
  await press('Escape');

  // 表格（微軟注音：→／Tab 展開成表格，← 收回）：filterKeyDown 先送 candPerRow，onKeyDown 再帶清單
  const cols = (x: { filter: Record<string, unknown> }): unknown =>
    (x.filter['customizeUI'] as Record<string, unknown> | undefined)?.['candPerRow'];
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c);
  await press('ArrowDown');
  const wide = await press('ArrowRight');
  check(
    cols(wide) === 4 && wide.last['showCandidates'] === true,
    `→ 展開成 4 欄（${String(cols(wide))}），視窗仍開著`,
  );
  const right = await press('ArrowRight');
  check(
    cols(right) === undefined && right.last['candidateCursor'] === 1,
    `表格裡 → 移到右邊那一欄（反白 ${String(right.last['candidateCursor'])}）`,
  );
  const left = await press('ArrowLeft');
  check(
    cols(left) === undefined && left.last['candidateCursor'] === 0,
    '表格裡 ← 移回左邊那一欄、不收回',
  );
  check(cols(await press('Tab')) === undefined, 'Tab 在表格中不重送欄數');
  const narrow = await press('ArrowLeft');
  check(
    cols(narrow) === 1 &&
      narrow.last['showCandidates'] === true &&
      narrow.last['candidateCursor'] === 0,
    '最左欄按 ← 收回成一欄',
  );
  await press('Tab');
  await press('Escape'); // 關視窗
  check(cols(await press('ArrowDown')) === 1, '視窗關掉後再開，回到一欄');
  await press('Escape');
  await press('Escape');

  // 表格一頁 9 列 × 4 欄，每欄由上往下 1–9（DLL 逐列畫，所以第一列是每欄的第 1 個）；
  // 反白走過本頁最後一個就翻頁；數字（含數字鍵盤）選反白那一欄的第 n 個
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c);
  const opened = await press('ArrowDown');
  const list9 = opened.last['candidateList'] as string[];
  check(
    opened.last['setSelKeys'] === '123456789',
    `清單標籤 1–9（${String(opened.last['setSelKeys'])}）`,
  );
  const tab = await press('ArrowRight');
  const table = tab.last['candidateList'] as string[];
  check(
    list9.length === 9 &&
      table.length > 27 &&
      table.length <= 36 &&
      String(tab.last['setSelKeys']).startsWith('11112222'),
    `表格一頁 ${table.length} 個、第一列標籤 ${String(tab.last['setSelKeys']).slice(0, 4)}`,
  );
  check(table[0] === list9[0] && table[4] === list9[1], '第一欄由上往下是清單的順序');
  let walk = tab;
  for (let i = 0; i < 9; i++) walk = await press('ArrowDown');
  check(
    walk.last['candidateCursor'] === 1,
    `↓ 走過第一欄最後一個到第二欄頂端（${String(walk.last['candidateCursor'])}）`,
  );
  const col2 = await press('Numpad1');
  check(col2.last['compositionString'] === table[1], `數字鍵盤 1 選第二欄第一個（${table[1]}）`);
  await press('Escape');
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c);
  await press('ArrowDown');
  const full = (await press('ArrowRight')).last['candidateList'] as string[];
  if (full.length === 36) {
    let t = await press('ArrowDown');
    for (let i = 1; i < 36; i++) t = await press('ArrowDown');
    const next = t.last['candidateList'] as string[];
    check(t.last['candidateCursor'] === 0 && next[0] !== full[0], '反白走過第 36 個就翻到下一頁');
  }
  await press('Escape');
  await press('Escape');
  // 數字鍵盤：組字中當原樣數字插進去；沒在組字就放行
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c);
  const num = await press('Numpad5');
  check(num.eaten && String(num.last['compositionString']).endsWith('5'), '組字中數字鍵盤打出數字');
  for (const c of [
    'NumpadAdd',
    'NumpadSubtract',
    'NumpadMultiply',
    'NumpadDivide',
    'NumpadDecimal',
  ]) {
    const op = await press(c);
    const ch = String.fromCharCode(keyOf(c)[1]);
    check(
      op.eaten && String(op.last['compositionString']).endsWith(ch),
      `組字中數字鍵盤 ${ch} 打得出來`,
    );
  }
  await press('Escape');
  check(!(await press('Numpad5')).eaten, '沒在組字時數字鍵盤放行');
  check(!(await press('NumpadAdd')).eaten, '沒在組字時數字鍵盤 + 放行');

  // 表格邊界換頁：最右欄 → 到下一頁最左欄，最左欄 ← 回上一頁最右欄；只有第一頁最左欄的 ← 收回
  for (const c of ['KeyU', 'Digit4']) await press(c); // ㄧˋ：候選超過一頁
  await press('ArrowDown');
  const p1 = (await press('ArrowRight')).last['candidateList'] as string[];
  check(p1.length === 36, `ㄧˋ 第一頁滿 36 個（${p1.length}）`);
  for (let i = 0; i < 3; i++) await press('ArrowRight');
  const p2 = await press('ArrowRight');
  check(
    p2.last['candidateCursor'] === 0 && (p2.last['candidateList'] as string[])[0] !== p1[0],
    '最右欄再 → 到下一頁最左欄',
  );
  const back = await press('ArrowLeft');
  check(
    back.last['candidateCursor'] === 3 &&
      (back.last['candidateList'] as string[])[0] === p1[0] &&
      cols(back) === undefined,
    `下一頁最左欄 ← 回上一頁最右欄（反白 ${String(back.last['candidateCursor'])}）`,
  );
  for (let i = 0; i < 3; i++) await press('ArrowLeft');
  check(cols(await press('ArrowLeft')) === 1, '第一頁最左欄 ← 收回成一欄');
  await press('Escape');
  await press('Escape');

  // 每個程式各有一份 DLL：程式 A 展開過表格，程式 B 啟用後，A 再開清單仍要送 1 欄（2026-10-21 清單變成橫的 1×9）
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c);
  await press('ArrowDown');
  await press('ArrowRight');
  // 表格開著時點到別處：組字被系統結束，A 的 DLL 停在 4 欄
  await call({ method: 'onCompositionTerminated', forced: true });
  client = 'bench2';
  await call({ method: 'onActivate', isKeyboardOpen: true });
  client = 'bench';
  const sent: unknown[] = [];
  for (const c of ['KeyS', 'KeyU', 'Digit3', 'ArrowDown']) {
    const x = await press(c);
    sent.push(cols(x));
    if (c === 'Digit3')
      check(x.last['compositionString'] !== '', '組字被系統結束後，接著打的注音照常進組字區');
  }
  check(
    sent.filter((x) => x !== undefined).at(-1) === 1,
    `別的程式啟用後，這個程式開清單仍收回成 1 欄（送了 ${JSON.stringify(sent)}）`,
  );
  await press('Escape');
  await press('Escape');
  await press('Escape');
  await press('Escape');

  // Ctrl+V 等組合鍵：單按 Ctrl 不動組字；按 V 時先送出組字（含開著的選字視窗），按鍵交給應用程式
  for (const c of ['KeyS', 'KeyU', 'Digit3']) await press(c);
  await press('ArrowDown');
  keyStates[0x11] = 0x80;
  const ctrl = await press('ControlLeft');
  check(!ctrl.eaten, '組字中單按 Ctrl 放行、不送出');
  const paste = await press('KeyV', '\x16');
  check(
    paste.last['return'] === false &&
      paste.out.length === 1 &&
      paste.last['compositionString'] === '' &&
      paste.last['showCandidates'] === false,
    `組字中 Ctrl+V：先送出「${paste.out}」，再交給應用程式`,
  );
  check(!(await press('KeyV', '\x16')).eaten, '沒在組字時 Ctrl+V 放行');
  keyStates[0x11] = 0;
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
const layout = (process.env['ZHUYIN_LAYOUT'] ?? 'dachen') as LayoutName;
if (!(layout in LAYOUT_KEYS)) throw new Error(`沒有這個排列：${layout}`);
if (which === 'zhuyin') {
  // 右鍵選單「鍵盤排列」子選單：id 10＋LAYOUT_KEYS 的順序（同 native/src/keymap.rs LAYOUTS）
  const items = (await call({ method: 'onMenu', id: 'windows-mode-icon' }))['return'] as Array<{
    submenu?: Array<{ id: number; checked?: boolean }>;
  }>;
  const sub = items.find((i) => i.submenu)?.submenu ?? [];
  if (sub.length !== 5 || !sub[0]!.checked) throw new Error('右鍵選單：鍵盤排列子選單、預設大千');
  const id = 10 + Object.keys(LAYOUT_KEYS).indexOf(layout);
  await call({ method: 'onCommand', id, type: 2 });
  if (!readFileSync(configFile, 'utf8').includes(`"layout": "${layout}"`))
    throw new Error(`config.json 沒寫入 layout ${layout}`);
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
  for (const code of s.syllables.flatMap((syl) => syllableToKeyCodes(syl, layout))) {
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
  `${which}${layout === 'dachen' ? '' : ` ${layout}`} | ${samples.length} 句 ${lat.length} 鍵 | 句 口語 ${acc('colloquial')} 書面 ${acc('written')} | ` +
    `冷啟動 ${coldMs.toFixed(0)}ms | 每鍵 p50 ${pct(0.5)} p95 ${pct(0.95)} p99 ${pct(0.99)} max ${sorted.at(-1)!.toFixed(2)} ms | ` +
    `Enter ${(commitLat.reduce((a, b) => a + b, 0) / commitLat.length).toFixed(2)}ms | ` +
    `CPU ${((after.cpu - before.cpu) / lat.length).toFixed(2)} ms/鍵 | ` +
    `後端 WS ${after.ws.toFixed(0)}MB private ${after.priv.toFixed(0)}MB peak ${after.peak.toFixed(0)}MB`,
);
for (const f of fails) console.log(`  ✗ ${f}`);
