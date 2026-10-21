import { isTraditionalWord, type LexiconEntry, type Provenance } from '@zhuyin/core';
import {
  canonicalSequence,
  isStructurallyValid,
  parseSyllableSequence,
  splitAlternativeReadings,
} from '../zhuyin.js';
import type { LexiconDraft } from '../types.js';
import type { MoedictEntry } from '../sources/moedict.js';
import type { LibchewingRow } from '../sources/libchewing.js';

/** 標題清洗：去引號空白；含 glyph 參照（{[xxxx]}）或空標題者丟棄。 */
function cleanTitle(raw: string): string | null {
  const t = raw.replace(/[「」『』\s]/g, '');
  if (!t || t.includes('{[')) return null;
  return t;
}

export function moedictToDrafts(entries: MoedictEntry[]): {
  drafts: LexiconDraft[];
  skippedReadings: number;
} {
  const drafts: LexiconDraft[] = [];
  let skippedReadings = 0;
  for (const e of entries) {
    const word = cleanTitle(e.title ?? '');
    if (!word || !e.heteronyms?.length) continue;
    const readings: LexiconDraft['readings'] = [];
    const seen = new Set<string>();
    for (const h of e.heteronyms) {
      if (!h.bopomofo) continue;
      for (const alt of splitAlternativeReadings(h.bopomofo)) {
        const parsed = parseSyllableSequence(alt, 'prefix');
        if (!parsed || !parsed.every((x) => isStructurallyValid(x.syllable))) {
          skippedReadings++;
          continue;
        }
        const canonical = canonicalSequence(parsed);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        readings.push({ syllables: parsed, canonical });
      }
    }
    if (readings.length > 0) {
      drafts.push({ word, readings, provenance: ['moedict'] });
    }
  }
  return { drafts, skippedReadings };
}

export function libchewingToDrafts(rows: LibchewingRow[]): {
  drafts: LexiconDraft[];
  skippedReadings: number;
} {
  const byWord = new Map<string, LexiconDraft>();
  let skippedReadings = 0;
  for (const row of rows) {
    const parsed = parseSyllableSequence(row.bopomofo, 'suffix');
    if (!parsed || !parsed.every((x) => isStructurallyValid(x.syllable))) {
      skippedReadings++;
      continue;
    }
    const canonical = canonicalSequence(parsed);
    let draft = byWord.get(row.word);
    if (!draft) {
      draft = { word: row.word, readings: [], freq: row.freq, provenance: ['libchewing'] };
      byWord.set(row.word, draft);
    }
    const existing = draft.readings.find((r) => r.canonical === canonical);
    if (!existing) {
      draft.readings.push({ syllables: parsed, canonical, rfreq: row.freq });
    } else if (row.freq > 0) {
      // 同讀音出現在多個來源列（word.csv+tsi.csv）：保留最高讀音級頻率
      existing.rfreq = Math.max(existing.rfreq ?? 0, row.freq);
    }
    draft.freq = Math.max(draft.freq ?? 0, row.freq);
  }
  return { drafts: [...byWord.values()], skippedReadings };
}

export interface MergeStats {
  totalWords: number;
  totalReadings: number;
  multiReadingWords: number;
  uniqueSyllables: number;
  byProvenance: Record<string, number>;
}

export function mergeDrafts(groups: LexiconDraft[][]): {
  entries: LexiconEntry[];
  stats: MergeStats;
} {
  const acc = new Map<
    string,
    {
      readings: Map<string, { rfreq?: number }>;
      provenance: Set<Provenance>;
      freq?: number;
      /** 挖詞（mined）的頻率：只在沒有其他來源的頻率時採用，不覆蓋 libchewing */
      minedFreq?: number;
    }
  >();

  for (const drafts of groups) {
    for (const d of drafts) {
      let slot = acc.get(d.word);
      if (!slot) {
        slot = { readings: new Map(), provenance: new Set() };
        acc.set(d.word, slot);
      }
      if (d.freq !== undefined) {
        if (d.provenance.every((p) => p === 'mined'))
          slot.minedFreq = Math.max(slot.minedFreq ?? 0, d.freq);
        else slot.freq = Math.max(slot.freq ?? 0, d.freq);
      }
      for (const p of d.provenance) slot.provenance.add(p);
      for (const r of d.readings) {
        const cur = slot.readings.get(r.canonical);
        if (!cur) {
          slot.readings.set(r.canonical, r.rfreq !== undefined ? { rfreq: r.rfreq } : {});
        } else if (r.rfreq !== undefined) {
          cur.rfreq = Math.max(cur.rfreq ?? 0, r.rfreq);
        }
      }
    }
  }

  // 音節流行度先驗：全詞庫中擁有該音節的詞條數。
  // 用來排定多讀音詞的主讀音——萌典的 heteronyms 順序不一定反映使用慣例
  // （實測：「兒」的姓氏讀音 ㄋㄧˊ 列在 ㄦˊ 前，會污染下游的 readings[0]）。
  const sylCount = new Map<string, number>();
  for (const slot of acc.values()) {
    for (const key of slot.readings.keys()) {
      for (const syl of key.split(' ')) {
        sylCount.set(syl, (sylCount.get(syl) ?? 0) + 1);
      }
    }
  }
  const readingScore = (wordKeys: readonly string[], key: string): number => {
    const syls = key.split(' ');
    let score = 0;
    for (let i = 0; i < syls.length; i++) {
      const syl = syls[i]!;
      let c = sylCount.get(syl) ?? 0;
      // 裸調音節折扣：若同位置有兄弟讀音是它的帶調版（ㄦ vs ㄦˊ），
      // 說明這個裸形多半是兒化殘留而非獨立讀法——重罰其流行度。
      if (!/[ˊˇˋ˙]/.test(syl)) {
        const tonedExists = wordKeys.some((other) => {
          if (other === key) return false;
          const os = other.split(' ');
          return (
            os[i] !== undefined && /[ˊˇˋ˙]/.test(os[i]!) && os[i]!.replace(/[ˊˇˋ˙]/, '') === syl
          );
        });
        if (tonedExists) c = c / 20;
      }
      score += Math.log(c + 1);
    }
    return score;
  };

  const entries: LexiconEntry[] = [];
  const syllableSet = new Set<string>();
  const byProvenance: Record<string, number> = {};
  let totalReadings = 0;
  let multiReadingWords = 0;

  for (const [word, slot] of acc) {
    // 含簡化字、日本新字體等非台灣繁體字的詞不收（維基 OpenCC 轉換殘留；runtime 建 lexicon.bin 時也擋）
    if (!isTraditionalWord(word)) continue;
    const entries0 = [...slot.readings.entries()];
    const allKeys = entries0.map(([k]) => k);
    // 主讀音排序，兩層訊號：
    // 1. libchewing 讀音級頻率（的：ㄉㄜ˙147270 ≫ ㄉㄧˊ1）——最強證據
    // 2. 無頻率證據時用音節流行度（含裸調折扣：兒的ㄦˊ1580 ≫ 姓氏ㄋㄧˊ551）
    const maxRf = Math.max(0, ...entries0.map(([, v]) => v.rfreq ?? 0));
    let keys: string[];
    if (maxRf > 0) {
      keys = entries0
        .slice()
        .sort(
          (a, b) =>
            (b[1].rfreq ?? 0) - (a[1].rfreq ?? 0) ||
            readingScore(allKeys, b[0]) - readingScore(allKeys, a[0]),
        )
        .map(([k]) => k);
    } else {
      keys = entries0
        .slice()
        .sort((a, b) => readingScore(allKeys, b[0]) - readingScore(allKeys, a[0]))
        .map(([k]) => k);
    }
    const readings = keys.map((c) => c.split(' '));
    totalReadings += readings.length;
    if (readings.length > 1) multiReadingWords++;
    for (const reading of readings) for (const syl of reading) syllableSet.add(syl);
    const provs = [...slot.provenance].sort();
    for (const p of provs) byProvenance[p] = (byProvenance[p] ?? 0) + 1;
    const entry: LexiconEntry & { freq?: number } = {
      word,
      readings,
      provenance: provs,
    };
    const freq = slot.freq || slot.minedFreq;
    if (freq) entry.freq = freq;
    entries.push(entry);
  }

  entries.sort((a, b) => a.word.localeCompare(b.word, 'zh-Hant'));
  return {
    entries,
    stats: {
      totalWords: entries.length,
      totalReadings,
      multiReadingWords,
      uniqueSyllables: syllableSet.size,
      byProvenance,
    },
  };
}
