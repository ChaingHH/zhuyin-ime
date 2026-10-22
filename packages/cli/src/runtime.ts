import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  Decoder,
  isTraditionalWord,
  LexiconIndex,
  NONTRAD_SINCE,
  UserAdapter,
  type LexiconEntry,
  type Scorer,
  type UserAdapterData,
} from '@zhuyin/core';
import { BackoffLM, LanguageModel, LM_ENV_KEYS, lmOptionsFromEnv } from '@zhuyin/lm';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(thisDir, '..', '..', '..');
export const USER_DIR = path.join(REPO, 'data', 'user');
const ADAPTER_FILE = path.join(USER_DIR, 'adapter.json');

export interface LoadedRuntime {
  decoder: Decoder;
  legalSyllables: Set<string>;
  /** 預設是退回式模型（lm.bo.bin）；基線與 IDF 需要計數，會改載入計數模型 */
  lm: LanguageModel | BackoffLM;
  adapter: UserAdapter;
}

export type RuntimeOptions = {
  a?: number;
  gamma?: number;
  beamWidth?: number;
  idfBonus?: number;
  baseline?: 'classic' | 'bigram';
  /** 不載入 data/user/adapter.json（評測用：數字不受使用者學習影響） */
  noUser?: boolean;
};

export async function loadRuntime(opts: RuntimeOptions = {}): Promise<LoadedRuntime> {
  const rt = await buildRuntime(opts);
  // 在 buildRuntime 的區域變數（詞典原文、解析出的詞條）都離開作用域之後才做，否則回收不到
  releaseHeap();
  return rt;
}

async function buildRuntime(opts: RuntimeOptions): Promise<LoadedRuntime> {
  // ZHUYIN_LM 可指定模型檔。預設依序找：shrink.ts 打包的退回式模型 lm.bo.bin、pack.ts 的計數模型
  // lm.bin、train.ts 的 lm.tsv。有設剪枝／量化環境變數時跳過兩個 .bin（設定在打包時就固定了）；
  // 基線與 IDF 要讀計數，跳過 lm.bo.bin。
  const models = path.join(REPO, 'data', 'models');
  const custom = LM_ENV_KEYS.some((k) => process.env[k] !== undefined);
  const needCounts = opts.baseline !== undefined || (opts.idfBonus ?? 0) > 0;
  const lmFile =
    process.env['ZHUYIN_LM'] ??
    [...(custom || needCounts ? [] : ['lm.bo.bin']), ...(custom ? [] : ['lm.bin']), 'lm.tsv']
      .map((f) => path.join(models, f))
      .find((f) => existsSync(f)) ??
    path.join(models, 'lm.tsv');
  const sylFile = path.join(REPO, 'data', 'processed', 'syllables.json');

  const [lm, lexicon, sylRaw] = await Promise.all([
    lmFile.endsWith('.bo.bin')
      ? BackoffLM.load(lmFile)
      : LanguageModel.load(lmFile, lmOptionsFromEnv(process.env)),
    loadLexicon(),
    readFile(sylFile, 'utf8'),
  ]);
  const legalSyllables = new Set((JSON.parse(sylRaw) as { syllables: string[] }).syllables);

  const decoder = makeDecoder(lm, opts);
  decoder.useLexicon(lexicon);
  const adapter = opts.noUser ? new UserAdapter() : await loadAdapter();
  // 使用者詞條（手動造詞＋歷史挖詞）注入解碼格
  for (const e of adapter.drainPendingEntries()) {
    decoder.addEntry(e);
  }
  return { decoder, legalSyllables, lm, adapter };
}

/**
 * 詞典索引：lexicon.bin 比 lexicon.jsonl 新就直接讀（不必解析 JSONL，也沒有解析時約 200MB 的暫時物件）；
 * 否則從 JSONL 建、順手寫出 lexicon.bin。沒有 JSONL 時直接讀 bin；bin 壞掉（截斷、格式不符）就從 JSONL 重建。
 */
async function loadLexicon(): Promise<LexiconIndex> {
  const dir = path.join(REPO, 'data', 'processed');
  const jsonl = path.join(dir, 'lexicon.jsonl');
  const bin = path.join(dir, 'lexicon.bin');
  const hasJsonl = existsSync(jsonl);
  // 字表（NONTRAD_SINCE）比 bin 新：bin 是舊規則建的，要重建
  const binMs = existsSync(bin) ? statSync(bin).mtimeMs : -1;
  if (binMs >= 0 && (!hasJsonl || (binMs >= statSync(jsonl).mtimeMs && binMs >= NONTRAD_SINCE))) {
    try {
      return LexiconIndex.fromBytes(await readFile(bin));
    } catch (e) {
      if (!hasJsonl) throw e;
      console.warn(`[lexicon] ${bin} 讀取失敗，從 lexicon.jsonl 重建：${(e as Error).message}`);
    }
  }
  const entries = (await readFile(jsonl, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LexiconEntry)
    // 舊的 lexicon.jsonl 可能還有非台灣繁體字的詞（data-pipeline 現在建詞典時就擋）
    .filter((e) => isTraditionalWord(e.word));
  const decoder = new Decoder({ wordLogProb: () => 0, charSequenceLogProb: () => 0 });
  decoder.loadLexicon(entries);
  // 先寫暫存檔再改名：中斷或兩個行程同時建，都不會留下 mtime 較新的截斷檔
  const tmp = `${bin}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, decoder.lexicon.toBytes());
    await rename(tmp, bin);
  } catch (e) {
    // 只是快取：寫不出來下次再建，不影響這次載入
    console.warn(`[lexicon] 寫 ${bin} 失敗：${(e as Error).message}`);
    await unlink(tmp).catch(() => {});
  }
  return decoder.lexicon;
}

function makeDecoder(lm: LanguageModel | BackoffLM, opts: RuntimeOptions): Decoder {
  if (lm instanceof BackoffLM) {
    if (opts.baseline || (opts.idfBonus ?? 0) > 0)
      throw new Error('基線與 IDF 需要計數模型：用 ZHUYIN_LM 指定 lm.bin 或 lm.tsv');
    return new Decoder(lm, { a: opts.a, gamma: opts.gamma, beamWidth: opts.beamWidth });
  }
  // 稀有字 IDF：以字 unigram 總量正規化
  let totalChars = 0;
  for (const v of lm.char.uni.values()) totalChars += v;
  const charIdf = (ch: string): number =>
    Math.log(1 + totalChars / ((lm.char.uni.get(ch) ?? 0) + 1));

  // 基線重現（同格比較用）：
  // classic = libchewing 式：純詞頻 unigram
  // bigram  = McBopomofo 式：unigram + bigram，無 trigram、無字級專家
  let scorer: Scorer = lm;
  console.log(`[baseline] mode=${opts.baseline ?? 'full'}`);
  if (opts.baseline === 'classic') {
    scorer = {
      wordLogProb: (w) => Math.log(((lm.word.uni.get(w) ?? 0) + 1) / (lm.word.total + 1)),
      charSequenceLogProb: () => 0,
    };
  } else if (opts.baseline === 'bigram') {
    scorer = {
      wordLogProb: (w, _w1, w2) => {
        const bi = lm.word.bi.get(`${w2} ${w}`);
        if (bi > 0 && lm.word.uni.has(w)) {
          return Math.log(0.4 * (bi / (lm.word.biTotals.get(w2) ?? 1)));
        }
        return Math.log((0.4 * ((lm.word.uni.get(w) ?? 0) + 1)) / (lm.word.total + 1));
      },
      charSequenceLogProb: () => 0,
    };
  }

  return new Decoder(scorer, {
    a: opts.a,
    gamma: opts.gamma,
    beamWidth: opts.beamWidth,
    idfBonus: opts.idfBonus,
    charIdf,
  });
}

/**
 * 解析詞典等載入步驟會產生大量暫時物件；回收後 V8 不會主動把空出的 heap 頁還給系統
 * （實測 RSS 多約 150MB）。載入完做一次壓縮式（last-resort）GC 把它們還回去。
 * 解碼也一樣：打 300 句後 heap 撐到約 490MB、存活只有約 80MB；常駐的引擎宿主應在閒置時呼叫。
 */
let gcFn: ((o: object) => void) | undefined;
export function releaseHeap(): void {
  if (!gcFn) {
    v8.setFlagsFromString('--expose-gc');
    gcFn = vm.runInNewContext('gc') as (o: object) => void;
  }
  gcFn({ type: 'major', execution: 'sync', flavor: 'last-resort' });
}

async function loadAdapter(): Promise<UserAdapter> {
  // 和其他輸入法對比時不帶使用者學習資料
  if (process.env['ZHUYIN_NO_USER']) return new UserAdapter();
  let raw: string;
  try {
    raw = await readFile(ADAPTER_FILE, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new UserAdapter();
    throw e; // 讀不到但檔案在：不能當空的，否則下次存檔會蓋掉學習資料
  }
  try {
    return UserAdapter.fromJSON(JSON.parse(raw) as UserAdapterData);
  } catch (e) {
    // 壞檔先改名保留，再從空的開始；不改名的話下次存檔就把它蓋掉了
    const bad = `${ADAPTER_FILE}.bad`;
    await rename(ADAPTER_FILE, bad);
    console.warn(`[x2] adapter.json 解析失敗，已改名為 ${bad}：${(e as Error).message}`);
    return new UserAdapter();
  }
}

/** 存檔串成一條：一次只寫一個，後到的存檔寫的是它執行當下的狀態 */
let saveChain: Promise<void> = Promise.resolve();

export function saveAdapter(a: UserAdapter): Promise<void> {
  const next = saveChain.then(async () => {
    await mkdir(USER_DIR, { recursive: true });
    // 先寫暫存檔再改名：寫到一半當掉不會留下截斷的 adapter.json
    const tmp = `${ADAPTER_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(a.toJSON()), 'utf8');
    await rename(tmp, ADAPTER_FILE);
  });
  saveChain = next.catch(() => {});
  return next;
}

export interface EvalSample {
  text: string;
  tokens: string[];
  syllables: string[];
}

export async function loadEvalSamples(file: string): Promise<EvalSample[]> {
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  return lines.slice(1).map((l) => JSON.parse(l) as EvalSample);
}
