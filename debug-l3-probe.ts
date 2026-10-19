// L3 誤修正探針：照打的讀音在各代價倍率下會不會被改掉。npx tsx debug-l3-probe.ts [scales] [讀音（空白分音節、| 分句）]
import { Channel } from './packages/core/src/index.js';
import { loadRuntime } from './packages/cli/src/runtime.js';

const scales = (process.argv[2] ?? '1,1.5,2,3').split(',').map(Number);
const cases = (process.argv[3] ?? 'ㄨㄣˊ ㄉㄤˇ|ㄉㄚˇ ㄎㄞ ㄨㄣˊ ㄉㄤˇ|ㄅㄠˇ ㄘㄨㄣˊ ㄨㄣˊ ㄉㄤˇ').split('|').map((s) => s.split(' '));
const rt = await loadRuntime();
const legal = [...rt.legalSyllables];
for (const obs of cases) {
  const off = rt.decoder.decode(obs)[0]!;
  const row = [`${obs.join(' ')}  關:${off.words.join('')}(${off.score.toFixed(1)})`];
  for (const s of scales) {
    const ch = new Channel(legal, { sub: 9 * s, extra: 10.5 * s, miss: 12 * s, toneAdj: 7.5 * s, tone: 10.5 * s, fuzzy: 7.5 * s, nasal: 3.5 * s });
    const on = rt.decoder.decode(obs, { alternatives: obs.map((x) => ch.expand(x)) })[0]!;
    row.push(`×${s}:${on.words.join('')}(${on.score.toFixed(1)})`);
  }
  console.log(row.join('  '));
}
process.exit(0);
