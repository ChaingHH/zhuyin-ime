# 專案全貌：zhuyin-ime

本文件描述整個專案的目標、架構、各部分的實作細節、資料流程、評測方式與已知限制。
指令速查見 [CLAUDE.md](../CLAUDE.md)；授權與資料來源摘要見 [README.md](../README.md)。

> 文件內容以 2026-10-24 的程式碼為準。數字（預設值、實測準確率）都來自程式碼註解或 CLAUDE.md，
> 改參數時請同步更新本文件。2026-10-27 對照程式碼核對過 §3、§5、§7、§10。

## 1. 目標

做一個注音（大千排列）輸入法，引擎用 Rust 寫（`native/`），以 PIME 後端的形式在 Windows 上執行。
資料管線與模型訓練用 TypeScript 寫（`packages/`）。

現有注音輸入法（libchewing、McBopomofo）只有語言模型 `P(H)`，而且多半只到詞 unigram／bigram。
本專案以微軟拼音的功能清單為藍本，補兩塊：

- **通道模型 `P(K|S)`**：使用者按的鍵 K 跟想打的音節 S 不一致時（按到隔壁鍵、模糊音、記錯聲調），仍能解出正確句子。
- **現代語言模型 `P(H)`**：詞級＋字級三元 Kneser-Ney。

解碼目標：`argmax_H P(H) · P(K|S(H))`，實作上是 log 空間的加總。

## 2. 分層架構

| 層 | 名稱 | 實作位置 | 狀態 |
|---|---|---|---|
| L0 | 按鍵事件 | `native/src/pime.rs`（PIME 的 keyCode → `KeyboardEvent.code`） | 完成 |
| L1 | 鍵盤映射 | `native/src/keymap.rs` | 完成（只有大千） |
| L2 | 槽位組字 | `native/src/slots.rs` `CompositionBuffer` | 完成 |
| L3 | 假設展開（運動／認知通道） | `native/src/l3.rs` `Channel` | 完成，只用合成錯誤評測過 |
| L4 | 詞格 | `native/src/decode.rs` `span_cands` | 完成 |
| L5 | 解碼 | `native/src/decode.rs` `Decoder::decode` | 完成 |
| L6 | 神經重排 | — | 已封存（tag `archive/l6-l7`） |
| L7 | 呈現遲滯（防閃動） | — | 已封存（tag `archive/l6-l7`） |
| X1 | 領域先驗 | `native/src/decode.rs` `domain_bonus`、`native/src/domain/tech.txt` | 完成（只有軟體／科技一份詞表，沒有開關） |
| X2 | 使用者適應 | `native/src/x2.rs` `UserAdapter` | 完成 |
| X3 | 遙測 | `native/src/noise.rs`（合成錯誤）、`engine.rs` `usage_record`（使用紀錄） | 使用紀錄預設關閉 |

一次按鍵的資料流：

```
PIME filterKeyDown／onKeyDown（keyCode、charCode、keyStates）
  → L1 map_key：code → 注音符號或聲調
  → L2 CompositionBuffer：符號填入四槽，按聲調鍵完成一個音節
  → （音節序列有變才繼續）
  → L3 Channel::expand：每個觀察音節 → 可能的意圖音節＋代價
  → L4/L5 Decoder::decode：詞格 + list-Viterbi → N-best
  → 組字區顯示 L5 首選
  → commit：送出文字，X2 記錄選字、挖新詞；使用紀錄開著時記一行
```

### 2.1 各層作法與實例

每層分三部分：作法、解決的問題、例子。實作細節見第 3 節。

- 標「實測」的例子：2026-10-15 對當時的 TS 網頁測試台（已封存，tag `archive/ts-engine`）送按鍵得到的輸出，模型是 `lm.tsv`，L3 開著。Rust 引擎與 TS 引擎輸出逐位元組相同。
- 標「示意」的例子：依程式碼邏輯推導，沒有實際跑過。
- L3 的錯誤都是人工造的，不代表真實打字的效果。

**L0 按鍵事件**

- 作法：記錄實體鍵位 `KeyboardEvent.code`，不記錄字元。標點另外看 `KeyboardEvent.key`（TSF 依修飾鍵轉出的字元）。
- 解決：L3 要知道實際按了哪顆鍵，才算得出鄰鍵。
- 例子：按 R 鍵，記成 `KeyR`，不是記「ㄐ」。

**L1 鍵盤映射**

- 作法：查表，把鍵位轉成注音符號或聲調，同時保留來源鍵位。
- 解決：把鍵盤排列跟後面的層分開。加新排列只需要換表。
- 例子（實測）：`KeyR` → ㄐ、`KeyU` → ㄧ、`KeyP` → ㄣ、`Space` → 一聲、`Digit3` → 三聲。

**L2 槽位組字**

- 作法：符號依類別填入四槽（聲母、介音、韻母、聲調），跟按鍵順序無關。按聲調鍵代表這個音節完成。
- 解決：音節內的順序顛倒自動吸收；同槽重按時，後按的覆蓋先按的；檢查完成的音節是否合法。
- 例子（實測）：
  - 按 ㄣ ㄧ ㄐ 空白 → `ㄐㄧㄣ`
  - 按 ㄐ ㄍ ㄧ ㄣ 空白 → `ㄍㄧㄣ`（ㄍ 覆蓋 ㄐ）
  - 打出 `ㄅㄩˋ` → 標記為不合法

**L3 假設展開**

- 作法：每個打出的音節展開成可能的意圖音節，各帶一個代價。每個音節只假設一處錯誤，每個詞最多更正一個音節。
- 解決：處理 L2 吸收不了的錯誤：按到鄰鍵、多按、漏按、模糊音、聲調錯。
- 例子（實測，`Channel.expand`，當時的代價是現在的一半）：
  - `ㄐㄧㄥ` → ㄐㄧㄥ:0、ㄐㄧㄣ:7.5（模糊音）、ㄑㄧㄥ:9（鄰鍵）、ㄐㄧ:10.5（多按）……
  - `ㄗㄨˋ` → ㄓㄨˋ:7.5（平捲舌）、ㄗㄨˇ:7.5（相鄰聲調鍵）……

整句送進測試台的結果（實測，代價為 ×1.5 時）：

| 錯誤類型 | 打的音節 | 輸出 |
|---|---|---|
| 模糊音 ㄣ→ㄥ | **ㄐㄧㄥ** ㄊㄧㄢ ㄊㄧㄢ ㄑㄧˋ ㄏㄣˇ ㄏㄠˇ | 今天天氣很好 |
| 鄰鍵（P 按成 O） | ㄊㄧㄢ ㄑㄧˋ **ㄏㄟˇ** ㄏㄠˇ | 天氣很好 |
| 漏按（漏 ㄧ） | ㄐㄧㄣ **ㄊㄢ** ㄊㄧㄢ ㄑㄧˋ | 今天天氣 |
| 聲調錯（ˊ 打成 ˋ） | ㄨㄛˇ ㄒㄧㄤˇ ㄑㄩˋ **ㄊㄨˋ** ㄕㄨ ㄍㄨㄢˇ | 我想去圖書館 |
| 不合法音節 | ㄨㄛˇ **ㄅㄩˋ** ㄓ ㄉㄠˋ | 我不知道 |

L3 的更正要靠上下文才會發生。以鄰鍵那一句為例，逐音節畫面是 `天 → 天氣 → 天氣黑 → 天氣很好`。「黑」本身是合法的字，所以先顯示「黑」。打到「好」之後，「天氣很好」這條路徑扣掉更正代價以後，分數仍然高於「天氣黑好」，所以改成「很」。

**L4 詞格**

- 作法：對每個（起點, 長度）從讀音索引查出所有候選詞，組成一張圖。
- 解決：同一串音節有很多種斷詞和同音詞組合，要先全部列出，L5 才能挑。
- 例子（示意）：`ㄆㄧㄥˊ ㄊㄧㄠˊ ㄇㄚˇ` 的詞格同時包含 [憑][條碼]、[平調][碼]、[瓶][條][馬]……

**L5 解碼**

- 作法：用 list-Viterbi 在詞格上找出分數最高的幾條路徑。分數 = 詞三元 × a + 字三元 × γ − L3 代價 + X2 加分。
- 解決：從所有組合中挑出最像自然句子的一句。後文會改寫前面的選字。
- 例子（實測，逐音節畫面）：
  - `我想去突 → 我想去圖書 → 我想去圖書館`
  - `顆 → 可以 → 可以憑 → … → 可以憑條碼領取`

**X2 使用者適應**

- 作法：記錄每次送出時「哪個讀音選了哪個詞」，換成有上限、會隨時間衰減的分數加成。連續的單字會被挖成新詞。
- 解決：學會使用者的用字習慣，但不像 McBopomofo 那樣硬插詞條、把正確候選擠掉。
- 例子（示意）：
  - 在 ㄐㄧㄤˋ ㄒㄧ 一直選「降息」 → 「降息」的加成最多到 +2.2。
  - 送出的路徑裡有連續單字「降」「息」，而且詞庫沒有「降息」 → 記一次；第二次送出又出現才挖成新詞加入詞格。

## 3. 程式碼

### 3.1 引擎（`native/`）

Rust，相依只有 `indexmap`、`serde_json`。其他檔案：`lexicon.rs`（唯讀 `lexicon.bin`＋執行中加詞的疊加層）、`lm.rs`（記憶體映射讀 `lm.bo.bin`）、`usage.rs`（使用紀錄統計）、`learned_web.rs`（學習資料頁）、`nontrad.txt`（非台灣繁體字表：學習資料裡含這些字的詞不加進解碼器）。`cargo build --release` 產生 `native/target/release/zhuyin-native.exe`，指令見 `native/src/main.rs` 檔頭。

**L1 鍵盤映射**（`keymap.rs`）

- 只有大千排列 `DACHEN`。聲調鍵固定：Space=一聲、6=ˊ、3=ˇ、4=ˋ、7=˙。
- `syllable_to_key_codes`：音節 → 鍵碼序列。`keys` 指令與合成錯誤用它把音節變回鍵流。
- `key_neighbors`：標準 ANSI 交錯鍵盤上中心距離 ≤ 1.3 的鍵。

**L2 槽位組字**（`slots.rs`）

- 每個符號依類別填自己的槽，與按鍵順序無關。所以音節內順序顛倒（例如先按韻母再按聲母）不需要 L3 處理。
- 同一槽再按一次 → 覆蓋（與微軟注音一致）。
- 按聲調鍵 → 完成音節，回報是否在合法音節表內。
- Backspace 先退未完成的槽，再退已完成的音節。
- 組字區有游標；標點與英文 token 插在游標處（`push_literal`、`append_english`）。

**L3 通道模型**（`l3.rs`）

`Channel::expand(observed)` 回傳意圖音節清單。第一個永遠是觀察音節本身（代價 0），其餘依代價遞增。

| 錯誤類型 | 選項 | 預設代價（log 單位） |
|---|---|---|
| 按到實體相鄰鍵 | `sub` | 18 |
| 多按一鍵 | `extra` | 21 |
| 漏按一鍵 | `miss` | 24 |
| 按到相鄰聲調鍵（3↔4、6↔7） | `tone_adj` | 15 |
| 記錯聲調 | `tone` | 21 |
| 模糊音 | `fuzzy` | 15 |
| 前後鼻音 ㄣ/ㄥ | `nasal` | 3.5 |

- 模糊音對：ㄣ/ㄥ、ㄓ/ㄗ、ㄔ/ㄘ、ㄕ/ㄙ、ㄈ/ㄏ、ㄌ/ㄋ、ㄌ/ㄖ。
- 每個音節只展開一處錯誤，最多保留 24 個替代（`max_alts`）。
- 預設代價是初始值 ×3（2026-10-20 從 ×1.5 調高）。原則：寧可不修，也不要把照打的字改錯。
- ×1.5 會把照打、詞典沒有的「文檔」（ㄨㄣˊ ㄉㄤˇ）改成「存檔」（當成漏按 ㄘ）。×2 起就不會。
- 合成錯誤（每鍵 3%、每音節 3% 認知錯誤）的 dev/test 句準（2026-10-20，當時的模型）：

  | 設定 | 乾淨口語 | 乾淨書面 | 有錯口語 | 有錯書面 |
  |---|---|---|---|---|
  | L3 關 | 76.8/76.2 | 76.4/81.6 | 23.2/22.2 | 22.0/28.8 |
  | ×1.5（舊預設） | 76.2/75.0 | 75.6/80.8 | 52.0/46.0 | 52.8/57.2 |
  | ×3（預設） | 76.4/75.8 | 75.6/81.2 | 41.6/38.8 | 43.6/50.4 |

  重跑：`ZHUYIN_NOISE=0.03,0.03 ZHUYIN_L3_SCALE=<s> zhuyin-native eval`（s=1 是 ×1，預設 ×3 用 `ZHUYIN_L3=1`）。

- 乾淨輸入剩下的損失主要來自 `nasal`：設 5 時乾淨書面回到 76.4/81.6，但 ㄧㄣ ㄍㄞ 就不會改成「應該」。

**L4/L5 解碼**（`decode.rs`）

分數是 log-linear：

```
Score = Σ_詞 [ a·logP_word(w | 前兩詞)
             + γ·logP_char(w 的每個字 | 前兩字)
             + U(w)          ← X2 使用者加成
             − cost(w) ]     ← L3 更正代價
      + a·logP_word(EOS | 末兩詞) + γ·logP_char(EOS | 末兩字)
```

- 詞級與字級是兩個獨立專家，**相加，不做線性內插**。
- PIME 與 `eval` 都用 `a=1`、`γ=0.5`。
- 詞格：每個 (起點, 長度) 從讀音索引取候選詞，最長 10 音節，每格最多 48 個（依詞頻）。
- L3 更正：每個詞最多更正一個音節，每個更正讀音最多取 8 個詞（`alt_entry_cap`）。
- 單音節更正只在觀察音節查無任何詞時才做（`alt_single_only_if_empty`）。全開可在有錯輸入上多救約 7 點，但解碼慢 5–8 倍。
- 查無詞的音節用未知詞 `□` 補上，確保詞格連通。
- 破音單字額外扣 `poly_penalty=2.5`；用的是次要讀音時再扣 `poly_minor_penalty=6`。
- N-best 用 **list-Viterbi**：狀態是「前兩詞」，每個狀態保留 K 條部分路徑（預設 4），全域 beam 上限 200。
- 每條路徑附 `breakdown`：逐詞的詞與採用的讀音（`reading`）。
- 含拉丁字母的原樣 token 當 `EN_CLASS` 查 LM（`is_english`），輸出原字。
- `add_entry` 可在執行中加詞（X2 造詞、挖詞），不重建索引。LM 不認得的新詞用拆成已知詞的最佳分數（`parts_log_prob`）。

**X2 使用者適應**（`x2.rs`）

- 原則：**修改分數，不硬插詞條**。McBopomofo 把使用者詞以最高分硬插，會擠掉正確候選。
- `record_selection`：每次送出記錄（讀音, 詞）的次數與時間，另記全域次數。
- `modifier_for` 回傳加成：
  - 同讀音紀錄：`min(2.2, 0.55·ln(1+次數))`
  - 全域紀錄：上限 1.1，再乘 0.35
  - 兩者都乘時間衰減，半衰期 14 天
  - 手動造詞：+8，3 音節以上每多一個音節再 +10（算到 6 音節，`MANUAL_PHRASE_BOOST_PER_SYLLABLE`），不再加同讀音與全域加成
- `mine_word`：送出時，連續 2–4 個單字詞、組合不在詞庫、頭尾不是虛字 → 記一次；兩次送出都出現才加入詞格。
- 狀態存在 `%APPDATA%\PIME\zhuyin\adapter.json`，有筆數上限，檔案約在 2MB 持平。

**引擎與 PIME**（`engine.rs`、`pime.rs`）

- `ImeEngine::on_key`：英文模式直接回傳字元（組字中併進英文 token）；注音模式送進 L2，已完成音節序列有變才重新解碼（整句重解，不是增量）。
- 標點：Shift 組合打出半形（`SHIFTED`）；注音模式的 Ctrl＋原按鍵打全形（`ctrl_punct`，例如 Ctrl+, → ，、Ctrl+[ → 「、Ctrl+Shift+[ → 『）。英文模式的 Ctrl 組合交給應用程式。
- ↓ 開選字視窗，選的詞成為之後解碼的固定段（`fixed`）。
- `commit(k)`：送出第 k 個候選，觸發 X2 學習。X2 學的是 `breakdown.reading`（L3 更正後的讀音），不是打錯的觀察讀音。
- 學習資料頁（右鍵選單「學習資料與使用紀錄…」，`learned_web.rs`、`learned.html`）：刪除學到的詞、學習開關（關掉時加分歸零、使用者詞與挖詞從解碼器拿掉）、使用紀錄開關與統計（`usage.rs`）、全部清除。
- 使用紀錄（學習資料頁的開關，預設關）：每次送出往 `%APPDATA%\PIME\zhuyin\usage.jsonl` 加一行，欄位見 `engine.rs` `usage_record`；超過 10MB 丟掉舊的一半。`zhuyin-native usage <檔>` 統計。
- PIME 協定的限制（不能停 PIMELauncher、每則請求都要回 seqNum 等）見 CLAUDE.md 與 [PIME-NOTES.md](PIME-NOTES.md)。

**`noise.rs`**：在按鍵層級注入錯誤（鄰鍵 60%、漏按 20%、多按 20%；認知錯誤中模糊音 70%、聲調 30%），再走真正的 L2，得到「打錯後的音節序列」。用固定種子的 mulberry32 亂數，可重現。

### 3.2 TypeScript 套件

npm workspaces monorepo。套件之間透過各自的 `dist/` 互相引用，所以改了一個套件要先 `npm run build`。

| 套件 | 依賴 | 職責 |
|---|---|---|
| `@zhuyin/core` | 無 | 共用型別與表：音節、`LexiconEntry`、`keymap.ts`（給測試腳本產生按鍵）、`lexicon.ts`（`LexiconIndex` → lexicon.bin）、`EN_CLASS` |
| `@zhuyin/lm` | 無 | n-gram 訓練、`shrink.ts` 產生引擎用的退回式模型 |
| `@zhuyin/data-pipeline` | core、`opencc-js` | 下載、清洗、建詞庫／lexicon.bin／語料／評測集 |

**`@zhuyin/lm` 訓練**（`train.ts`）

1. 讀 `lexicon.jsonl` 的詞與詞頻。
2. 每句用 unigram-DP 斷詞（全域最佳，不是貪婪最長匹配）。詞的代價 = `LM_TOKEN_PENALTY − log(freq+1)`。未登錄單字另加 `log(20)`。
3. 統計詞級與字級的 1/2/3-gram。二元全保留，三元只留次數 ≥ 2（`LM_MIN_TRI`）。
4. 輸出逐行 `.tsv`：`section\tcount\tkey`。section 是 `wu/wb/wt/cu/cb/ct`（word/char × uni/bi/tri），第一行是 `#meta`。

`LM_TOKEN_PENALTY` 預設 14。這個值必須大於高頻單字的 `log(freq)`（約 11–13.5），否則單字代價變負，DP 會把詞切碎。訓練時用 JS `Map`，大語料需要 `--max-old-space-size=34000`。

**`@zhuyin/lm` 縮小**（`shrink.ts`、`backoff.ts`）

- 從 lm.tsv 算好 interpolated Kneser-Ney 機率與退回權重，加權差異剪枝到 12M 筆，8 位元碼本量化，存成 `lm.bo.bin`（大表 46MB）。
- 表是最小完美雜湊（`hashtable.ts` `PerfectTable`），引擎用記憶體映射讀。

**`@zhuyin/data-pipeline`**

來源的網址、授權、版本集中在 `src/config.ts`。

| 指令 | 輸出 | 內容 |
|---|---|---|
| `cli.ts download` + `lexicon` + `lexbin` | `data/processed/lexicon.jsonl`、`lexicon.bin` | 萌典 + libchewing（+ 挖出的詞）合併，逐筆帶 `provenance`；bin 給引擎讀 |
| `cli.ts syllables` | `data/processed/syllables.json` | 詞庫出現過的全部音節（L2 合法性檢查、L3 候選過濾） |
| `cli.ts corpus` | `data/processed/corpus/` | PTT 口語 + 書面語抽樣（小語料） |
| `cli.ts evalset` | `eval/colloquial.jsonl`、`eval/written.jsonl` | 固定種子抽樣的評測句 |
| `scripts/extract-wiki.py` | `data/raw/wiki/*.jsonl` | 維基百科抽文字 |
| `scripts/build-big-corpus.ts` | `data/processed/corpus-big*/` | 大語料：PTT 全量 + 維基 |
| `scripts/build-mixed-eval.ts` | `eval/mixed.jsonl` | 中英混打評測集 |
| `scripts/mine-words.ts` | `data/processed/mined.jsonl` | 從 lm.tsv 挖常用複合詞 |

大語料的處理方式：

- 取「連續中文字片段」（≥4 字），不做整句清洗。PTT 用空白、半形標點斷句又夾英數，整句規則會丟掉九成。
- 簡體轉繁體用 OpenCC `cn → twp`。
- **防洩漏**：任何片段只要包含評測句就丟掉。以評測句前 6 字建索引比對。

評測集格式：第一行是 meta（種子、句數），之後每行 `{text, tokens, syllables}`。口語 1000 句、書面 500 句、中英 1000 句。

## 4. 資料與模型檔案

`data/raw`、`data/models`、`data/user` 都在 `.gitignore` 內，需要自己產生。

| 檔案 | 產生方式 | 誰用 |
|---|---|---|
| `data/processed/lexicon.jsonl` | `npm run data:lexicon` | LM 訓練、評測集、lexicon.bin |
| `data/processed/lexicon.bin` | `npm run data:lexicon`（`lexbin`） | 引擎 |
| `data/processed/syllables.json` | `cli.ts syllables` | 引擎（L2、L3） |
| `data/processed/corpus-big2/` | `build-big-corpus.ts` | LM 訓練 |
| `data/models/lm.tsv` | `lm/src/train.ts`（約 1GB，約 17 分鐘） | `shrink.ts` |
| `data/models/lm.bo.bin` | `lm/src/shrink.ts`（約 4 分鐘） | 引擎 |
| `eval/*.jsonl` | `cli.ts evalset`（已提交） | `zhuyin-native eval` |
| `%APPDATA%\PIME\zhuyin\adapter.json` | 引擎送出時寫入 | X2 |
| `%APPDATA%\PIME\zhuyin\usage.jsonl` | 使用紀錄開著時，每次送出寫一行 | `zhuyin-native usage` |

## 5. 系統占用

2026-10-27 用 `debug-pime.ts zhuyin` 打 1500 句實測（PIME 協定，不含 TSF 本身；L3 開、學習關）：

| 項目 | 數字 |
|---|---|
| 後端工作集 | 68MB（峰值 72MB） |
| 後端私有記憶體 | 14MB（模型是記憶體映射，算在工作集、不算私有） |
| 每鍵延遲 | p50 0.13ms、p95 1.81ms、p99 2.89ms、max 39ms |
| Enter 送出 | 0.31ms |
| CPU | 0.36ms／鍵 |

- 增量解碼（`decode.rs` `Lattice`）：位置 q 的狀態只看 q 之前的音節，打下一個音節只補到達新位置的邊；改中間音節（退格、L3 展開不同）從共同前綴截斷再補；選字、學習開關、新的組字整格重來。Enter 的解碼只剩句尾項。
- 改前（同一台、同一天，整句重解碼）：每鍵 p50 0.16、p95 11.91、p99 21.22、max 136ms，Enter 10.17ms，CPU 2.28ms／鍵。句準與錯句清單改前改後相同。
- 增量與全量逐位元相同：`ZHUYIN_INCR=1 zhuyin-native eval` 逐音節比對（含刪掉中間音節再補回、中途選字後接著打），不同就 panic。同一指令印每步延遲：全量 p95 11.59、p99 17.34ms，增量 p95 2.98、p99 6.00ms（無 L3）；L3＋雜訊 0.03,0.03 全量 p95 17.23、增量 4.78ms。
- 學習開著時，X2 的時間（recency）在一次組字裡固定在第一次解碼的時刻，增量才和全量相同；半衰期 14 天，差異可忽略。
- 閒置 300 秒（`idleSecs`）卸載引擎，下一個組字鍵重新載入。
- 記憶體的拆解、和微軟注音的比較、縮小方案見 [MEMORY.md](MEMORY.md)；後端的載入／卸載與 PIME 的比較見 [PIME-NOTES.md](PIME-NOTES.md)。

## 6. 評測

- 指標：句準（整句完全正確的比例）、字準、N-best oracle（正解在 N-best 內的比例）、解碼延遲 p50/p95。
- `zhuyin-native eval` 把評測集分成 dev（偶數句）與 test（奇數句）。一設定一行程，用環境變數換設定（見 CLAUDE.md）。
- 自己的打字紀錄：`zhuyin-native usage usage.jsonl my-eval.jsonl` 轉成評測集，再 `ZHUYIN_EVAL=my-eval.jsonl zhuyin-native eval`。音節是實際打的（含打錯），要看 L3 的效果就加 `ZHUYIN_L3=1`。

已記錄的結果（口語／書面句準）：

| 設定 | 口語 | 書面 |
|---|---|---|
| 舊 `lm.json` L5 | 59.0% | 70.2% |
| `lm.tsv` L5（計數模型） | 76.7% | 80.4% |
| `lm.bo.bin` L5（目前，2026-10-24 `eval`） | 78.7% | 82.0% |
| `lm.tsv` + Kev `runs/zy-choice16k` w=3（已封存） | 80.4% | 89.0% |

L3 只用合成錯誤評測過，錯誤分布跟 L3 共用同一張鄰鍵表與模糊音表，結果偏樂觀。

### X1 領域先驗（2026-10-27）

使用者是開發者，使用紀錄裡有 按鍵→案件、腳本→房角本 這類錯。LM 是 PTT＋維基訓練的，軟體用語機率偏低。

- 做法：`native/src/domain/tech.txt` 是本專案自編的約 280 個軟體／科技詞（不是萌典或 libchewing 的資料，沒有授權問題）。`Decoder::new` 讀進來：
  - 詞表裡的詞，詞級 log 機率一律加 `domain_bonus`（預設 2）。
  - 詞典沒有的詞（約 70 個，如 回傳、雜湊表、組字區）在詞表裡附讀音，走 `add_entry`，分數同執行中加的詞（`parts_log_prob`）再加 `domain_bonus`。
- 評測集 `eval/tech.jsonl`：`eval/tech.txt` 的 163 句手寫開發者聊天句（含中英夾雜），用 `build-mixed-eval.ts eval/tech.txt 1000 tech.jsonl` 給讀音。逐句查過 `corpus`／`corpus-en`，沒有出現在訓練語料（原本有一句重複，已改寫）。
- `ZHUYIN_DOMAIN=<δ>` 換加分（0＝只加詞、不加分）。δ 用 dev 選：

| δ | tech 句準（dev／test） | colloquial | written | mixed |
|---|---|---|---|---|
| 改前 | 84.05（90.2／77.8） | 78.70 | 82.00 | 81.40 |
| 0（只加詞） | 84.66（90.2／79.0） | 78.70 | 82.00 | 81.40 |
| **2（預設）** | **87.12（91.5／82.7）** | 78.70 | 82.00 | 81.50 |
| 4 | 87.12（91.5／82.7） | 78.70 | 81.80 | 81.50 |
| 6 | 88.34（91.5／85.2） | 78.70 | 81.80 | 81.60 |

- 注意：評測句與詞表是同一個人寫的，而且寫詞表前看過改前的錯句，tech 的數字偏樂觀；test 只有 82 句，一句 1.2 點。真實效果要用使用紀錄（`usage` 的 eval-out）量，還沒量。
- X2 能補多少（`zhuyin-native x2`：模擬使用者照正解選字送出，A＝偶數句、B＝奇數句）：

| | 沒學 | 第一輪（邊學邊打） | 第二輪（同樣的句子） | B 沒學 → 學過 A 後量 B |
|---|---|---|---|---|
| 不加分（δ=0） | 84.66 | 84.66 | 96.32 | 79.01 → 80.25 |
| δ=2 | 87.12 | 84.66 | 95.71 | 82.72 → 81.48 |

  同樣的句子打第二次，X2 幾乎補滿（oracle@4 是 94.5）；但沒看過的句子，X2 只補 1.2 點（82 句裡 1 句）。X1 在沒看過的 B 上加 3.7 點，所以 X1 和 X2 不重疊：X2 記住打過的，X1 管冷啟動。δ=2 時邊學邊打反而掉 2.5 點（全線、寫的、記錄 這類錯是學到前面句子的字之後才出現），是 X2 的問題，還沒查。
- 還剩的錯多半不是領域詞：在／再、讀／獨、選字→選自、代碼→代馬。
- 沒做：領域加權 LM、領域二元加分、不重訓大 LM。詞表要擴充就直接加行；要關掉得加設定（現在沒有）。

## 7. 根目錄的 `debug-*.ts`

調查與測試腳本。`.ts` 直接 import `packages/*/src`，用 `npx tsx debug-xxx.ts` 跑。其他的 `debug-*.ts`（`debug-prune`、`debug-latency`、`debug-native-parity` 等）已封存在 git tag `archive/ts-engine`。

| 腳本 | 用途 |
|---|---|
| `debug-pime.ts` | 驅動 PIME 後端：行為檢查＋打 1500 句量準確率、延遲、記憶體；也能驅動新酷音、小麥注音 |
| `debug-pime-fuzz.ts` | 隨機按鍵壓力測試 |
| `debug-pime-idle.ts` | 閒置卸載與重新載入 |
| `debug-learned-web.ts` | 學習資料頁的端對端檢查 |
| `debug-ms-keys.ts` | 產生微軟注音測試用的大千 VK 序列 |
| `debug-ms-bopomofo.ps1` | 用 SendInput 把 VK 序列打進自己的 WinForms 文字框，讀回微軟注音（或 PIME 輸入法）的結果。會佔用鍵盤與前景視窗 |
| `debug-ime-bench.ps1` | 包住 `debug-ms-bopomofo.ps1`，前後記錄輸入法引擎行程（`ctfmon` 或 PIME）的 CPU 與記憶體。`-Ime` 選 `ms`／`chewing`／`mcbopomofo` |
| `debug-bo-diff.ts` | 沿正解逐詞比 KN 與退回式機率 |

## 8. 測試

- `npm test` 跑 vitest：`core/test`（型別、詞典索引）、`lm/test`（模型、退回式模型）、`data-pipeline/test`（注音解析、萌典、詞庫、清洗、防洩漏）。
- 引擎單元測試：`cd native && cargo test`。各模組的 `#[cfg(test)] mod tests`（keymap、slots、l3、x2、usage、lexicon、decode、engine、pime），不需要 `data/`：`native/src/testutil.rs` 手造極小的 lexicon.bin 與平坦的 lm.bo.bin（每個詞都查不到、回 unseen，所以詞少的路徑贏）。CI 的 `native` job（windows-latest）跑 `cargo fmt --check`、`cargo build --release`、`cargo test`、`cargo clippy --all-targets -- -D warnings`。
- 引擎整合：`debug-pime.ts`（行為檢查）與 `debug-pime-fuzz.ts`，需要 `data/` 的大模型，CI 上不跑。

## 9. 授權限制

- 每筆詞庫條目都帶 `provenance`（`moedict` / `libchewing` / `user` / `mined`）。新增來源時要在 `Provenance` 型別登記。
- libchewing 資料是 LGPL-2.1：原樣散布並保留授權聲明，修改過要另外標記。
- 萌典要標註來源。
- GPL 授權的模型權重不能提交，由使用者用腳本自己下載。

## 10. 已知限制與未做的部分

- X1 領域先驗只有軟體／科技一份詞表、沒有開關（見下面「X1 領域先驗」）。
- 只有大千排列。
- 所有程式共用一份組字狀態與中英模式（`pime.rs` 的 `ponytail:` 註記）：換到別的程式打字，前一個程式沒送出的組字會丟掉。
- 組字中按 Tab（表格以外）、F1–F12、Insert 會被吃掉。
- L3 的評測只有合成錯誤；使用紀錄能收真實資料，但預設關閉，也看不到送出後才在應用程式裡改的錯字。
