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
import type { DecodePath } from '@zhuyin/core';
import { ImeEngine, type EngineState, type RerankHooks } from './engine.js';
import { loadRuntime, saveAdapter } from './runtime.js';

const PAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');

/** 送給瀏覽器的狀態：候選只取前幾名的文字 */
function view(st: EngineState, cands: DecodePath[]): { composition: string; candidates: string[] } {
  return {
    composition: st.composition,
    candidates: cands.slice(0, 8).map((p) => p.words.join('')),
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

export async function startWeb(port: number, rerank: boolean): Promise<void> {
  console.log('[web] 載入模型中（約 1 分鐘）…');
  const { decoder, legalSyllables, adapter, lm } = await loadRuntime();
  const clients = new Set<ServerResponse>();
  const push = (data: unknown): void => {
    for (const c of clients) c.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  let lastKeyAt = 0;

  let hooks: RerankHooks | undefined;
  if (rerank) {
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
      rerank: (paths) =>
        rr.rerank(paths).catch((e: Error) => {
          // 引擎會吞掉 L6 錯誤（不影響 L5 畫面）；測試台要看得到
          console.error('[L6 錯誤]', e.message);
          throw e;
        }),
      onUpdate: (st) =>
        push({
          type: 'L6',
          ...view(st, st.candidates),
          ms: Math.round(performance.now() - lastKeyAt),
        }),
    };
  }
  const engine = new ImeEngine(decoder, legalSyllables, undefined, adapter, hooks);

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
          res.write(`data: ${JSON.stringify({ type: 'hello', rerank })}\n\n`);
          clients.add(res);
          req.on('close', () => clients.delete(res));
        } else if (req.method === 'POST' && req.url === '/key') {
          const code = String((await body(req))['code'] ?? '');
          lastKeyAt = performance.now();
          const st = engine.onKey({ code, timestampMs: lastKeyAt });
          const ms = performance.now() - lastKeyAt;
          json(res, {
            ...view(st, engine.getCandidates()),
            legal: st.lastLegal,
            ms: Math.round(ms),
          });
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
    console.log(`[web] http://127.0.0.1:${port}  （重排：${rerank ? '開' : '關'}）`);
  });
}
