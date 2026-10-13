import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** 串流下載，帶重試與進度。已存在且大小一致時跳過（以 Content-Length 比對，無法取得時重新下載）。 */
export async function downloadTo(
  url: string,
  dest: string,
  opts: { retries?: number; quiet?: boolean } = {},
): Promise<void> {
  const retries = opts.retries ?? 3;
  await mkdir(path.dirname(dest), { recursive: true });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const head = await fetch(url, { method: 'HEAD' });
      const expected = Number(head.headers.get('content-length') ?? '0');
      if (expected > 0) {
        try {
          const s = await stat(dest);
          if (s.size === expected) {
            if (!opts.quiet) console.log(`[skip] ${dest} (${s.size} bytes)`);
            return;
          }
        } catch {
          /* 不存在，繼續下載 */
        }
      }

      const res = await fetch(url);
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      if (!opts.quiet) {
        console.log(
          `[get ] ${url} -> ${dest}${expected ? ` (${(expected / 1e6).toFixed(1)} MB)` : ''}`,
        );
      }
      let seen = 0;
      let nextLog = 0;
      const withProgress = res.body.pipeThrough(
        new TransformStream({
          transform(chunk, ctrl) {
            seen += chunk.byteLength;
            if (!opts.quiet && seen >= nextLog) {
              process.stdout.write(`\r       ${(seen / 1e6).toFixed(0)} MB`);
              nextLog += 20_000_000;
            }
            ctrl.enqueue(chunk);
          },
        }),
      );
      await pipeline(Readable.fromWeb(withProgress), createWriteStream(dest));
      if (!opts.quiet) process.stdout.write('\n');
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`retry ${attempt}/${retries - 1}: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}
