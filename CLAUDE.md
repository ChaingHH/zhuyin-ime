# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Platform-agnostic Zhuyin (Bopomofo) IME core in TypeScript. Goal: add the channel model `P(K|S)` (fuzzy sounds, typo correction) and a modern language model `P(H)` that existing Zhuyin IMEs lack, modelled on Microsoft Pinyin's feature set. Code comments and docs are in Traditional Chinese.

## Commands

npm workspaces monorepo, Node >= 20, ESM (`"type": "module"`, NodeNext resolution — relative imports need `.js` suffix).

```bash
npm install
npm run build                      # tsc -b over all packages (project references)
npm test                           # vitest run, all packages
npx vitest run packages/core/test/x2.test.ts   # single file
npx vitest run -t "name substring"             # single test by name
npm run lint                       # eslint flat config (eslint.config.js): js + typescript-eslint recommended
npm run format                     # prettier (single quotes, width 100, trailing commas)
```

- Unused function params must be prefixed `_` to pass lint.
- Workspace packages resolve each other through `dist/` (`main: dist/index.js`). Run `npm run build` before running any `tsx` script that imports `@zhuyin/*`, or it picks up stale output.

### Data and models (needed before eval / interactive use)

```bash
npm run data:lexicon               # download moedict + libchewing → data/processed/lexicon.jsonl
npm run data:corpus                # PTT colloquial + written samples → data/processed/corpus/
npx tsx packages/data-pipeline/src/cli.ts syllables   # data/processed/syllables.json
npx tsx packages/data-pipeline/src/cli.ts evalset     # eval/*.jsonl; run from repo root (relative paths)

# 正式模型（大語料）：PTT 全量 + 維基 1.5 億字 → data/models/lm.tsv（約 1GB，訓練約 17 分鐘）
python packages/data-pipeline/scripts/extract-wiki.py 0 data/raw/wiki/wiki_full.jsonl
CORPUS_OUT=data/processed/corpus-big2 WIKI_FILE=data/raw/wiki/wiki_full.jsonl npx tsx packages/data-pipeline/scripts/build-big-corpus.ts 1e12 150e6
NODE_OPTIONS=--max-old-space-size=34000 npx tsx packages/lm/src/train.ts data/processed/corpus-big2 data/models/lm.tsv
```

`data/raw`, `data/models`, `data/user` are gitignored. The reranker loads `Xenova/bert-base-chinese` fp32 ONNX from `data/models/hf/`.

- `train.ts` 輸出逐行 `.tsv`（`section\tcount\tkey`），不是 JSON：大模型超過 V8 單一字串上限。`LanguageModel.load` 兩種都讀。
- runtime 預設載入 `data/models/lm.tsv`，不存在才退回舊 `lm.json`；`ZHUYIN_LM=<path>` 可覆寫。
- runtime 的二元／三元表存在 typed array 雜湊表（`packages/lm/src/hashtable.ts`），不是 JS Map：載入約 2GB RSS、JS heap < 0.1GB，不需加大 heap。改回 Map 會讓每次 major GC 掃描數千萬物件（實測每句 +700ms 延遲）。訓練（`train.ts`）仍用 Map，需要 `--max-old-space-size=34000`。
- `build-big-corpus.ts` 取「連續中文字片段」而非整句清洗，並丟掉包含任何評測句的片段（防洩漏）。
- `LM_TOKEN_PENALTY`（預設 14）必須大於高頻單字的 log(freq)，否則訓練斷詞會把詞切成單字。
- `debug-acc.ts`：一次載入、多組設定的實驗台；dev=偶數句、test=奇數句，另列 N-best oracle。
- 載入時剪枝／量化：`ZHUYIN_LM_MIN_BI`、`ZHUYIN_LM_MIN_TRI`（計數低於此值不存，上下文總量仍含被剪部分）、`ZHUYIN_LM_QUANT=0|8|16`（`HashTable.freeze`：對數碼本＋48-bit 指紋）。runtime 預設 `bi>=2 tri>=3 q=8`：RSS 1937→679MB，句準確率 −0.2／−0.6；要原始模型設 `ZHUYIN_LM_MIN_BI=1 ZHUYIN_LM_MIN_TRI=1 ZHUYIN_LM_QUANT=0`；`bi>=2 q=16` 899MB 無損。仍要讀完整 lm.tsv（載入約 70 秒）。實驗台 `debug-prune.ts`（一設定一行程）。`ZHUYIN_NO_USER=1` 不載入 adapter.json。
- 微軟注音對比：`debug-ms-keys.ts` 產生大千 VK 序列，`powershell -STA -File debug-ms-bopomofo.ps1 -Keys k.tsv -Out o.tsv -KeyDelay 2 [-Skip N -Limit N]`（SendInput 打進自己的文字框；要 IMM `ImmSetOpenStatus` 才會進中文模式、`timeBeginPeriod(1)` 才跑得快；前景被搶就中止）會佔用鍵盤，使用者不在電腦前才能跑；`debug-ms-compare.ts` 計分。

### CLI testbench (`packages/cli`)

```bash
node packages/cli/dist/index.js type                 # interactive: space-separated KeyboardEvent.code per line
node packages/cli/dist/index.js type --rerank        # L5 shown immediately; BERT rerank replaces it async ([L6] lines)
node packages/cli/dist/index.js web [--port 8787] [--l6 off|bert|kev] [--no-l3]  # browser testbench: type with the real keyboard (Dachen), L6 pushed via SSE; L6 switchable in the page (kev needs the Kev server, KEV_URL overrides); ←→ move the cursor, ↓ opens the candidate menu for words ending at the cursor, a chosen word becomes a hard `fixed` span in later decodes; Shift+punctuation (`PUNCT` in `engine.ts`, keyed by `KeyboardEvent.key`) and Space with no pending zhuyin output directly on an empty composition, otherwise become literal tokens inserted at the composition cursor (`CompositionBuffer.pushLiteral`; the buffer owns the cursor and inserts/deletes there, the engine remaps `fixed`/sticky spans across edits with `remapper`; the decoder emits tokens with no bopomofo as-is and no word spans them, `isLiteralToken`; X2 skips them); Esc (menu closed) cancels the composition; the page is one focusable but non-editable editor (`tabindex`, not `contenteditable`: an editable element wakes the OS IME, which then fights the page) whose text and caret the page manages itself; the composition is an inline `#ime` span at the caret (Microsoft Bopomofo style); `GET /stats` feeds the page's perf bar; on commit, a picked word (or the run of single chars containing a picked char) is saved as a manual user phrase, since a once-selected mined word otherwise loses to the LM (OOV word ≈ −28 vs X2 boost ≤ 2.2)
npx tsx debug-l3.ts [keyErr] [cogErr] [scales]   # L3 eval: clean + X3-injected noisy input, L3 off vs cost scales
node packages/cli/dist/index.js replay <keys.jsonl>
node packages/cli/dist/index.js eval [-n N] [-a A] [-g GAMMA] [--rerank -b W --gap G --maxc K --flip M] [--kev --kw W --ktop N --knoul] [--idf X] [--baseline classic|bigram]
node packages/cli/dist/index.js sweep [-n N]         # grid over a × gamma on colloquial set
```

`eval` scores sentence/char accuracy on `eval/colloquial.jsonl` + `eval/written.jsonl`. `--baseline classic` mimics libchewing (word unigram only), `bigram` mimics McBopomofo. Root-level `debug-*.ts` are throwaway investigation scripts (`npx tsx debug-xxx.ts`) that reach into `packages/*/src` directly.

### Kev / Jev decision-model rerank (`--kev`)

`packages/rerank/src/kev.ts` calls a System One API server (Kev = open-weight Jev clone, Apache-2.0; also works against TypeSafe's hosted Jev with `TYPESAFE_API_KEY`). Server lives in `data/raw/kev` (cloned `jaredpalmer/kev`, own `.venv` with torch cu128):

```bash
cd data/raw/kev && KEV_FUSED=0 HF_HUB_OFFLINE=1 .venv/Scripts/python -m kev.serve --run runs/zy-choice16k --port 8009
```

- Use `.venv/Scripts/python` directly, not `uv run`: `uv run` re-syncs torch back to the CPU wheel.
- Local edits to Kev for Windows (`resource`/`fcntl` import guards in `kev/train.py`, `kev/suite.py`, `kev/experiment.py`) are marked `本地修改`.
- Training on 16 GB needs `--weights_dtype bf16`; fp32 backbone spills to shared memory and crawls.
- GPU kernels: `triton-windows` 3.4 + `flash-linear-attention==0.5.2` (Kev's pinned version) are installed in the venv, so Qwen3.5's gated delta rule runs on fla's Triton kernels instead of the PyTorch fallback. `causal_conv1d` is not installed (needs a CUDA build on Windows). Fastest measured config on the RTX 5080: `--batch 4 --accum 4 --checkpointing 1` (~0.14 s/record vs 0.23 before); `--batch 8` is slower and `--checkpointing 0` overflows 16 GB.
- Serving must use `KEV_FUSED=0`: with fla installed, `kev.serve` turns on fused kernels + CUDA graphs by default, which fills 16 GB and drops to ~4 s/request (vs ~60 ms). Send requests one at a time; concurrent requests are slower here.
- `runs/zy-choice16k-tsv` (trained on lm.tsv N-best) scored 79.9/88.6% at w=3 vs 80.4/89.0% for `runs/zy-choice16k`: no gain, keep the latter.
- Fine-tune data: `npx tsx debug-kev-train.ts N` → `data/kev/train-{choice,noul}.jsonl` (excludes eval sentences). Question text in `kev.ts` must match it.
- Offline scoring/sweeps: `data/kev/{score,causal,combine,combine3,combinen}.py` over `npx tsx debug-kev-dump.ts` N-best dumps.

## Architecture

Layered pipeline (layer names appear throughout comments):
L0 key events → L1 keymap → L2 slot composition → L3 hypothesis expansion (motor/cognitive channels) → L4 lattice → L5 decode → L6 neural rerank (optional) → L7 display hysteresis, plus cross-cutting X1 domain prior, X2 user adaptation, X3 telemetry.

| Package | Role |
|---|---|
| `@zhuyin/core` | Pure, zero-IO pipeline. `keymap.ts` (L1, Dachen layout), `slots.ts` (L2 `CompositionBuffer`), `decode.ts` (L4+L5 `Decoder`), `x2.ts` (`UserAdapter`) |
| `@zhuyin/lm` | n-gram LM training (`train.ts`, unigram-DP word segmentation) and runtime `LanguageModel` |
| `@zhuyin/data-pipeline` | Source download → cleaning → lexicon / syllables / corpus / eval set. Source URLs, licenses and revisions live in `src/config.ts` |
| `@zhuyin/rerank` | L6 batched pseudo-log-likelihood rerank over divergent positions only |
| `@zhuyin/cli` | Wires everything together; `runtime.ts#loadRuntime` is the one place that loads lexicon + LM + syllables + adapter and builds the `Decoder` |

Key design points (from comments in `decode.ts` and `reranker.ts`):

- Decoder score is **log-linear**: `Σ a·logP_word(w|prev 2 words) + γ·logP_char(chars|prev 2 chars)`, plus a sentence-end term `P(EOS|last 2)`. Do not convert to linear interpolation (between the word and char experts; *within* each n-gram, interpolated Kneser-Ney is the default — it beat stupid backoff by ~12 points sentence accuracy).
- N-best uses list-Viterbi (K partial paths per two-word state), not "last two words differ".
- `core` depends on the LM only through the structural `Scorer` interface; baselines in `runtime.ts` swap in alternate `Scorer`s.
- Rerank final score = `a·LM(+γ char + U) + b·PLL`. `gapThreshold`: skip BERT when L5 top-1 − top-2 > threshold (CLI default 6, no dev loss, ~40% fewer BERT calls). Keep the ONNX model fp32: int8 quantization dropped sentence accuracy 70% → 55%.
- L6 in the engine is async (`ImeEngine` `RerankHooks`): `onKey` returns L5 synchronously, rerank runs in background, stale results (user typed again / committed) are dropped, at most one rerank in flight, `commit` never waits for BERT. BERT must run in `RerankWorker` (worker_threads): in-thread `PllReranker` blocks the event loop for the whole rerank (110–640ms measured), so keystrokes queue behind it. Anti-flicker: words L6 changed get a position-bound bonus (`stickBonus`, default 4) in later L5 decodes of the same composition; the bonus is subtracted again before paths go to L6, so it stabilizes display without biasing the final choice (a hard prefix lock was tried and cost 5–6 points sentence accuracy). Evaluate with `debug-lock.ts`.
- L3 (`core/src/l3.ts` `Channel`): expands each observed syllable into legal intended syllables with a cost (adjacent key, extra/missed key, adjacent tone key, fuzzy pairs ㄣㄥ/ㄓㄗ/…, wrong tone; ㄣ/ㄥ has its own lower cost `nasal` = 3.5 so ㄧㄣ ㄍㄞ → 應該, other fuzzy pairs 7.5); one edit per syllable, at most one corrected syllable per word. Decoder adds `chTerm` = −cost and records `reading`. Single-syllable corrections only apply when the observed syllable has no lexicon entries (`altSingleOnlyIfEmpty`): enabling them recovers ~7 more points on noisy input but makes decoding 5–8× slower. Evaluated only on synthetic errors (`cli/src/noise.ts`, shares the adjacency/fuzzy tables with L3 → optimistic); there is no real typing log. X2 learns from `breakdown.reading`, not the observed (typo) syllables.
- `UserAdapter` (X2) state persists to `data/user/adapter.json`; user phrases are also added live via `decoder.addEntry`.

## Data licensing constraints

- Every derived lexicon entry carries a `provenance` field (`moedict` | `libchewing` | `user` | `mined`). Keep it when adding sources.
- libchewing data is LGPL-2.1: redistribute as-is with license notice; mark any modification.
- moedict requires source attribution. GPL model weights must not be committed; users fetch them via script.
