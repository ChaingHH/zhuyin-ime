import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  Decoder,
  UserAdapter,
  type LexiconEntry,
  type Scorer,
  type UserAdapterData,
} from '@zhuyin/core';
import { LanguageModel, LM_ENV_KEYS, lmOptionsFromEnv } from '@zhuyin/lm';
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
  lm: LanguageModel;
  adapter: UserAdapter;
  polySingleChars: ReadonlySet<string>;
}

export type RuntimeOptions = {
  a?: number;
  gamma?: number;
  beamWidth?: number;
  rerank?: {
    weight?: number;
    gapThreshold?: number;
    maxCandidates?: number;
    flipMargin?: number;
  };
  idfBonus?: number;
  baseline?: 'classic' | 'bigram';
};

export async function loadRuntime(opts: RuntimeOptions = {}): Promise<LoadedRuntime> {
  const rt = await buildRuntime(opts);
  // 在 buildRuntime 的區域變數（詞典原文、解析出的詞條）都離開作用域之後才做，否則回收不到
  releaseHeap();
  return rt;
}

async function buildRuntime(opts: RuntimeOptions): Promise<LoadedRuntime> {
  // ZHUYIN_LM 可指定模型檔；預設優先用 pack.ts 打包的 .bin（已剪枝量化），其次 train.ts 的
  // .tsv，最後舊 .json。有設剪枝／量化環境變數時跳過 .bin（bin 的設定在打包時就固定了）。
  const models = path.join(REPO, 'data', 'models');
  const custom = LM_ENV_KEYS.some((k) => process.env[k] !== undefined);
  const lmFile =
    process.env['ZHUYIN_LM'] ??
    [...(custom ? [] : ['lm.bin']), 'lm.tsv', 'lm.json']
      .map((f) => path.join(models, f))
      .find((f) => existsSync(f)) ??
    path.join(models, 'lm.json');
  const lexFile = path.join(REPO, 'data', 'processed', 'lexicon.jsonl');
  const sylFile = path.join(REPO, 'data', 'processed', 'syllables.json');

  const [lm, lexRaw, sylRaw] = await Promise.all([
    LanguageModel.load(lmFile, lmOptionsFromEnv(process.env)),
    readFile(lexFile, 'utf8'),
    readFile(sylFile, 'utf8'),
  ]);
  const entries = (lexRaw.split('\n').filter(Boolean) as string[]).map(
    (l) => JSON.parse(l) as LexiconEntry,
  );
  const legalSyllables = new Set((JSON.parse(sylRaw) as { syllables: string[] }).syllables);

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

  const decoder = new Decoder(scorer, {
    a: opts.a,
    gamma: opts.gamma,
    beamWidth: opts.beamWidth,
    idfBonus: opts.idfBonus,
    charIdf,
  });
  decoder.loadLexicon(entries);

  const adapter = await loadAdapter();
  // 使用者詞條（手動造詞＋歷史挖詞）注入解碼格
  for (const e of adapter.drainPendingEntries()) {
    decoder.addEntry(e);
  }

  return { decoder, legalSyllables, lm, adapter, polySingleChars: decoder.polySingleChars };
}

/**
 * 解析詞典等載入步驟會產生大量暫時物件；回收後 V8 不會主動把空出的 heap 頁還給系統
 * （實測 RSS 多約 150MB）。載入完做一次壓縮式（last-resort）GC 把它們還回去。
 * 解碼也一樣：打 300 句後 heap 撐到約 490MB、存活只有約 80MB；常駐的引擎宿主應在閒置時呼叫。
 */
export function releaseHeap(): void {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as (o: object) => void;
  gc({ type: 'major', execution: 'sync', flavor: 'last-resort' });
}

async function loadAdapter(): Promise<UserAdapter> {
  // 和其他輸入法對比時不帶使用者學習資料
  if (process.env['ZHUYIN_NO_USER']) return new UserAdapter();
  try {
    const raw = JSON.parse(await readFile(ADAPTER_FILE, 'utf8')) as UserAdapterData;
    return UserAdapter.fromJSON(raw);
  } catch {
    return new UserAdapter();
  }
}

export async function saveAdapter(a: UserAdapter): Promise<void> {
  await mkdir(USER_DIR, { recursive: true });
  await writeFile(ADAPTER_FILE, JSON.stringify(a.toJSON()), 'utf8');
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
