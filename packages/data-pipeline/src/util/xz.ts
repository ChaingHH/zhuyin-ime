import { execFile } from 'node:child_process';
import { stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * 解壓 .xz → 單一輸出檔。
 * 使用 Python 標準庫 lzma（Windows 的 bsdtar 對本源檔案解不出，Python 3.x 皆內建）。
 * 可用環境變數 ZHUYIN_PYTHON 指定直譯器。
 */
export async function extractXz(srcXz: string, destFile: string): Promise<void> {
  const py = process.env['ZHUYIN_PYTHON'] ?? 'python';
  try {
    await execFileP(py, [
      '-c',
      'import lzma,sys; open(sys.argv[2],"wb").write(lzma.open(sys.argv[1]).read())',
      srcXz,
      destFile,
    ]);
  } catch (err) {
    throw new Error(
      `xz 解壓失敗（需要 Python 3，或以 ZHUYIN_PYTHON 指定）：${(err as Error).message}`,
    );
  }
  const s = await stat(destFile);
  if (s.size === 0) throw new Error(`解壓產物為空：${destFile}`);
}

/** 確保單檔存在；不存在時執行 provided 下載器。 */
export async function ensureFile(file: string, producer: () => Promise<void>) {
  try {
    await stat(file);
    return file;
  } catch {
    await rm(path.dirname(file), { recursive: true, force: true }).catch(() => {});
    await producer();
    await stat(file);
    return file;
  }
}
