/**
 * 網頁測試台：瀏覽器送實體鍵盤的 KeyboardEvent.code，伺服器跑 ImeEngine，
 * 解碼結果同步回傳。
 * 開發用：單一引擎實例、只聽 127.0.0.1。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Channel, type DecodePath } from '@zhuyin/core';
import { ImeEngine, type EngineState, type MenuView } from './engine.js';
import { loadRuntime, releaseHeap, saveAdapter } from './runtime.js';

const PAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');

/** 送給瀏覽器的狀態：候選只取前幾名的文字 */
function view(
  st: EngineState,
  cands: DecodePath[],
): {
  composition: string;
  segments: string[];
  candidates: string[];
  cursor: number;
  pending?: string;
  menu?: MenuView;
} {
  return {
    composition: st.composition,
    // 首選的斷詞：頁面逐詞畫底線，看得出詞的邊界（composition 尾端多出的是未完成的注音）
    segments: cands[0]?.words ?? [],
    candidates: cands.slice(0, 8).map((p) => p.words.join('')),
    cursor: st.cursor,
    pending: st.pending,
    menu: st.menu,
  };
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  // ponytail: 本機開發工具，請求體上限 64KB 足夠；邊讀邊檢查，超過就不再收
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 65536) throw new Error('body too large');
  }
  return s ? (JSON.parse(s) as Record<string, unknown>) : {};
}

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export async function startWeb(port: number, l3: boolean): Promise<void> {
  console.log('[web] 載入模型中（約 1 分鐘）…');
  const { decoder, legalSyllables, adapter } = await loadRuntime();
  let idleGc: ReturnType<typeof setTimeout> | undefined;
  let lastKeyAt = 0;

  const engine = new ImeEngine(decoder, legalSyllables, undefined, adapter);
  if (l3) engine.channel = new Channel(legalSyllables);

  // 停打 3 秒才把解碼產生的垃圾 heap 還給系統（打字中做會卡鍵；見 runtime.ts releaseHeap）
  const scheduleGc = (): void => {
    clearTimeout(idleGc);
    idleGc = setTimeout(releaseHeap, 3000);
  };
  // 防 CSRF／DNS rebinding：Host 要是本機位址，POST 要是 JSON（別的網頁送不出不經 CORS 預檢的 JSON）
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const ctype = req.headers['content-type'] ?? '';
        if (
          !hosts.has(req.headers.host ?? '') ||
          (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(ctype))
        ) {
          res.writeHead(403).end();
          return;
        }
        if (req.method === 'GET' && req.url === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(await readFile(PAGE));
        } else if (req.method === 'GET' && req.url === '/hello') {
          json(res, { l3, mode: engine.mode });
        } else if (req.method === 'POST' && req.url === '/key') {
          const b = await body(req);
          const code = String(b['code'] ?? '');
          const key = typeof b['key'] === 'string' ? b['key'] : undefined;
          lastKeyAt = performance.now();
          scheduleGc();
          const was = engine.syllableSequence.length > 0;
          const st = engine.onKey({ code, key, timestampMs: lastKeyAt });
          const ms = performance.now() - lastKeyAt;
          // 英文模式下打空白／標點會整段送出組字區（有學習）→ 存檔
          if (was && st.text) saveAdapter(adapter).catch(() => {});
          json(res, {
            ...view(st, engine.getCandidates()),
            legal: st.lastLegal,
            text: st.text,
            ms: Math.round(ms),
          });
        } else if (req.method === 'GET' && req.url === '/stats') {
          const m = process.memoryUsage();
          json(res, { rss: m.rss, heap: m.heapUsed, uptime: Math.round(process.uptime()) });
        } else if (req.method === 'POST' && req.url === '/mode') {
          const st = engine.toggleMode();
          scheduleGc();
          // 切到英文會丟掉打到一半的注音：回傳狀態讓頁面重畫組字區
          json(res, { ...view(st, engine.getCandidates()), mode: engine.mode });
        } else if (req.method === 'POST' && req.url === '/commit') {
          const k = Number((await body(req))['k'] ?? 0);
          const text = engine.commit(Number.isInteger(k) && k >= 0 ? k : 0);
          scheduleGc();
          saveAdapter(adapter).catch(() => {});
          json(res, { text });
        } else {
          res.writeHead(404).end();
        }
      } catch (e) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end((e as Error).message);
      }
    })();
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[web] http://127.0.0.1:${port}  （L3：${l3 ? '開' : '關'}）`);
  });
}
