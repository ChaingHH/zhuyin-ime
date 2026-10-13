import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { PATHS, SOURCES } from '../config.js';
import { downloadTo } from '../util/download.js';

const PTT_RAW = path.join(PATHS.raw, 'ptt', 'ppt_pretrain.json');

/** 下載（或略過已存在的）PTT 原始檔。 */
export async function ensurePttRaw(): Promise<string> {
  try {
    await readFile(PTT_RAW);
    return PTT_RAW;
  } catch {
    await downloadTo(SOURCES.ptt.url, PTT_RAW);
    return PTT_RAW;
  }
}

/**
 * 串流迭代 PTT 文本。檔案為 pretty-printed JSON array，
 * 每個 "text" 值佔單行——逐行掃描避免把 810MB 載入記憶體。
 */
export async function* iterPttTexts(file: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const m = line.match(/^\s*"text"\s*:\s*"(.*)",?\s*$/);
      if (!m) continue;
      try {
        yield JSON.parse(`"${m[1]}"`) as string;
      } catch {
        /* 跳過無法反序列化的行 */
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * 以 HF datasets-server rows API 抽樣維基百科條目（書面域）。
 * 零 parquet 依賴；每頁最多 100 列。
 */
export async function fetchWikiTexts(
  targetDocs: number,
  opts: { config?: string; pageSize?: number } = {},
): Promise<string[]> {
  const config = opts.config ?? '20231101.zh';
  const page = opts.pageSize ?? 100;
  const out: string[] = [];
  for (let offset = 0; out.length < targetDocs; offset += page) {
    const url =
      `https://datasets-server.huggingface.co/rows?dataset=wikimedia%2Fwikipedia` +
      `&config=${config}&split=train&offset=${offset}&length=${page}`;
    let rows: { row?: { text?: string } }[] = [];
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        rows?: { row?: { text?: string } }[];
      };
      rows = json.rows ?? [];
    } catch (err) {
      // 節流/逾時不致命：保留已取得的部分
      console.warn(`[wiki] offset=${offset} 取得失敗（${(err as Error).message}），以此為止`);
      break;
    }
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.row?.text) out.push(r.row.text);
    }
    console.log(`[wiki] offset=${offset} 累積 ${out.length}/${targetDocs}`);
    await new Promise((r2) => setTimeout(r2, 300));
  }
  return out;
}
