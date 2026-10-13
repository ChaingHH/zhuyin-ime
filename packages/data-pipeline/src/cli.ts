import { cmdDownload, cmdLexicon } from './build/run.js';
import { cmdSyllables } from './build/syllables.js';
import { buildColloquial, buildWritten } from './build/corpus.js';
import { buildEvalSet } from './build/evalset.js';

const cmd = process.argv[2];
const arg = (i: number, def: number): number => {
  const v = Number.parseInt(process.argv[i] ?? '', 10);
  return Number.isNaN(v) ? def : v;
};

async function main(): Promise<void> {
  switch (cmd) {
    case 'download':
      await cmdDownload();
      break;
    case 'lexicon':
      await cmdLexicon();
      break;
    case 'syllables':
      await cmdSyllables();
      break;
    case 'corpus': {
      await buildColloquial(arg(3, 200_000));
      await buildWritten(arg(4, 50_000), arg(5, 4_000));
      break;
    }
    case 'evalset': {
      const corpusDir = 'data/processed/corpus';
      await buildEvalSet(`${corpusDir}/colloquial.txt`, 'colloquial', arg(3, 1_000));
      await buildEvalSet(`${corpusDir}/written.txt`, 'written', arg(4, 500));
      break;
    }
    default:
      console.log(`用法: tsx src/cli.ts <download|lexicon|syllables|corpus|evalset> [args…]`);
      process.exitCode = cmd === undefined ? 0 : 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
