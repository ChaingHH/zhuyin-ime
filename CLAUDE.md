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

`data/raw`, `data/models`, `data/user` are gitignored.

- `train.ts` 輸出逐行 `.tsv`（`section\tcount\tkey`），不是 JSON：大模型超過 V8 單一字串上限。`LanguageModel.load` 兩種都讀。
- runtime 預設依序找 `data/models/lm.bo.bin`、`lm.bin`、`lm.tsv`、舊 `lm.json`；`ZHUYIN_LM=<path>` 可覆寫。基線（`--baseline`）與 `--idf` 要計數，會跳過 `lm.bo.bin`。
- `lm.bo.bin`（預設模型）：退回式模型（`packages/lm/src/backoff.ts` `BackoffLM`），存好算完的 KN 機率與退回權重，查詢不算 KN、沒有小 Map。`NODE_OPTIONS=--max-old-space-size=12000 npx tsx packages/lm/src/shrink.ts [保留筆數百萬=12]`（約 4 分鐘）從 lm.tsv 建：加權差異剪枝（Seymore–Rosenfeld）、重算退回權重、8 位元均勻碼本、16 位元指紋，四表權重 `LM_SHRINK_WEIGHTS` 預設 1:1:2:2。預設 12M 筆：大表 46MB、RSS 115MB、句 76.1／79.4（計數模型 lm.bin 220MB、76.4／79.8）。表裡 0 代表「沒存」：機率欄不能量化成 0（P≈1 會被當成沒存），一元表的鍵要含 `cont`（EOS 只在那裡）。實驗台 `debug-shrink.ts`（全模型與分數只算一次，多組設定）、`debug-bo-diff.ts`（沿正解逐詞比 KN 與退回式機率）。
- 常駐（PIME、網頁測試台）要用 `node --max-semi-space-size=4 --max-old-space-size=128`：打字 300 句後 RSS 315 → 146MB，延遲不變（`debug-latency.ts`；`.claude/launch.json` 已加）。old-space 64 時 heap 會用到 57MB，太貼近。
- 詞典索引：`core/src/lexicon.ts` `LexiconIndex`（音節編號＋typed array），runtime 快取成 `data/processed/lexicon.bin`（比 lexicon.jsonl 舊就重建），載入 27ms、不解析 JSONL。解碼結果與舊 Map 索引逐位元相同。有設任何 `ZHUYIN_LM_*` 剪枝／量化變數（`LM_ENV_KEYS`）時跳過 `.bin`。
- `lm.bin`：`npx tsx packages/lm/src/pack.ts [lm.tsv] [lm.bin]`（約 40–70 秒，吃同樣的環境變數，`lmOptionsFromEnv`）把剪枝量化後的模型存成二進位（約 125MB）。載入約 1 秒；表陣列直接 view 到檔案 buffer。重新訓練 lm.tsv 或改預設後要重新打包。
- 二元／三元表是 typed array 雜湊表（`packages/lm/src/hashtable.ts`），不是 JS Map：載入 tsv 時用開放定址 `HashTable` 累加，量化時預設轉成最小完美雜湊 `PerfectTable`（每鍵 16-bit 指紋＋8-bit 值＋約 4 bit 位移值，沒有探測）。改回 Map 會讓每次 major GC 掃描數千萬物件（實測每句 +700ms 延遲）。訓練（`train.ts`）仍用 Map，需要 `--max-old-space-size=34000`。
- `build-big-corpus.ts` 取「連續中文字片段」而非整句清洗，並丟掉包含任何評測句的片段（防洩漏）。`CORPUS_EN=1`：英文詞換成類別符號 `EN_CLASS`（``，`core/src/decode.ts`）、中英之間的空白不斷句，含英文的片段每 200 個留一個到 `mixed-heldout.txt`（不訓練）；第二個參數 0＝只建 PTT。中英評測集 `eval/mixed.jsonl`（`scripts/build-mixed-eval.ts`，`eval --mixed`）。解碼器把含拉丁字母的原樣 token 當 `EN_CLASS` 查 LM（`lmToken`／Rust `is_english`），輸出原字。數字見 docs/MEMORY.md §7。
- X2 選字加成的鍵是該詞自己的讀音（`modifierFor(seq.slice(pos, pos+len), w)`；以前傳整句，bySeq 從沒生效）。學習模擬 `debug-x2-learn.ts`。
- 英文模式（TS `ImeEngine`、Rust `engine.rs`）：切換不送出組字區；組字中打的字母、數字併進游標前的英文 token（`CompositionBuffer.appendEnglish`），前面的中文跟著重解碼；英文模式下空白、標點才整段送出；退格一次退一個字母。`EngineState.cursor` 是字數（英文 token 照長度）。
- `LM_TOKEN_PENALTY`（預設 14）必須大於高頻單字的 log(freq)，否則訓練斷詞會把詞切成單字。
- 挖詞：`npx tsx packages/data-pipeline/scripts/mine-words.ts [lm.tsv] [lexicon.jsonl] [mined.jsonl]`（約 3 分鐘）從 lm.tsv 的詞計數挖常用複合詞 → `data/processed/mined.jsonl`（provenance=mined），`npm run data:lexicon` 合併進詞典；之後要重訓 lm.tsv、重建 lm.bo.bin 新詞才有機率。門檻與數字見 docs/MEMORY.md §7。
- `debug-acc.ts`：一次載入、多組設定的實驗台；dev=偶數句、test=奇數句，另列 N-best oracle。
- 剪枝／量化（`lmOptionsFromEnv`，預設 `bi>=2 tri>=4 q=8 MPH=1`）：`ZHUYIN_LM_MIN_BI`／`_MIN_TRI`（計數低於此值不存，上下文總量仍含被剪部分）、`_QUANT=0|8|16`（對數碼本）、`_MPH=0|1`（完美雜湊）；`_FP=32|40|48`、`_LOAD` 只在 `MPH=0` 時有用。預設：RSS 約 250MB、大表 109MB、句 76.4／79.8（原始模型 76.7／80.4，要用設 `ZHUYIN_LM_MIN_BI=1 ZHUYIN_LM_MIN_TRI=1 ZHUYIN_LM_QUANT=0`）。實驗台 `debug-prune.ts`（一設定一行程）；`ZHUYIN_NO_USER=1` 不載入 adapter.json。
- 記憶體分析、微軟注音／PIME 的宿主方式、縮小方案：見 `docs/MEMORY.md`。安裝到 PIME 的教學：`docs/PIME-INSTALL.md`。
- `native/`：引擎的 Rust 移植（L1–L5、L3、X2、`ImeEngine`，加上 PIME 後端協定 `native/src/pime.rs`），讀同樣的 `lm.bo.bin`／`lexicon.bin`／`adapter.json`，打字中私有記憶體 13MB（模型是記憶體映射）。`cd native && cargo build --release`；`ZHUYIN_DATA=<data> native/target/release/zhuyin-native.exe eval|dump|keys|l3|replay`（從 repo 根目錄跑，用法見 `native/src/main.rs` 檔頭）。PIME：`zhuyin-native pime` 走 stdin/stdout 協定，`lm.bo.bin` 用記憶體映射，第一個組字鍵才載入引擎、閒置 `ZHUYIN_IDLE_SECS`（預設 300）秒或最後一個 client 停用就卸載（`debug-pime-idle.ts` 量記憶體與重新載入延遲）；設定檔 `%APPDATA%\PIME\zhuyin\config.json`（`shiftToggle`／`idleSecs`／`l3`）；`onCommand`、`onMenu` 等沒有 edit session 的回應不能帶 `showMessage`（PIME 的 DLL 會解參考空指標、宿主程式當掉）；PIME 的 DLL 在 RPC 失敗（啟動器停了、2 秒沒回、後端死掉）時會讓所有用著它的程式當掉（Explorer 一秒一次），所以**絕不停 PIMELauncher**、後端每則請求都要很快回且不能在處理中結束；`install.ps1` 用改名取代覆寫、不停 PIME，`-Rollback` 換回 `zhuyin.prev\`；`debug-pime.ts` 會依 DLL 的讀法檢查每則回應的格式與時間；`ZHUYIN_DATA=<data> npx tsx debug-pime.ts zhuyin` 先做行為檢查（含點圖示、右鍵選單、選字反白、只用左 Shift）再打 1500 句；使用者文件 `docs/PIME-INSTALL.md`；安裝檔與 `install.ps1` 在 `native/pime/`（步驟見 docs/MEMORY.md §6，不要自己執行安裝）。改 TS 的 L1–L5／X2／engine 時要同步改 Rust，並用 `debug-native-parity.ts` 對拍（輸出應逐位元組相同，見 docs/MEMORY.md「Rust 引擎」）。
- 已量過、不要重試：開放定址 fp=32 句 −1.5／−2.6（查不到的鍵約 0.7% 誤中）；load 0.9 慢約 25%；q6／q4 有損；mmap 對雜湊表無效（10 句內讀到 91–100% 的頁，`debug-pages.ts` 只支援 `MPH=0`）。記憶體：`loadRuntime` 載入後在外層做 last-resort GC（`releaseHeap`；在內層做時詞典原文還活著，回收不到）；打字中 V8 會把 heap 撐到約 490MB（存活約 80MB），常駐宿主要在閒置時呼叫 `releaseHeap`（55ms），`web.ts` 停打 3 秒後呼叫。拆解腳本 `debug-mem.ts`、`debug-lexmem.ts`；兩個專家的貢獻 `debug-expert.ts`；逐鍵延遲 `debug-latency.ts`。
- 解碼器的配置量（每鍵 9.5 → 3.7MB，打字中 RSS 733 → 431MB，延遲與 CPU 約砍半）：LM 查詢用 `get2`／`get3` 分段雜湊（不組 `"c1 c2"` 字串，雜湊值與整串相同）；`decode` 先算分數，狀態清單由 `insert` 維持「由高到低、最多 nBest、同分排後」（等同原本穩定排序取前 nBest），同組同詞只算一次鍵與尾字；全域 beam 用 `pruneBeam`（`Float64Array` 排序找門檻，同分依桶迭代順序保留），位置上超過 2×beam 就先剪並記 `floors`，之後嚴格低於門檻的路徑不建。改 `decode` 前後要用 `debug-decode-dump.ts` 比對 1500 句前 4 名＋分數（目前逐位元相同），配置量用 `debug-alloc.ts`（`ALLOC_MODE=nochar|dummy` 做對照）。heap 上限（`--max-old-space-size=256`）改動後效益很小（431 → 420MB），160MB 以下會在解析 lexicon.jsonl 時當掉。
- 和其他輸入法比較（數字見 `docs/MEMORY.md`）：PIME 新酷音／小麥注音用 `npx tsx debug-pime.ts chewing|mcbopomofo [N]` 直接驅動 PIME 後端（模擬 TSF DLL 的 stdin/stdout 協定，不佔鍵盤；新酷音會學進 `%APPDATA%\PIME\chewing\chewing.sqlite3`，跑前先刪）。微軟注音只能走 GUI：`debug-ms-keys.ts` 產生大千 VK 序列，`debug-ime-bench.ps1 -Ime ms` 包住 `debug-ms-bopomofo.ps1`（SendInput 打進自己的 WinForms 文字框；要 IMM `ImmSetOpenStatus` 才會進中文模式、`timeBeginPeriod(1)` 才跑得快；前景被搶就中止；PIME 在這個文字框裡收不到按鍵），會佔用鍵盤，使用者不在電腦前才能跑；`debug-ms-compare.ts` 計分。

### CLI testbench (`packages/cli`)

```bash
node packages/cli/dist/index.js type                 # interactive: space-separated KeyboardEvent.code per line
node packages/cli/dist/index.js web [--port 8787] [--no-l3]  # browser testbench: type with the real keyboard (Dachen); ←→ move the cursor, ↓ opens the candidate menu for words ending at the cursor, a chosen word becomes a hard `fixed` span in later decodes; Shift+punctuation (`PUNCT` in `engine.ts`, keyed by `KeyboardEvent.key`) and Space with no pending zhuyin output directly on an empty composition, otherwise become literal tokens inserted at the composition cursor (`CompositionBuffer.pushLiteral`; the buffer owns the cursor and inserts/deletes there, the engine remaps `fixed` spans across edits with `remapper`; the decoder emits tokens with no bopomofo as-is and no word spans them, `isLiteralToken`; X2 skips them); Esc (menu closed) cancels the composition; the page is one focusable but non-editable editor (`tabindex`, not `contenteditable`: an editable element wakes the OS IME, which then fights the page) whose text and caret the page manages itself; the composition is an inline `#ime` span at the caret (Microsoft Bopomofo style); `GET /stats` feeds the page's perf bar; on commit, a picked word (or the run of single chars containing a picked char, or a picked single char joined to the adjacent multi-char word, ≤4 chars, not for `STANDALONE` pronouns/particles) is saved as a manual user phrase, since a once-selected mined word otherwise loses to the LM (OOV word ≈ −28 vs X2 boost ≤ 2.2)
npx tsx debug-l3.ts [keyErr] [cogErr] [scales]   # L3 eval: clean + X3-injected noisy input, L3 off vs cost scales
node packages/cli/dist/index.js replay <keys.jsonl>
node packages/cli/dist/index.js eval [-n N] [-a A] [-g GAMMA] [--idf X] [--baseline classic|bigram]
node packages/cli/dist/index.js sweep [-n N]         # grid over a × gamma on colloquial set
```

`eval` scores sentence/char accuracy on `eval/colloquial.jsonl` + `eval/written.jsonl`. `--baseline classic` mimics libchewing (word unigram only), `bigram` mimics McBopomofo. Root-level `debug-*.ts` are throwaway investigation scripts (`npx tsx debug-xxx.ts`) that reach into `packages/*/src` directly.

### 已封存：L6 神經重排、L7 防閃動

git tag `archive/l6-l7`（`git checkout archive/l6-l7` 取回）。內容：`packages/rerank`（BERT PLL、`RerankWorker`、Kev 客戶端）、`ImeEngine` 的 `RerankHooks`／`stickBonus`、web 的 L6 切換與 SSE、eval 的 `--rerank`／`--kev`。封存原因：依賴與模型太肥（transformers＋onnxruntime、`data/models/hf` 391MB、Kev venv 7.6GB）。要點：Kev（`runs/zy-choice16k` w=3）80.4/89.0%；BERT 要 fp32、要在 worker 跑；防閃動用軟加分（硬鎖前綴掉 5–6 點）。Kev 伺服器、訓練資料、BERT 模型與 Qwen 權重已於 2026-10-16 刪除，要重做得重新下載與訓練。

## Architecture

Layered pipeline (layer names appear throughout comments):
L0 key events → L1 keymap → L2 slot composition → L3 hypothesis expansion (motor/cognitive channels) → L4 lattice → L5 decode (L6 neural rerank / L7 display hysteresis archived, see above), plus cross-cutting X1 domain prior, X2 user adaptation, X3 telemetry.

| Package | Role |
|---|---|
| `@zhuyin/core` | Pure, zero-IO pipeline. `keymap.ts` (L1, Dachen layout), `slots.ts` (L2 `CompositionBuffer`), `decode.ts` (L4+L5 `Decoder`), `x2.ts` (`UserAdapter`) |
| `@zhuyin/lm` | n-gram LM training (`train.ts`, unigram-DP word segmentation) and runtime `LanguageModel` |
| `@zhuyin/data-pipeline` | Source download → cleaning → lexicon / syllables / corpus / eval set. Source URLs, licenses and revisions live in `src/config.ts` |
| `@zhuyin/cli` | Wires everything together; `runtime.ts#loadRuntime` is the one place that loads lexicon + LM + syllables + adapter and builds the `Decoder` |

Key design points (from comments in `decode.ts`):

- Decoder score is **log-linear**: `Σ a·logP_word(w|prev 2 words) + γ·logP_char(chars|prev 2 chars)`, plus a sentence-end term `P(EOS|last 2)`. Do not convert to linear interpolation (between the word and char experts; *within* each n-gram, interpolated Kneser-Ney is the default — it beat stupid backoff by ~12 points sentence accuracy).
- N-best uses list-Viterbi (K partial paths per two-word state), not "last two words differ".
- `core` depends on the LM only through the structural `Scorer` interface; baselines in `runtime.ts` swap in alternate `Scorer`s.
- L3 (`core/src/l3.ts` `Channel`): expands each observed syllable into legal intended syllables with a cost (adjacent key, extra/missed key, adjacent tone key, fuzzy pairs ㄣㄥ/ㄓㄗ/…, wrong tone; ㄣ/ㄥ has its own lower cost `nasal` = 3.5 so ㄧㄣ ㄍㄞ → 應該, other fuzzy pairs 7.5); one edit per syllable, at most one corrected syllable per word. Decoder adds `chTerm` = −cost and records `reading`. Single-syllable corrections only apply when the observed syllable has no lexicon entries (`altSingleOnlyIfEmpty`): enabling them recovers ~7 more points on noisy input but makes decoding 5–8× slower. Evaluated only on synthetic errors (`cli/src/noise.ts`, shares the adjacency/fuzzy tables with L3 → optimistic); there is no real typing log. X2 learns from `breakdown.reading`, not the observed (typo) syllables.
- `UserAdapter` (X2) state persists to `data/user/adapter.json`; user phrases are also added live via `decoder.addEntry`.

## Data licensing constraints

- Every derived lexicon entry carries a `provenance` field (`moedict` | `libchewing` | `user` | `mined`). Keep it when adding sources.
- libchewing data is LGPL-2.1: redistribute as-is with license notice; mark any modification.
- moedict requires source attribution. GPL model weights must not be committed; users fetch them via script.
