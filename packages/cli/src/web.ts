/**
 * 網頁測試台：瀏覽器送實體鍵盤的 KeyboardEvent.code，伺服器跑 ImeEngine，
 * L5 結果同步回傳、L6 非同步替換以 Server-Sent Events 推送。
 * 開發用：單一引擎實例、只聽 127.0.0.1。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Channel, type DecodePath } from '@zhuyin/core';
import { ImeEngine, type EngineState, type MenuView } from './engine.js';
import { loadRuntime, saveAdapter } from './runtime.js';

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
  for await (const chunk of req) s += chunk;
  // ponytail: 本機開發工具，請求體上限 64KB 足夠
  if (s.length > 65536) throw new Error('body too large');
  return s ? (JSON.parse(s) as Record<string, unknown>) : {};
}

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/** L6 重排器：關閉、BERT PLL、Kev（Qwen3.5-4B 微調，需另開伺服器） */
export type L6Mode = 'off' | 'bert' | 'kev';
const L6_MODES: readonly L6Mode[] = ['off', 'bert', 'kev'];

export async function startWeb(port: number, initialL6: L6Mode, l3: boolean): Promise<void> {
  console.log('[web] 載入模型中（約 1 分鐘）…');
  const { decoder, legalSyllables, adapter, lm } = await loadRuntime();
  const clients = new Set<ServerResponse>();
  const push = (data: unknown): void => {
    for (const c of clients) c.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  let lastKeyAt = 0;

  // 重排器第一次選到才載入，之後留著：BERT worker 載入要數秒，來回切換不重載
  type RerankFn = (paths: DecodePath[]) => Promise<DecodePath[]>;
  const loaded = new Map<L6Mode, Promise<RerankFn>>();
  const loaders: Record<Exclude<L6Mode, 'off'>, () => Promise<RerankFn>> = {
    bert: async () => {
      const { RerankWorker } = await import('@zhuyin/rerank');
      // BERT 放背景執行緒：在主執行緒跑會卡住事件迴圈，重排期間的按鍵要排隊
      const rr = await RerankWorker.create({
        weight: 0.5,
        maxCandidates: 16,
        gapThreshold: 6,
        flipMargin: 0.75,
        charCounts: Object.fromEntries(lm.char.uni),
      });
      return (paths) => rr.rerank(paths);
    },
    kev: async () => {
      const { KevReranker } = await import('@zhuyin/rerank');
      const kev = new KevReranker({ url: process.env['KEV_URL'] });
      // 先打一次確認伺服器在：沒開的話切換直接失敗，而不是之後每個音節默默報錯
      const probe = (w: string): DecodePath => ({ words: [w], score: 0, breakdown: [] });
      await kev.rerank([probe('今天'), probe('金天')]);
      return async (paths) => (await kev.rerank(paths)).paths;
    },
  };
  let l6: L6Mode = 'off';
  const engine = new ImeEngine(decoder, legalSyllables, undefined, adapter);
  if (l3) engine.channel = new Channel(legalSyllables);

  async function setL6(mode: L6Mode): Promise<void> {
    if (mode === 'off') {
      engine.setRerankHooks(undefined);
      l6 = mode;
      return;
    }
    let p = loaded.get(mode);
    if (!p) {
      p = loaders[mode]();
      loaded.set(mode, p);
      // 載入失敗不快取，伺服器開好後可以再試
      p.catch(() => loaded.delete(mode));
    }
    const rerank = await p;
    engine.setRerankHooks({
      rerank: (paths) =>
        rerank(paths).catch((e: Error) => {
          // 引擎會吞掉 L6 錯誤（不影響 L5 畫面）；測試台要看得到
          console.error(`[L6 ${mode} 錯誤]`, e.message);
          throw e;
        }),
      onUpdate: (st) =>
        push({
          type: 'L6',
          ...view(st, st.candidates),
          ms: Math.round(performance.now() - lastKeyAt),
        }),
    });
    l6 = mode;
  }
  try {
    await setL6(initialL6);
  } catch (e) {
    console.error(`[web] L6=${initialL6} 載入失敗，改為關閉：${(e as Error).message}`);
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === 'GET' && req.url === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(await readFile(PAGE));
        } else if (req.method === 'GET' && req.url === '/events') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.write(`data: ${JSON.stringify({ type: 'hello', l6, l3, mode: engine.mode })}\n\n`);
          clients.add(res);
          req.on('close', () => clients.delete(res));
        } else if (req.method === 'POST' && req.url === '/key') {
          const b = await body(req);
          const code = String(b['code'] ?? '');
          const key = typeof b['key'] === 'string' ? b['key'] : undefined;
          lastKeyAt = performance.now();
          const st = engine.onKey({ code, key, timestampMs: lastKeyAt });
          const ms = performance.now() - lastKeyAt;
          // 注音模式下打標點會先送出組字區（有學習）→ 存檔
          if (st.text && engine.mode === 'zhuyin') saveAdapter(adapter).catch(() => {});
          json(res, {
            ...view(st, engine.getCandidates()),
            legal: st.lastLegal,
            text: st.text,
            ms: Math.round(ms),
          });
        } else if (req.method === 'GET' && req.url === '/stats') {
          const m = process.memoryUsage();
          json(res, { rss: m.rss, heap: m.heapUsed, uptime: Math.round(process.uptime()) });
        } else if (req.method === 'POST' && req.url === '/l6') {
          const mode = (await body(req))['mode'] as L6Mode;
          if (!L6_MODES.includes(mode)) throw new Error(`未知的 L6：${String(mode)}`);
          const t0 = performance.now();
          await setL6(mode);
          console.log(`[web] L6 → ${mode}（${Math.round(performance.now() - t0)}ms）`);
          json(res, { l6 });
        } else if (req.method === 'POST' && req.url === '/mode') {
          const text = engine.toggleMode();
          if (text) saveAdapter(adapter).catch(() => {});
          json(res, { mode: engine.mode, text });
        } else if (req.method === 'POST' && req.url === '/commit') {
          const k = Number((await body(req))['k'] ?? 0);
          const text = engine.commit(Number.isInteger(k) && k >= 0 ? k : 0);
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
    console.log(`[web] http://127.0.0.1:${port}  （L6：${l6}，L3：${l3 ? '開' : '關'}）`);
  });
}
