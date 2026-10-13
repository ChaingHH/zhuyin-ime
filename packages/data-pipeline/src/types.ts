import type { Provenance } from '@zhuyin/core';
import type { ParsedSyllable } from './zhuyin.js';

/** 解析後、合併前的中間產物。 */
export interface LexiconDraft {
  word: string;
  readings: {
    syllables: ParsedSyllable[];
    canonical: string;
    /** 讀音級頻率（僅 libchewing 提供；moedict 無此資訊） */
    rfreq?: number;
  }[];
  freq?: number;
  provenance: Provenance[];
}

export interface RawRow {
  word: string;
  freq?: number;
  bopomofo: string;
}
