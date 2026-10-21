// 長專有名詞的使用者造詞：逐字選字打出詞典沒有的名字並送出，量第幾次送出後直接打得出來。
//   npx tsx debug-user-name.ts [次數=3]
// 也印「只打名字的前 2、3 個音節」時首選有沒有被拉成名字的一部分。
//   EVAL=1 NAMES=… npx tsx debug-user-name.ts   評測句準：沒有學習 vs 學了 NAMES（使用者詞＋選字紀錄）
import { readFileSync } from 'node:fs';
import {
  Decoder,
  LexiconIndex,
  UserAdapter,
  syllableToKeyCodes,
} from './packages/core/src/index.js';
import { BackoffLM } from '@zhuyin/lm';
import { ImeEngine } from './packages/cli/src/engine.js';
import { loadEvalSamples } from './packages/cli/src/runtime.js';

const DATA = process.env['ZHUYIN_DATA'] ?? 'data';
const NAMES = (
  process.env['NAMES'] ??
  '亞里斯多芬,普羅米修斯,赫拉克利特,德謨克利特,阿那克西曼德,色諾芬尼斯,米開朗基羅,伊比鳩魯斯,阿基米德斯,畢達哥拉斯'
).split(',');
const ROUNDS = Number(process.argv[2] ?? 3);

const legal = (
  JSON.parse(readFileSync(`${DATA}/processed/syllables.json`, 'utf8')) as {
    syllables: string[];
  }
).syllables;
// 單字讀音：詞典裡第一個讀音；名字本身在不在詞典
const charReading = new Map<string, string>();
const words = new Set<string>();
const lexReadings = new Map<string, string[]>();
for (const line of readFileSync(`${DATA}/processed/lexicon.jsonl`, 'utf8').split('\n')) {
  if (!line) continue;
  const e = JSON.parse(line) as { word: string; readings: string[][] };
  words.add(e.word);
  if (!lexReadings.has(e.word)) lexReadings.set(e.word, e.readings[0]!);
  if ([...e.word].length === 1 && !charReading.has(e.word))
    charReading.set(e.word, e.readings[0]![0]!);
}

const lm = await BackoffLM.load(`${DATA}/models/lm.bo.bin`);
const key = (e: ImeEngine, code: string) => e.onKey({ code, timestampMs: 0 });
const newDecoder = (): Decoder => {
  const d = new Decoder(lm, { a: 1, gamma: 0.5 });
  d.useLexicon(LexiconIndex.fromBytes(readFileSync(`${DATA}/processed/lexicon.bin`)));
  return d;
};

if (process.env['EVAL']) {
  const samples = [
    ...(await loadEvalSamples('eval/colloquial.jsonl')),
    ...(await loadEvalSamples('eval/written.jsonl')),
  ];
  for (const learn of [false, true]) {
    const dec = newDecoder();
    // PER_SYL：每音節加成（0＝舊行為）；EXTRA=N：另外把詞典裡 N 個 3–4 字詞當成使用者詞（壓力測試）
    const perSyl = process.env['PER_SYL'];
    const adapter = new UserAdapter(
      perSyl !== undefined ? { manualPhraseBoostPerSyllable: Number(perSyl) } : {},
    );
    const extra = Number(process.env['EXTRA'] ?? 0);
    if (learn && extra > 0) {
      const pool = [...lexReadings].filter(([w]) => [...w].length >= 3 && [...w].length <= 4);
      for (let i = 0; i < extra; i++) {
        const [w, r] = pool[Math.floor((i * pool.length) / extra)]!;
        adapter.setUserPhrase(w, r);
      }
    }
    if (learn)
      for (const name of NAMES.filter((n) => !words.has(n))) {
        const seq = [...name].map((c) => charReading.get(c)!);
        // 學兩次：使用者詞＋選字紀錄（同 commit 規則 1、3）
        for (let r = 0; r < 2; r++) {
          adapter.setUserPhrase(name, seq);
          adapter.recordSelection(seq, name);
        }
        if (!dec.hasEntry(seq, name))
          dec.addEntry({ word: name, readings: [seq], provenance: ['user'] });
      }
    let sent = 0;
    let ch = 0;
    let total = 0;
    for (const s of samples) {
      const seq = s.syllables;
      const out = dec
        .decode(seq, {
          modifier: (w, pos, len) => adapter.modifierFor(seq.slice(pos, pos + len), w),
        })[0]!
        .words.join('');
      if (out === s.text) sent++;
      const a = [...out];
      const b = [...s.text];
      for (let i = 0; i < b.length; i++) if (a[i] === b[i]) ch++;
      total += b.length;
    }
    console.log(
      `${learn ? `學了 ${adapter.phrases.size} 個名字` : '沒有學習'}：句 ${((sent / samples.length) * 100).toFixed(2)}% 字 ${((ch / total) * 100).toFixed(2)}%`,
    );
  }
  process.exit(0);
}

for (const name of NAMES) {
  const chars = [...name];
  if (words.has(name)) {
    console.log(`${name}：詞典有，跳過`);
    continue;
  }
  const seq = chars.map((c) => charReading.get(c)!);
  const dec = newDecoder();
  const adapter = new UserAdapter();
  const eng = new ImeEngine(dec, legal, undefined, adapter);
  const typeAll = (n = seq.length): string => {
    let c = '';
    for (const s of seq.slice(0, n))
      for (const code of syllableToKeyCodes(s)) c = key(eng, code).composition;
    return c;
  };
  const prefixes = (): string[] =>
    [2, 3].map((n) => {
      const c = typeAll(n);
      eng.clear();
      return c;
    });
  const preBefore = prefixes();
  const row: string[] = [];
  for (let r = 1; r <= ROUNDS; r++) {
    let comp = typeAll();
    const first = comp;
    let picks = 0;
    // 逐字修：從左邊第一個不對的字開始，在選字視窗裡選目標單字
    for (let guard = 0; comp !== name && guard < chars.length * 2; guard++) {
      const i = [...comp].findIndex((ch, k) => ch !== chars[k]);
      key(eng, 'Home');
      for (let k = 0; k < i; k++) key(eng, 'ArrowRight');
      let st = key(eng, 'ArrowDown');
      for (let k = 0; k < 400 && st.menu && st.menu.items[st.menu.cursor] !== chars[i]; k++)
        st = key(eng, 'ArrowDown');
      if (!st.menu || st.menu.items[st.menu.cursor] !== chars[i]) break;
      comp = key(eng, 'Enter').composition;
      picks++;
    }
    const bd = eng.getCandidates()[0]?.words.join('|');
    const out = eng.commit();
    if (process.env['VERBOSE'])
      console.log(`  #${r} 斷詞 ${bd} 使用者詞 ${[...adapter.phrases.keys()].join(',')}`);
    row.push(`#${r} ${first}${picks ? ` 選${picks}次→${out}` : ' ✓'}`);
  }
  const mod = (w: string, pos: number, len: number) =>
    adapter.modifierFor(seq.slice(pos, pos + len), w);
  const free = dec.decode(seq, { modifier: mod })[0]!;
  const forced = dec.decode(seq, {
    modifier: mod,
    fixed: [{ pos: 0, len: seq.length, word: name }],
  })[0]!;
  console.log(
    `  差距 ${chars.length} ${(free.score - forced.score).toFixed(2)}（首選 ${free.words.join('|')}）`,
  );
  // ONLY_PHRASE=1：前綴只帶使用者詞、不帶逐字選字紀錄（分清楚是哪個造成前綴改變）
  if (process.env['ONLY_PHRASE']) {
    const only = new UserAdapter();
    only.setUserPhrase(name, seq);
    eng.attachAdapter(only);
  }
  const pre = prefixes();
  console.log(
    `${name}（${seq.join(' ')}）：${row.join(' | ')} | 前綴 ${pre.join(' ')}${pre.join() === preBefore.join() ? '' : `（學之前 ${preBefore.join(' ')}）`}`,
  );
}
