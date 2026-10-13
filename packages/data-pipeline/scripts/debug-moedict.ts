import { loadMoedict } from '../src/sources/moedict.js';
import {
  isStructurallyValid,
  parseSyllableSequence,
} from '../src/zhuyin.js';

const entries = await loadMoedict();
const samples: string[] = [];
let n = 0;
for (const e of entries) {
  for (const h of e.heteronyms ?? []) {
    if (!h.bopomofo) continue;
    const seq = parseSyllableSequence(h.bopomofo, 'prefix');
    const ok = seq && seq.every((s) => isStructurallyValid(s.syllable));
    if (!ok) {
      if (samples.length < 30) {
        const detail = seq
          ? seq.map((s) => `${s.canonical}:${isStructurallyValid(s.syllable)}`).join('|')
          : 'PARSE_FAIL';
        samples.push(`${JSON.stringify(h.bopomofo)} -> ${detail}`);
      }
      n++;
    }
  }
}
console.log({ skipped: n });
for (const s of samples) console.log(s);
