# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Zhuyin (Bopomofo) IME. Goal: add the channel model `P(K|S)` (fuzzy sounds, typo correction) and a modern language model `P(H)` that existing Zhuyin IMEs lack, modelled on Microsoft Pinyin's feature set. The engine is Rust (`native/`, runs as a PIME backend); TypeScript (npm workspaces) builds the data and models it reads. Code comments and docs are in Traditional Chinese.

## Commands

```bash
cd native && cargo build --release   # the engine
cd native && cargo test              # engine unit tests; no data/ needed (fixtures in native/src/testutil.rs)
ZHUYIN_DATA=data native/target/release/zhuyin-native.exe eval   # accuracy; run from repo root (see below)

npm install
npm run build                      # tsc -b over all packages (project references)
npm test                           # vitest run, all packages
npx vitest run packages/core/test/lexicon.test.ts   # single file
npx vitest run -t "name substring"             # single test by name
npm run lint                       # eslint flat config (eslint.config.js): js + typescript-eslint recommended
npm run format                     # prettier (single quotes, width 100, trailing commas)
```

TS side: Node >= 20, ESM (`"type": "module"`, NodeNext resolution — relative imports need `.js` suffix).

- Unused function params must be prefixed `_` to pass lint.
- Workspace packages resolve each other through `dist/` (`main: dist/index.js`). Run `npm run build` before running any `tsx` script that imports `@zhuyin/*`, or it picks up stale output. If `tsc -b` reports exports missing that are in the source, delete `packages/*/dist` and `packages/*/tsconfig.tsbuildinfo` (stale build info skips emit).
- In a git worktree without its own `node_modules/@zhuyin/*`, `@zhuyin/*` resolves up to the **main checkout's** packages, so tests silently run the main checkout's build. Link the worktree's packages first (PowerShell: `New-Item -ItemType Junction -Path node_modules\@zhuyin\core -Target packages\core`, same for lm, data-pipeline).

### Data and models (needed before eval / interactive use)

```bash
npm run data:lexicon               # download moedict + libchewing → data/processed/lexicon.jsonl + lexicon.bin
npm run data:corpus                # PTT colloquial + written samples → data/processed/corpus/
npx tsx packages/data-pipeline/src/cli.ts syllables   # data/processed/syllables.json
npx tsx packages/data-pipeline/src/cli.ts evalset     # eval/*.jsonl; run from repo root (relative paths)
npx tsx packages/data-pipeline/src/cli.ts lexbin      # lexicon.jsonl → lexicon.bin only

# 正式模型（大語料）：PTT 全量 + 維基 1.5 億字 → data/models/lm.tsv（約 1GB，訓練約 17 分鐘）
python packages/data-pipeline/scripts/extract-wiki.py 0 data/raw/wiki/wiki_full.jsonl
CORPUS_OUT=data/processed/corpus-big2 WIKI_FILE=data/raw/wiki/wiki_full.jsonl npx tsx packages/data-pipeline/scripts/build-big-corpus.ts 1e12 150e6
NODE_OPTIONS=--max-old-space-size=34000 npx tsx packages/lm/src/train.ts data/processed/corpus-big2 data/models/lm.tsv
```

`data/raw`, `data/models`, `data/user` are gitignored. The engine reads `data/models/lm.bo.bin`, `data/processed/lexicon.bin`, `data/processed/syllables.json`.

- `train.ts` 輸出逐行 `.tsv`（`section\tcount\tkey`），不是 JSON：大模型超過 V8 單一字串上限。`LanguageModel.load` 兩種都讀。
- `lm.bo.bin`（引擎唯一讀的模型）：退回式模型（`packages/lm/src/backoff.ts` `BackoffLM`），存好算完的 KN 機率與退回權重，查詢不算 KN。`NODE_OPTIONS=--max-old-space-size=12000 npx tsx packages/lm/src/shrink.ts [保留筆數百萬=12]`（約 4 分鐘）從 lm.tsv 建：加權差異剪枝（Seymore–Rosenfeld）、重算退回權重、8 位元均勻碼本、16 位元指紋，四表權重 `LM_SHRINK_WEIGHTS` 預設 1:1:2:2。預設 12M 筆：大表 46MB、句 76.1／79.4（計數模型 lm.bin 220MB、76.4／79.8）。表裡 0 代表「沒存」：機率欄不能量化成 0（P≈1 會被當成沒存），一元表的鍵要含 `cont`（EOS 只在那裡）。比較不同設定：各建一個 bo.bin，`ZHUYIN_LM=<檔> zhuyin-native eval`；`debug-bo-diff.ts` 沿正解逐詞比 KN 與退回式機率。
- 詞典索引：`core/src/lexicon.ts` `LexiconIndex`（音節編號＋typed array，格式 `ZYLEX002`）；`data-pipeline` 的 `lexbin`（`src/build/lexbin.ts`，`data:lexicon` 最後一步）從 lexicon.jsonl 建 `lexicon.bin`，寫入走暫存檔＋改名。Rust `native/src/lexicon.rs` 唯讀。
- `LanguageModel` 的 `.bin` 格式（`save`／`readBin`）與 `quant`／`mph` 載入選項是 TS 引擎時代的計數模型打包，現在只剩測試在用（`pack.ts`、`lmOptionsFromEnv` 已刪）。
- 二元／三元表是 typed array 雜湊表（`packages/lm/src/hashtable.ts`），不是 JS Map（改回 Map 會讓每次 major GC 掃描數千萬物件）。訓練（`train.ts`）仍用 Map，需要 `--max-old-space-size=34000`。
- `build-big-corpus.ts` 取「連續中文字片段」而非整句清洗，並丟掉包含任何評測句的片段（防洩漏）。`CORPUS_EN=1`：英文詞換成類別符號 `EN_CLASS`（``，`core/src/index.ts`）、中英之間的空白不斷句，含英文的片段每 200 個留一個到 `mixed-heldout.txt`（不訓練）；第二個參數 0＝只建 PTT。中英評測集 `eval/mixed.jsonl`（`scripts/build-mixed-eval.ts`）。解碼器把含拉丁字母的原樣 token 當 `EN_CLASS` 查 LM（`decode.rs` `is_english`），輸出原字。數字見 docs/MEMORY.md §7。
- `LM_TOKEN_PENALTY`（預設 14）必須大於高頻單字的 log(freq)，否則訓練斷詞會把詞切成單字。
- 挖詞：`npx tsx packages/data-pipeline/scripts/mine-words.ts [lm.tsv] [lexicon.jsonl] [mined.jsonl]`（約 3 分鐘）從 lm.tsv 的詞計數挖常用複合詞 → `data/processed/mined.jsonl`（provenance=mined），`npm run data:lexicon` 合併進詞典；之後要重訓 lm.tsv、重建 lm.bo.bin 新詞才有機率。門檻與數字見 docs/MEMORY.md §7。
- 記憶體分析、微軟注音的宿主方式、縮小方案、挖詞與中英混打的實驗：`docs/MEMORY.md`（檔頭是現況表，下面是依日期的實驗紀錄）。PIME 的架構、協定、後端生命週期、當機事故：`docs/PIME-NOTES.md`。安裝到 PIME 的教學：`docs/PIME-INSTALL.md`。
- 已量過、不要重試：開放定址 fp=32 句 −1.5／−2.6（查不到的鍵約 0.7% 誤中）；load 0.9 慢約 25%；q6／q4 有損；mmap 對 TS 的雜湊表無效（10 句內讀到 91–100% 的頁）。

### Engine (`native/`)

L1–L5、L3、X2、`ImeEngine`（`engine.rs`）、PIME 後端協定（`pime.rs`）；打字中私有記憶體約 13–15MB（`lm.bo.bin` 記憶體映射，`docs/PROJECT.md` §5）。指令從 repo 根目錄跑，`ZHUYIN_DATA=<data>`（預設 `data`），用法見 `native/src/main.rs` 檔頭：

- `eval [fails-out]`：`eval/colloquial`、`written`、`mixed` 的句準（dev＝偶數句／test＝奇數句）、字準、N-best oracle、延遲。一設定一行程，用環境變數換設定：`ZHUYIN_A`（預設 1）、`ZHUYIN_GAMMA`、`ZHUYIN_POLY`、`ZHUYIN_POLY_MINOR`、`ZHUYIN_BEAM`、`ZHUYIN_NBEST`、`ZHUYIN_LM`；L3：`ZHUYIN_NOISE=key,cog`（`noise.rs` 注入合成錯誤，每句種子 1000+i）配 `ZHUYIN_L3=1` 或 `ZHUYIN_L3_SCALE=s`（代價 × s，另有 `_NASAL`、`_MAXALTS`），會多印「有錯的句子」與涵蓋率；`ZHUYIN_EVAL=<檔,…>` 換評測檔；`ZHUYIN_INCR=1` 逐音節比對增量解碼（`decode.rs` `Lattice`，`ImeEngine` 每鍵用它）與全量解碼，不同就 panic，並印每步延遲（改 `decode_in` 後必跑）。不讀 adapter.json。
- `usage <usage.jsonl> [eval-out]`：使用紀錄的統計（不用改就對、每 100 字選字修正、最常改的字、L3 更正）；eval-out 轉成評測集格式（音節照實際打的）。紀錄由學習資料頁的「使用紀錄」開關打開（config `usageLog`，預設關），每次送出 `ImeEngine` 往 `usage_lines` 加一行（`engine.rs` `usage_record`，有選字時另解碼一次求原本的第一名），`pime.rs` `flush_usage` 在每則請求後附加到設定檔旁的 `usage.jsonl`，超過 10MB 留後一半。
- 標點：注音模式的 Shift 組合打半形（`SHIFTED`，原樣字元）；Shift＋字母走英文模式那段（`on_key` 的 `shift` 參數，CapsLock 不影響注音）；Ctrl＋原按鍵打全形（`engine.rs` `ctrl_punct`，`pime.rs` 在 filterKeyDown 攔下、`ImeEngine::on_punct` 處理；Ctrl+Shift+[ ] → 『』）；英文模式的 Ctrl 組合交給應用程式。1.0.1 的 `halfWidth` 設定已拿掉（右鍵選單 id 6 不再用）。
- `dump`、`keys`、`l3`、`replay`：倒 N-best、L1/L2 按鍵、L3 解碼、重播按鍵事件。
- 英文模式：切換不送出組字區；組字中打的字母、數字併進游標前的英文 token（`slots.rs` `append_english`），前面的中文跟著重解碼；英文模式下空白、標點才整段送出；退格一次退一個字母。`EngineState.cursor` 是字數（英文 token 照長度）。
- 簡體輸出（config `simplified`、Ctrl+Shift+F、右鍵選單 id 20）：`pime.rs` `handle` 最後把回應的 compositionString／commitString／candidateList 轉簡（`t2s.rs`，OpenCC 表原樣在 `native/src/opencc/`，只收 UTF-16 等長的條目，游標不用重算）；引擎、X2、使用紀錄都是繁體。
- X2 選字加成的鍵是該詞自己的讀音（以前傳整句，bySeq 從沒生效）。

PIME（架構、協定、生命週期、當機事故的細節與理由見 `docs/PIME-NOTES.md`）：

- `zhuyin-native pime` 走 stdin/stdout 協定，第一個組字鍵才載入引擎、閒置 `ZHUYIN_IDLE_SECS`（預設 300）秒或最後一個 client 停用就卸載（`debug-pime-idle.ts` 量記憶體與重新載入延遲）。
- 設定檔 `%APPDATA%\PIME\zhuyin\config.json`（`shiftToggle`／`layout`／`simplified`／`idleSecs`／`l3`／`usageLog`／`learning`）。
- `onCommand`、`onMenu` 等沒有 edit session 的回應不能帶 `showMessage`（PIME 的 DLL 會解參考空指標、宿主程式當掉）。
- 每則帶 seqNum 的請求（含 close）都要回同一個 seqNum：PIMELauncher（beta3 的 Rust 版）15 秒沒收到回應就殺掉後端重開（2026-10-21 不回 close，每關一個程式 15 秒後打字就斷掉）。
- PIME 的 DLL 在 RPC 失敗（啟動器停了、2 秒沒回、後端死掉）時會讓所有用著它的程式當掉（Explorer 一秒一次），所以**絕不停 PIMELauncher**、後端每則請求都要很快回且不能在處理中結束。
- `install.ps1` 用改名取代覆寫、不停 PIME、**不從 `backends.json` 拿掉其他後端**（2026-10-20 這樣做讓 Explorer 連續當機；鍵盤清單由 `run.ps1` 用 `-Keyboard add` 加入本專案，其他照舊；裝 PIME 前後 `Update-Pime` 把清單換回原樣，因為 PIME 的安裝程式會把新酷音等全加進去），`-Rollback` 換回 `zhuyin.prev\`。安裝時順便把 PIME 升到 GitHub 上最新版（`Update-Pime`：驗 SHA-256、`/S`；PIME 目錄有排在重開機刪除的檔就不裝，beta4 的安裝程式靜默時看到會直接重開機），`-NoPimeUpdate` 關掉。
- 檢查：`debug-pime.ts` 會依 DLL 的讀法檢查每則回應的格式與時間；`ZHUYIN_DATA=<data> npx tsx debug-pime.ts zhuyin [N]` 先做行為檢查（含點圖示、右鍵選單、選字反白、表格展開、清單最後一項是注音、選字後游標、視窗外 ↑ 換字、只用左／右 Shift、半形／Ctrl 全形標點、組字中 Tab／F1–F12／Insert 先送出再放行、使用紀錄）再打 N（預設 1500）句；隨機按鍵壓力測試 `ZHUYIN_DATA=data npx tsx debug-pime-fuzz.ts [按鍵數] [種子]`（stderr 有 panicked 就算失敗）。
- 安裝：使用者文件 `docs/PIME-INSTALL.md`；安裝檔與 `install.ps1` 在 `native/pime/`；使用者雙擊 `install.cmd`／`uninstall.cmd`／`rollback.cmd`（`run.ps1`：一般權限建置、只把 `install.ps1` 提權、記錄檔顯示結果），`build-setup.cmd` 用 Inno Setup 編單一 Setup.exe（`install.ps1 -From`）；`run.ps1 stage` 只組檔案不動系統，可拿來測（不要自己執行安裝）。

和其他輸入法比較（數字見 `docs/PIME-NOTES.md` §2）：PIME 新酷音／小麥注音用 `npx tsx debug-pime.ts chewing|mcbopomofo [N]` 直接驅動 PIME 後端（模擬 TSF DLL 的 stdin/stdout 協定，不佔鍵盤；新酷音會學進 `%APPDATA%\PIME\chewing\chewing.sqlite3`，跑前先刪）。微軟注音只能走 GUI：`debug-ms-keys.ts` 產生大千 VK 序列，`debug-ime-bench.ps1 -Ime ms` 包住 `debug-ms-bopomofo.ps1`（SendInput 打進自己的 WinForms 文字框；要 IMM `ImmSetOpenStatus` 才會進中文模式、`timeBeginPeriod(1)` 才跑得快；前景被搶就中止；PIME 在這個文字框裡收不到按鍵），會佔用鍵盤，使用者不在電腦前才能跑。

Root-level `debug-*.ts` are investigation scripts (`npx tsx debug-xxx.ts`) that reach into `packages/*/src` directly; the current list (with the `.ps1` ones) is in `docs/PROJECT.md` §7. Scripts that `docs/MEMORY.md` marks with † are in the `archive/ts-engine` tag.

### 已封存

- **TS 引擎**：git tag `archive/ts-engine`（2026-10-24）。內容：`core` 的 `decode.ts`／`l3.ts`／`x2.ts`／`slots.ts`、`packages/cli`（`ImeEngine`、`runtime.ts`、網頁測試台、`eval`／`sweep`／`--baseline classic|bigram`／`--idf`、`noise.ts`）、對拍腳本 `debug-native-parity.ts`、實驗台 `debug-acc`／`debug-shrink`／`debug-prune`／`debug-decode-dump`／`debug-alloc`／`debug-latency`／`debug-mem`／`debug-l3`／`debug-x2-*`／`debug-user-phrase`／`debug-ms-compare` 等。Rust 註解裡的「同 engine.ts／decode.ts」指的是這個 tag 裡的檔案。封存時兩邊輸出逐位元組相同；`zhuyin-native eval` 的數字與 TS `eval`／`debug-l3.ts` 逐項相同（TS 解碼器預設 a=0.8，對照時設 `ZHUYIN_A=0.8`）。
- **L6 神經重排、L7 防閃動**：git tag `archive/l6-l7`。內容：`packages/rerank`（BERT PLL、`RerankWorker`、Kev 客戶端）、`ImeEngine` 的 `RerankHooks`／`stickBonus`、web 的 L6 切換與 SSE、eval 的 `--rerank`／`--kev`。封存原因：依賴與模型太肥（transformers＋onnxruntime、`data/models/hf` 391MB、Kev venv 7.6GB）。要點：Kev（`runs/zy-choice16k` w=3）80.4/89.0%；BERT 要 fp32、要在 worker 跑；防閃動用軟加分（硬鎖前綴掉 5–6 點）。Kev 伺服器、訓練資料、BERT 模型與 Qwen 權重已於 2026-10-16 刪除，要重做得重新下載與訓練。

## Architecture

Layered pipeline (layer names appear throughout comments):
L0 key events → L1 keymap → L2 slot composition → L3 hypothesis expansion (motor/cognitive channels) → L4 lattice → L5 decode (L6 neural rerank / L7 display hysteresis archived, see above), plus cross-cutting X1 domain prior, X2 user adaptation, X3 telemetry.

| Part | Role |
|---|---|
| `native/` | The engine. `keymap.rs` (L1 `Layout`: 大千／倚天／許氏／IBM／倚天 26，鍵位照 libchewing key_str), `slots.rs` (L2 `CompositionBuffer`), `l3.rs` (L3 `Channel`), `decode.rs` (L4+L5 `Decoder`), `x2.rs` (`UserAdapter`), `engine.rs` (`ImeEngine`), `pime.rs`, `learned_web.rs`, `noise.rs` (X3 synthetic errors for eval) |
| `@zhuyin/core` | Shared TS types and tables: syllable parts, `LexiconEntry`／`Provenance`, `keymap.ts` (`syllableToKeyCodes` for test drivers), `lexicon.ts` (`LexiconIndex` → lexicon.bin), `nontrad.ts`, `EN_CLASS` |
| `@zhuyin/lm` | n-gram LM training (`train.ts`, unigram-DP word segmentation), `shrink.ts` → lm.bo.bin |
| `@zhuyin/data-pipeline` | Source download → cleaning → lexicon / lexicon.bin / syllables / corpus / eval set. Source URLs, licenses and revisions live in `src/config.ts` |

Key design points (from comments in `decode.rs`):

- Decoder score is **log-linear**: `Σ a·logP_word(w|prev 2 words) + γ·logP_char(chars|prev 2 chars)`, plus a sentence-end term `P(EOS|last 2)`. Do not convert to linear interpolation (between the word and char experts; *within* each n-gram, interpolated Kneser-Ney is the default — it beat stupid backoff by ~12 points sentence accuracy).
- Heteronym single chars: `poly_penalty` 1 on every poly single char (2.5 until 2026-10-27; 1 is +1.0/+1.0/+1.5 sentence on colloquial/written/mixed, −0.5 on L3 noisy input), plus `poly_minor_penalty` 6 when it is used with a non-main reading (main = first reading in the lexicon, ordered by libchewing per-reading freq; stored in `lexicon.bin` `poly` as `字\t讀音`). The LM is reading-agnostic, so without it ㄑㄧㄤ gave 將 (freq from ㄐㄧㄤ) over 槍. Inside words (將進酒) no penalty. Eval +2.3 / +2.2 sentence.
- N-best uses list-Viterbi (K partial paths per two-word state), not "last two words differ".
- L3 (`l3.rs` `Channel`): expands each observed syllable into legal intended syllables with a cost (adjacent key, extra/missed key, adjacent tone key, fuzzy pairs ㄣㄥ/ㄓㄗ/…, wrong tone; ㄣ/ㄥ has its own lower cost `nasal` = 3.5 so ㄧㄣ ㄍㄞ → 應該, other fuzzy pairs 15); defaults are ×3 the original costs because a wrong correction is worse than none (×1.5 turned typed 文檔 into 存檔); one edit per syllable, at most one corrected syllable per word. Decoder adds −cost and records `reading`. Single-syllable corrections only apply when the observed syllable has no lexicon entries (`alt_single_only_if_empty`): enabling them recovers ~7 more points on noisy input but makes decoding 5–8× slower. Evaluated only on synthetic errors (`noise.rs`, shares the adjacency/fuzzy tables with L3 → optimistic); real typing data only comes from the opt-in usage log (`usage`, off by default), and none has been measured yet. X2 learns from `breakdown.reading`, not the observed (typo) syllables.
- Words added at runtime (`Decoder::add_entry`: user phrases, mined words) that the word LM doesn't know get the best word-level score of a split into known words (`parts_log_prob`, 2–6 chars), not the unknown-word penalty (~−31); the manual-phrase boost (+8, +10 per syllable beyond 2 up to 6) goes on top. Without it a picked phrase like 狀態欄 never wins (docs/MEMORY.md §7「狀態欄」).
- `UserAdapter` (X2) state persists to `%APPDATA%\PIME\zhuyin\adapter.json`; user phrases are also added live via `add_entry`. Bounded (10k seq records, 10k global, 5k mined, 20k manual hard cap; decayed count < 0.025 is dropped; compact on load and every 2,000 new entries): the file plateaus near 2MB, ~17ms per save (docs/MEMORY.md「X2 學習資料的成長」).
  - Learning on commit is strict since 2026-10-21 (the user's data was full of mis-segmented fragments): mined words are 2–4 chars and enter the decoder only after showing up in `MINED_MIN_FREQ` = 2 separate commits; mined runs, picked runs and rule-4 joins whose first or last char is in `PARTICLE_EDGE` (`engine.rs`: STANDALONE + 嗎呢吧啊呀喔哦) are not learned. On commit, a picked word (or the run of single chars containing a picked char, or a picked single char joined to the adjacent multi-char word, ≤4 chars) is saved as a manual user phrase, since a once-selected mined word otherwise loses to the LM.
  - PIME's right-click「學習資料與使用紀錄…」serves a page from a loopback server (`learned_web.rs`: token, Host and Origin checks; stops 3 s after the last tab sends `/close` on pagehide, or after 3 min without the page's 60 s `/ping`) whose delete buttons call `delete_learned` (adapter `remove_phrase`／`remove_selection`, `Decoder::remove_entry`, save at once); `POST /action` (`web_action`) toggles learning (config `learning`, default on; `ImeEngine::set_learning(false)` zeroes U(w) and removes user/mined entries from the decoder via `take_entries`, `true` re-injects them; stays off when adapter.json was unreadable) and the usage log, deletes the usage log, or clears everything (usage log, adapter replaced by an empty one, `learned.html` snapshot). The page also shows `usage::summary` of the log. End-to-end check `debug-learned-web.ts`.

## Data licensing constraints

- Every derived lexicon entry carries a `provenance` field (`moedict` | `libchewing` | `user` | `mined`). Keep it when adding sources.
- libchewing data is LGPL-2.1: redistribute as-is with license notice; mark any modification.
- moedict requires source attribution. GPL model weights must not be committed; users fetch them via script.
