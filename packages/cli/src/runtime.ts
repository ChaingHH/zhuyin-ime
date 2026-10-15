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
import { LanguageModel } from '@zhuyin/lm';
import { fileURLToPath } from 'node:url';

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

export async function loadRuntime(
  opts: {
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
  } = {},
): Promise<LoadedRuntime> {
  // ZHUYIN_LM 可指定模型檔；預設優先用 train.ts 的 .tsv 輸出，否則退回舊 .json
  const models = path.join(REPO, 'data', 'models');
  const lmFile =
    process.env['ZHUYIN_LM'] ??
    (existsSync(path.join(models, 'lm.tsv'))
      ? path.join(models, 'lm.tsv')
      : path.join(models, 'lm.json'));
  const lexFile = path.join(REPO, 'data', 'processed', 'lexicon.jsonl');
  const sylFile = path.join(REPO, 'data', 'processed', 'syllables.json');

  const [lm, lexRaw, sylRaw] = await Promise.all([
    LanguageModel.load(lmFile, {
      minBi: Number(process.env['ZHUYIN_LM_MIN_BI'] ?? 2),
      minTri: Number(process.env['ZHUYIN_LM_MIN_TRI'] ?? 3),
      quant: Number(process.env['ZHUYIN_LM_QUANT'] ?? 8) as 0 | 8 | 16,
    }),
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
