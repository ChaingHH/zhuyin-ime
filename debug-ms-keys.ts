// 評測句 → Windows 虛擬鍵碼（大千），給 ms-bopomofo.ps1 用 SendInput 打進微軟注音。
// npx tsx debug-ms-keys.ts <out.tsv>   每行：集\t正解\tVK,VK,...
import { writeFileSync } from 'node:fs';
import { syllableToKeyCodes } from './packages/core/src/keymap.js';
import { loadEvalSamples } from './packages/cli/src/runtime.js';

const VK: Record<string, number> = {
  Space: 0x20,
  Minus: 0xbd,
  Semicolon: 0xba,
  Comma: 0xbc,
  Period: 0xbe,
  Slash: 0xbf,
};
const vk = (code: string): number => {
  const m = /^(?:Digit|Key)(.)$/.exec(code);
  const v = m ? m[1]!.charCodeAt(0) : VK[code];
  if (v === undefined) throw new Error(`無對應 VK：${code}`);
  return v;
};

const lines: string[] = [];
for (const f of ['colloquial', 'written']) {
  for (const s of await loadEvalSamples(`eval/${f}.jsonl`)) {
    const keys = s.syllables.flatMap((syl) => syllableToKeyCodes(syl)).map(vk);
    lines.push(`${f}\t${s.text}\t${keys.join(',')}`);
  }
}
writeFileSync(process.argv[2]!, lines.join('\n') + '\n', 'utf8');
console.log(`${lines.length} 句 -> ${process.argv[2]}`);
