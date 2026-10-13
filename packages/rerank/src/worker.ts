/**
 * L6 背景執行緒：BERT 推論會完整佔住所在執行緒（實測每次重排卡住事件迴圈 110–640ms），
 * 放在主執行緒會讓重排期間的按鍵排隊。這裡把 PllReranker 包進 worker_threads。
 *
 * 主執行緒用 RerankWorker；本檔同時是 worker 的進入點（isMainThread=false 時）。
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { DecodePath } from '@zhuyin/core';
import { PllReranker, type RerankerOptions } from './reranker.js';

/** 可跨執行緒傳遞的選項：函式不能傳，字頻改傳表 */
export type WorkerRerankerOptions = Omit<RerankerOptions, 'charFreq' | 'polySingle'> & {
  charCounts?: Record<string, number>;
};

type Reply = { id: number; paths?: DecodePath[]; error?: string } | { ready: true };

export class RerankWorker {
  private readonly worker: Worker;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (p: DecodePath[]) => void; reject: (e: Error) => void }
  >();

  private constructor(opts: WorkerRerankerOptions) {
    this.worker = new Worker(new URL(import.meta.url), { workerData: opts });
    this.worker.on('message', (m: Reply) => {
      if ('ready' in m) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error !== undefined) p.reject(new Error(m.error));
      else p.resolve(m.paths!);
    });
    this.worker.on('error', (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
  }

  /** 啟動 worker 並等 BERT 載入完成。 */
  static async create(opts: WorkerRerankerOptions = {}): Promise<RerankWorker> {
    const w = new RerankWorker(opts);
    await new Promise<void>((resolve, reject) => {
      const onMsg = (m: Reply): void => {
        if ('ready' in m) {
          w.worker.off('message', onMsg);
          resolve();
        }
      };
      w.worker.on('message', onMsg);
      w.worker.once('error', reject);
    });
    return w;
  }

  /** 回傳重排後的 N-best（L6 首選在前）。 */
  rerank(paths: readonly DecodePath[]): Promise<DecodePath[]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, paths });
    });
  }

  terminate(): Promise<number> {
    return this.worker.terminate();
  }
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  const { charCounts, ...opts } = workerData as WorkerRerankerOptions;
  const counts = new Map(Object.entries(charCounts ?? {}));
  const rr = await PllReranker.create({
    ...opts,
    charFreq: charCounts ? (ch) => counts.get(ch) ?? 0 : undefined,
  });
  port.on('message', (m: { id: number; paths: DecodePath[] }) => {
    rr.rerank(m.paths).then(
      (r) => port.postMessage({ id: m.id, paths: r.paths }),
      (e: Error) => port.postMessage({ id: m.id, error: e.message }),
    );
  });
  port.postMessage({ ready: true });
}
