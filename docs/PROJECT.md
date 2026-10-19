# 專案全貌：zhuyin-ime

本文件描述整個專案的目標、架構、各套件的實作細節、資料流程、評測方式與已知限制。
指令速查見 [CLAUDE.md](../CLAUDE.md)；授權與資料來源摘要見 [README.md](../README.md)。

> 文件內容以 2026-10 的程式碼為準。數字（預設值、實測準確率）都來自程式碼註解或 CLAUDE.md，
> 改參數時請同步更新本文件。

## 1. 目標

做一個平台無關的注音（大千排列）輸入法核心，用 TypeScript 寫。

現有注音輸入法（libchewing、McBopomofo）只有語言模型 `P(H)`，而且多半只到詞 unigram／bigram。
本專案以微軟拼音的功能清單為藍本，補兩塊：

- **通道模型 `P(K|S)`**：使用者按的鍵 K 跟想打的音節 S 不一致時（按到隔壁鍵、模糊音、記錯聲調），仍能解出正確句子。
- **現代語言模型 `P(H)`**：詞級＋字級三元 Kneser-Ney，加上可選的神經重排。

解碼目標：`argmax_H P(H) · P(K|S(H))`，實作上是 log 空間的加總。

## 2. 分層架構

| 層 | 名稱 | 實作位置 | 狀態 |
|---|---|---|---|
| L0 | 按鍵事件 | `core/src/index.ts` `KeyEvent` | 完成 |
| L1 | 鍵盤映射 | `core/src/keymap.ts` | 完成（只有大千） |
| L2 | 槽位組字 | `core/src/slots.ts` `CompositionBuffer` | 完成 |
| L3 | 假設展開（運動／認知通道） | `core/src/l3.ts` `Channel` | 完成，只用合成錯誤評測過 |
| L4 | 詞格 | `core/src/decode.ts` `spanCands` | 完成 |
| L5 | 解碼 | `core/src/decode.ts` `Decoder.decode` | 完成 |
| L6 | 神經重排 | `rerank/src/reranker.ts`、`kev.ts` | 已封存（tag `archive/l6-l7`） |
| L7 | 呈現遲滯（防閃動） | `cli/src/engine.ts` `stickBonus` | 已封存（tag `archive/l6-l7`） |
| X1 | 領域先驗 | — | **未實作** |
| X2 | 使用者適應 | `core/src/x2.ts` `UserAdapter` | 完成 |
| X3 | 遙測 | `cli/src/noise.ts` | 只有錯誤注入，沒有真實打字紀錄 |

一次按鍵的資料流：

```
KeyboardEvent.code
  → L1 mapKey：code → 注音符號或聲調
  → L2 CompositionBuffer：符號填入四槽，按聲調鍵完成一個音節
  → （音節序列有變才繼續）
  → L3 Channel.expand：每個觀察音節 → 可能的意圖音節＋代價
  → L4/L5 Decoder.decode：詞格 + list-Viterbi → N-best
  → 畫面立刻顯示 L5 首選
  → L6 在背景 worker 重排；完成且仍是同一序列 → 替換畫面（L7 加分避免來回跳）
  → commit：送出文字，X2 記錄選字、挖新詞
```

### 2.1 各層作法與實例

每層分三部分：作法、解決的問題、例子。實作細節見第 3 節。

- 標「實測」的例子：2026-10-15 對 `web` 測試台送按鍵得到的輸出，模型是 `lm.tsv`，L3、L6 都開著。
- 標「示意」的例子：依程式碼邏輯推導，沒有實際跑過。
- L3 的錯誤都是人工造的，不代表真實打字的效果。

**L0 按鍵事件**

- 作法：記錄實體鍵位 `KeyboardEvent.code` 和時間戳，不記錄字元。
- 解決：L3 要知道實際按了哪顆鍵，才算得出鄰鍵。
- 例子：按 R 鍵，記成 `{code: "KeyR", timestampMs: …}`，不是記「ㄐ」。

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
- 例子（實測，`Channel.expand`）：
  - `ㄐㄧㄥ` → ㄐㄧㄥ:0、ㄐㄧㄣ:7.5（模糊音）、ㄑㄧㄥ:9（鄰鍵）、ㄐㄧ:10.5（多按）……
  - `ㄗㄨˋ` → ㄓㄨˋ:7.5（平捲舌）、ㄗㄨˇ:7.5（相鄰聲調鍵）……

整句送進測試台的結果（實測）：

| 錯誤類型 | 打的音節 | 輸出 |
|---|---|---|
| 模糊音 ㄣ→ㄥ | **ㄐㄧㄥ** ㄊㄧㄢ ㄊㄧㄢ ㄑㄧˋ ㄏㄣˇ ㄏㄠˇ | 今天天氣很好 |
| 鄰鍵（P 按成 O） | ㄊㄧㄢ ㄑㄧˋ **ㄏㄟˇ** ㄏㄠˇ | 天氣很好 |
| 漏按（漏 ㄧ） | ㄐㄧㄣ **ㄊㄢ** ㄊㄧㄢ ㄑㄧˋ | 今天天氣 |
| 聲調錯（ˊ 打成 ˋ） | ㄨㄛˇ ㄒㄧㄤˇ ㄑㄩˋ **ㄊㄨˋ** ㄕㄨ ㄍㄨㄢˇ | 我想去圖書館 |
| 不合法音節 | ㄨㄛˇ **ㄅㄩˋ** ㄓ ㄉㄠˋ | 我不知道 |

L3 的更正要靠上下文才會發生。以鄰鍵那一句為例，逐音節畫面是 `天 → 天氣 → 天氣黑 → 天氣很好`。「黑」本身是合法的字，所以先顯示「黑」。打到「好」之後，「天氣很好」這條路徑扣掉更正代價 9 以後，分數仍然高於「天氣黑好」，所以改成「很」。

**L4 詞格**

- 作法：對每個（起點, 長度）從讀音索引查出所有候選詞，組成一張圖。
- 解決：同一串音節有很多種斷詞和同音詞組合，要先全部列出，L5 才能挑。
- 例子（示意）：`ㄆㄧㄥˊ ㄊㄧㄠˊ ㄇㄚˇ` 的詞格同時包含 [憑][條碼]、[平調][碼]、[瓶][條][馬]……

**L5 解碼**

- 作法：用 list-Viterbi 在詞格上找出分數最高的幾條路徑。分數 = 詞三元 × a + 字三元 × γ − L3 代價 + X2/L7 加分。
- 解決：從所有組合中挑出最像自然句子的一句。後文會改寫前面的選字。
- 例子（實測，逐音節畫面）：
  - `我想去突 → 我想去圖書 → 我想去圖書館`
  - `顆 → 可以 → 可以憑 → … → 可以憑條碼領取`

**L6 神經重排**

- 作法：L5 的前幾名候選交給 BERT，只遮候選之間不同的字來比通順度，在背景執行緒跑。
- 解決：n-gram 只看前兩個詞，抓不到較長距離的語意。
- 例子（實測）：「他在研究生命起源」打第一個音節時，L5 顯示「她」，67ms 後 L6 推送改成「他」。

**L7 呈現遲滯**

- 作法：L6 改過的詞，在同一次組字接下來的 L5 解碼中加 +4。送回 L6 前把加分扣掉。
- 解決：避免 L5 跟 L6 輪流把同一個詞改來改去。
- 例子（示意）：L6 把位置 0 的「她」改成「他」，接著使用者打下一個音節，L5 重新解碼。
  - 沒有 L7：L5 可能又選回「她」，畫面跳回去。
  - 有 L7：「他」多了 +4，畫面保持「他」。
  - 後文若明確指向「她」（例如「她媽媽」），L5 仍可推翻這個加分。

**X2 使用者適應**

- 作法：記錄每次送出時「哪個讀音選了哪個詞」，換成有上限、會隨時間衰減的分數加成。連續的單字會被挖成新詞。
- 解決：學會使用者的用字習慣，但不像 McBopomofo 那樣硬插詞條、把正確候選擠掉。
- 例子（示意）：
  - 在 ㄐㄧㄤˋ ㄒㄧ 一直選「降息」 → 「降息」的加成最多到 +2.2。
  - 送出的路徑裡有連續單字「降」「息」，而且詞庫沒有「降息」 → 挖成新詞「降息」加入詞格。

## 3. 套件

npm workspaces monorepo。套件之間透過各自的 `dist/` 互相引用，所以改了一個套件要先 `npm run build`。

| 套件 | 依賴 | 職責 |
|---|---|---|
| `@zhuyin/core` | 無 | 純函式管線，零 IO |
| `@zhuyin/lm` | 無 | n-gram 訓練與 runtime 查詢 |
| `@zhuyin/data-pipeline` | core、`opencc-js` | 下載、清洗、建詞庫／語料／評測集 |
| `@zhuyin/rerank` | core、`@huggingface/transformers` | L6 重排 |
| `@zhuyin/cli` | 以上全部 | 組裝 runtime、互動測試台、評測 |

### 3.1 `@zhuyin/core`

**核心型別**（`index.ts`）

- `KeyEvent`：`code`（實體鍵位）、`timestampMs`、選填 `key`（英文模式用）。L0 保留實體鍵位，因為 L3 要算鄰鍵距離。
- `Syllable`：四槽 `initial` / `medial` / `final` / `tone`。
- 音節正規形：`聲母介音韻母` + 聲調符號，例如 `ㄐㄧㄣ`、`ㄊㄧㄢˊ`。一聲不加符號，輕聲是 `˙` 後綴。
- `LexiconEntry`：`word`、`readings`（多組讀音）、`freq`、`provenance`。

**L1 鍵盤映射**（`keymap.ts`）

- 只有大千排列 `DACHEN`。聲調鍵固定：Space=一聲、6=ˊ、3=ˇ、4=ˋ、7=˙。
- `mapKey` 回傳陣列，預留給一鍵多符號的排列（倚天 26 鍵等）。
- `syllableToKeyCodes`：音節 → 鍵碼序列。評測用它把音節合成鍵流，再走一次 L2 驗證往返一致。

**L2 槽位組字**（`slots.ts`）

- 每個符號依類別填自己的槽，與按鍵順序無關。所以音節內順序顛倒（例如先按韻母再按聲母）不需要 L3 處理。
- 同一槽再按一次 → 覆蓋（與微軟注音一致）。
- 按聲調鍵 → 完成音節，回報是否在合法音節表內。
- Backspace 先退未完成的槽，再退已完成的音節。

**L3 通道模型**（`l3.ts`）

`Channel.expand(observed)` 回傳意圖音節清單。第一個永遠是觀察音節本身（代價 0），其餘依代價遞增。

| 錯誤類型 | 選項 | 預設代價（log 單位） |
|---|---|---|
| 按到實體相鄰鍵 | `sub` | 18 |
| 多按一鍵 | `extra` | 21 |
| 漏按一鍵 | `miss` | 24 |
| 按到相鄰聲調鍵（3↔4、6↔7） | `toneAdj` | 15 |
| 記錯聲調 | `tone` | 21 |
| 模糊音 | `fuzzy` | 15 |
| 前後鼻音 ㄣ/ㄥ | `nasal` | 3.5 |

- 模糊音對：ㄣ/ㄥ、ㄓ/ㄗ、ㄔ/ㄘ、ㄕ/ㄙ、ㄈ/ㄏ、ㄌ/ㄋ、ㄌ/ㄖ。
- 鄰鍵用標準 ANSI 交錯鍵盤的幾何距離算（鍵中心距離 ≤ 1.3）。
- 每個音節只展開一處錯誤，最多保留 24 個替代（`maxAlts`）。
- 預設代價是初始值 ×3（2026-10-20 從 ×1.5 調高）。原則：寧可不修，也不要把照打的字改錯。
- ×1.5 會把照打、詞典沒有的「文檔」（ㄨㄣˊ ㄉㄤˇ）改成「存檔」（當成漏按 ㄘ）。×2 起就不會。探針：`debug-l3-probe.ts`。
- 合成錯誤（每鍵 3%、每音節 3% 認知錯誤）的 dev/test 句準（`debug-l3.ts`）：

  | 設定 | 乾淨口語 | 乾淨書面 | 有錯口語 | 有錯書面 |
  |---|---|---|---|---|
  | L3 關 | 76.8/76.2 | 76.4/81.6 | 23.2/22.2 | 22.0/28.8 |
  | ×1.5（舊預設） | 76.2/75.0 | 75.6/80.8 | 52.0/46.0 | 52.8/57.2 |
  | ×3（預設） | 76.4/75.8 | 75.6/81.2 | 41.6/38.8 | 43.6/50.4 |

- 乾淨輸入剩下的損失主要來自 `nasal`：設 5 時乾淨書面回到 76.4/81.6，但 ㄧㄣ ㄍㄞ 就不會改成「應該」。

**L4/L5 解碼**（`decode.ts`）

分數是 log-linear：

```
Score = Σ_詞 [ a·logP_word(w | 前兩詞)
             + γ·logP_char(w 的每個字 | 前兩字)
             + U(w)          ← X2 使用者加成、L7 防閃動加分
             − cost(w) ]     ← L3 更正代價
      + a·logP_word(EOS | 末兩詞) + γ·logP_char(EOS | 末兩字)
```

- 詞級與字級是兩個獨立專家，**相加，不做線性內插**。
- 預設 `a=0.8`、`γ=0.5`；CLI 的 `eval` 用 `a=1`。
- 詞格：每個 (起點, 長度) 從讀音索引取候選詞，最長 10 音節，每格最多 48 個（依詞頻）。
- L3 更正：每個詞最多更正一個音節，每個更正讀音最多取 8 個詞（`altEntryCap`）。
- 單音節更正只在觀察音節查無任何詞時才做（`altSingleOnlyIfEmpty`）。全開可在有錯輸入上多救約 7 點，但解碼慢 5–8 倍。
- 查無詞的音節用未知詞 `□` 補上，罰分 `log(1e-7)`，確保詞格連通。
- 破音單字（有多個讀音的單字）額外扣 `polyPenalty=2.5`，因為破音字很少單獨成詞。
- N-best 用 **list-Viterbi**：狀態是「前兩詞」，每個狀態保留 K 條部分路徑（預設 4，引擎給 L6 用時是 28），全域 beam 上限 200。
- 每條路徑附 `breakdown`：逐詞的 `wordTerm`、`charTerm`、`uTerm`、`chTerm`、`spanLen`、`reading`。各項加總等於總分。
- 解碼器只透過 `Scorer` 介面（`wordLogProb`、`charSequenceLogProb`）用到 LM，所以基線可以換掉 Scorer 來比較。
- `addEntry` 可在執行中加詞（X2 造詞、挖詞），不重建索引。

**X2 使用者適應**（`x2.ts`）

- 原則：**修改分數，不硬插詞條**。McBopomofo 把使用者詞以最高分硬插，會擠掉正確候選。
- `recordSelection(seq, word)`：每次送出記錄（讀音, 詞）的次數與時間，另記全域次數。
- `modifierFor(seq, word)` 回傳加成：
  - 同讀音紀錄：`min(2.2, 0.55·ln(1+次數))`
  - 全域紀錄：上限 1.1，再乘 0.35
  - 兩者都乘時間衰減，半衰期 14 天
  - 手動造詞：固定 +8
- `mineWord`：送出時，連續 ≥2 個單字詞且組合不在詞庫 → 合併成新詞加入詞格。
- 有總開關 `setEnabled(false)`，關閉時解碼結果與沒有 X2 完全相同。
- 狀態存在 `data/user/adapter.json`。

### 3.2 `@zhuyin/lm`

**訓練**（`train.ts`）

1. 讀 `lexicon.jsonl` 的詞與詞頻。
2. 每句用 unigram-DP 斷詞（全域最佳，不是貪婪最長匹配）。詞的代價 = `LM_TOKEN_PENALTY − log(freq+1)`。未登錄單字另加 `log(20)`。
3. 統計詞級與字級的 1/2/3-gram。二元全保留，三元只留次數 ≥ 2（`LM_MIN_TRI`）。
4. 輸出逐行 `.tsv`：`section\tcount\tkey`。section 是 `wu/wb/wt/cu/cb/ct`（word/char × uni/bi/tri），第一行是 `#meta`。

`LM_TOKEN_PENALTY` 預設 14。這個值必須大於高頻單字的 `log(freq)`（約 11–13.5），否則單字代價變負，DP 會把詞切碎。

訓練時用 JS `Map`，大語料需要 `--max-old-space-size=34000`。

**Runtime**（`model.ts`、`hashtable.ts`）

- `LanguageModel.load` 讀 `.tsv` 或舊的 `.json`。
- 平滑法預設 interpolated Kneser-Ney（折扣 0.75）。stupid backoff（`smoothing='sb'`）保留作對照；KN 比它高約 12 點句準。
- 一元層是 0.9 × 接續機率 + 0.1 × 真 unigram，避免沒見過的詞機率為 0。
- 二元、三元表存在 `HashTable`：開放定址，key 只存兩組 32-bit 雜湊，值存 `Uint32Array`。
  - 原因：數千萬筆 n-gram 放在 JS `Map`，每次 major GC 都要掃全部物件，實測每句多 700ms。typed array 的內容 GC 不掃。
  - 載入後約 2GB RSS，JS heap < 0.1GB。
  - 64-bit 指紋在 5000 萬筆內的碰撞機率約 1e-4，對機率估計沒有實質影響。

### 3.3 `@zhuyin/data-pipeline`

來源的網址、授權、版本集中在 `src/config.ts`。

| 指令 | 輸出 | 內容 |
|---|---|---|
| `cli.ts download` + `lexicon` | `data/processed/lexicon.jsonl` | 萌典 + libchewing 合併，逐筆帶 `provenance` |
| `cli.ts syllables` | `data/processed/syllables.json` | 詞庫出現過的全部音節（L2 合法性檢查、L3 候選過濾） |
| `cli.ts corpus` | `data/processed/corpus/` | PTT 口語 + 書面語抽樣（小語料） |
| `cli.ts evalset` | `eval/colloquial.jsonl`、`eval/written.jsonl` | 固定種子抽樣的評測句 |
| `scripts/extract-wiki.py` | `data/raw/wiki/*.jsonl` | 維基百科抽文字 |
| `scripts/build-big-corpus.ts` | `data/processed/corpus-big*/` | 大語料：PTT 全量 + 維基 |

大語料的處理方式：

- 取「連續中文字片段」（≥4 字），不做整句清洗。PTT 用空白、半形標點斷句又夾英數，整句規則會丟掉九成。
- 簡體轉繁體用 OpenCC `cn → twp`。
- **防洩漏**：任何片段只要包含評測句就丟掉。以評測句前 6 字建索引比對。

評測集格式：第一行是 meta（種子、句數），之後每行 `{text, tokens, syllables}`。口語 1000 句、書面 500 句。

### 3.4 `@zhuyin/rerank`

**BERT PLL 重排**（`reranker.ts` `PllReranker`）

PLL（pseudo-log-likelihood：把句中一個字遮住，讓 BERT 猜回原字的 log 機率，逐字加總）用來判斷哪個候選句比較通順。

- 模型：`Xenova/bert-base-chinese`，fp32 ONNX，快取在 `data/models/hf/`。**不要用 int8**：句準從 70% 掉到 55%。
- 省算：只遮「候選之間不一樣的字位」（`divergence.ts`）。所有（字位, 候選）組合塞成一批，一次前向算完。
- 候選選擇：先依斷詞邊界分家族，再跨家族輪流取（`diverseSelection`），避免 top-K 被同一種斷詞的同音變體塞滿。
- 最終分數 = L5 分數 + `weight × PLL`。
- `gapThreshold`：L5 第 1、2 名分差大於此值就不跑 BERT。CLI 預設 6，dev 無損，約少 40% 的 BERT 呼叫。
- `flipMargin`：原首選含稀有字（可能是專有名詞）時，PLL 贏家要領先這麼多才准翻轉。

**Worker**（`worker.ts` `RerankWorker`）

- BERT 推論會佔住執行緒 110–640ms。放在主執行緒，重排期間的按鍵會排隊，所以包進 `worker_threads`。
- ONNX Runtime 執行緒數預設 `邏輯核數/2 − 2`。只在 16 核機器量過；其他機器用 `numThreads` 覆寫。

**Kev / Jev 決策模型重排**（`kev.ts` `KevReranker`）

- 呼叫 System One API 伺服器。Kev 是 Jev 的開源復刻（Apache-2.0），在本機 GPU 上跑微調過的 Qwen 模型。
- `choice` 模式（預設）：top-16 個不同字串當選項，一次請求拿到機率分布。
- `noul` 模式：每句問一次「是否通順」，取 P(yes)。
- 分數 = L5 分數 + `weight × log P`，預設 weight=3。
- 題目文字必須跟微調資料（`debug-kev-train.ts`）一致。
- 伺服器啟動方式見 CLAUDE.md。

### 3.5 `@zhuyin/cli`

**`runtime.ts` `loadRuntime`**：唯一載入 LM、詞庫、音節表、X2 狀態並組出 `Decoder` 的地方。

- LM 檔案：`ZHUYIN_LM` 環境變數 > `data/models/lm.tsv` > `data/models/lm.json`。
- 基線模式：`classic` 模仿 libchewing（只有詞 unigram）；`bigram` 模仿 McBopomofo（unigram + bigram，沒有字級）。
- 載入時把 X2 已有的使用者詞注入詞格。

**`engine.ts` `ImeEngine`**：把各層串起來的狀態機。

- `onKey`：英文模式直接回傳字元；注音模式送進 L2，已完成音節序列有變才重新解碼。
- 每次解碼都是整句重解（不是增量）。
- L6 非同步規則：
  - `onKey` 同步回傳 L5 結果，重排在背景跑。
  - 每次序列改變，世代號 `gen` 加一。重排回來時世代不符就丟掉。
  - 同時最多一個重排在跑；跑完若序列又變，補跑最新的。
  - `commit` 不等 BERT：有目前序列的重排結果就用，沒有就用 L5。
- L7 防閃動：
  - L6 改過的詞記為 `起點:長度:詞`，之後同一次組字的 L5 解碼給它 `stickBonus`（預設 4）加分。
  - 送去 L6 之前把加分扣回，讓 L6 用原始分數判斷。
  - 全評測集上 L6→L5 回滾次數減少約 40%（口語 0.82→0.50、書面 1.11→0.70），口語句準不變，書面 dev −0.8。
  - 曾試過硬鎖前綴，句準掉 5–6 點，所以改成軟性加分。
- `commit(k)`：送出第 k 個候選，觸發 X2 學習。X2 學的是 `breakdown.reading`（L3 更正後的讀音），不是打錯的觀察讀音。
- `toggleMode`：切換注音／英文，切換前先送出組字區內容。
- `setRerankHooks(h)`：執行中換掉 L6，`undefined` 代表關閉。進行中的重排結果作廢，防閃動記錄清空。網頁測試台的 L6 切換就是呼叫它。
  - BERT worker 和 Kev 連線在第一次選到時才建立，之後保留，來回切換不重新載入。
  - 切到 Kev 時先送一個測試請求。伺服器沒開的話切換失敗，選單退回原選項。
  - 已載入過的 Kev 如果之後伺服器關掉，切換不會失敗。每次重排都會報錯（伺服器終端看得到），畫面維持 L5 結果。

**子指令**（`index.ts`）

| 指令 | 用途 |
|---|---|
| `type [--rerank] [--no-l3]` | 行模式互動：每行輸入空白分隔的鍵碼。支援 `#n` 選候選、`:phrase` 造詞、`:adapt on/off` |
| `web [--port N] [--l6 off\|bert\|kev] [--no-l3]` | 網頁測試台：用真鍵盤打字，L6 結果用 SSE 推送。只聽 127.0.0.1。L6 預設 `bert`（`--no-rerank` 等於 `off`），網頁右上角可隨時切換關閉／BERT／Qwen3.5（Kev） |
| `replay <keys.jsonl>` | 重播鍵流 |
| `eval [...]` | 在兩個評測集上算句準、字準、延遲 |
| `sweep` | 在口語集上掃 `a × γ` 網格 |

**`noise.ts`**：在按鍵層級注入錯誤（鄰鍵 60%、漏按 20%、多按 20%；認知錯誤中模糊音 70%、聲調 30%），再走真正的 L2，得到「打錯後的音節序列」。用固定種子的 mulberry32 亂數，可重現。

## 4. 資料與模型檔案

`data/raw`、`data/models`、`data/user` 都在 `.gitignore` 內，需要自己產生。

| 檔案 | 產生方式 | 誰用 |
|---|---|---|
| `data/processed/lexicon.jsonl` | `npm run data:lexicon` | Decoder、LM 訓練、評測集 |
| `data/processed/syllables.json` | `cli.ts syllables` | L2、L3 |
| `data/processed/corpus-big2/` | `build-big-corpus.ts` | LM 訓練 |
| `data/models/lm.tsv` | `lm/src/train.ts`（約 1GB，約 17 分鐘） | runtime |
| `data/models/hf/` | 第一次跑 rerank 時下載 | L6 BERT |
| `data/user/adapter.json` | 引擎送出時寫入 | X2 |
| `eval/*.jsonl` | `cli.ts evalset`（已提交） | 評測 |

## 5. 各層系統占用

2026-10-15 實測。機器：16 邏輯核 CPU、RTX 5080 16GB、Windows 11、Node 22。

- 延遲用口語評測集的前 100–200 句量，平均 11.6 個音節。
- 記憶體是 Node 的 RSS（實際佔用的實體記憶體）。
- 換機器、換模型或改參數後數字會變，請重量。

### 5.1 逐層

| 層 | 記憶體 | 載入時間 | 每次執行 | 跑在哪裡 |
|---|---|---|---|---|
| L0–L2 按鍵／映射／組字 | 可忽略 | — | 0.9µs／鍵 | 主執行緒 |
| 合法音節表（L2、L3 共用） | 可忽略（1,613 個音節） | — | — | 主執行緒 |
| L3 通道模型 | 可忽略（結果有快取） | — | 約 2µs／音節 | 主執行緒 |
| LM（L5 用） | 載入後 RSS 1.95GB，解碼一段時間後 2.1–2.5GB；JS heap 只有 37MB | 39 秒 | 見 L5 | 主執行緒 |
| 詞庫索引（L4） | JS heap +150MB（235,183 個詞條） | 0.5 秒 | 見 L5 | 主執行緒 |
| L4+L5 整句解碼 | 每次解碼的暫存很小 | — | 見下表 | 主執行緒，單核 |
| L6 BERT PLL | RSS +1.0GB，重排後再 +0.2GB | 0.7 秒（模型已在硬碟） | p50 246ms、p95 532ms；27% 的句子因分差 > 6 跳過 | worker 執行緒，6 條 ONNX Runtime 執行緒 |
| L6 Kev（Qwen3.5-4B） | 另一個 Python 程序：VRAM 約 13.4GB、RAM 2.4GB | 沒有量 | p50 34ms、p95 122ms | GPU |
| L7 防閃動 | 可忽略（一個字串 Set） | — | 可忽略 | 主執行緒 |
| X2 使用者適應 | 可忽略（`adapter.json` 目前 8KB） | — | 每個候選詞查一次 Map | 主執行緒 |

LM 表的大小：詞二元 1,819 萬筆、詞三元 1,883 萬筆、字二元 393 萬筆、字三元 1,661 萬筆。

LM 剛載入時，RSS 比 typed array 的配置總量（約 3.1GB）小。原因是雜湊表配置後，沒碰過的分頁不會實際佔用記憶體，解碼時用到才佔，所以 RSS 會慢慢上升。

### 5.2 L5 解碼延遲

| 設定 | p50 | p95 |
|---|---|---|
| nBest 4（沒開 L6 時的引擎設定） | 24ms | 59ms |
| nBest 28（開 L6 時的引擎設定） | 27ms | 66ms |
| nBest 4 + L3 | 32ms | 75ms |
| nBest 28 + L3 | 32ms | 80ms |

上表是整句解碼一次的時間。引擎每完成一個音節就重解整句，所以打字時每個音節的延遲，大約等於「目前已打的長度」對應的值。句子越長越慢。

### 5.3 整套組合

| 組合 | RAM | VRAM | 啟動時間 |
|---|---|---|---|
| L6 關閉 | 約 2.1–2.5GB | 0 | 約 40 秒 |
| L6 BERT | 約 3.3GB | 0 | 約 40 秒 |
| L6 Kev | Node 約 2.5GB + Python 約 2.4GB | 約 13.4GB | Node 約 40 秒，Kev 伺服器另外啟動 |

Kev 的 VRAM 數字是伺服器啟動前後整張顯卡用量的差（2.1GB → 15.6GB），包含 PyTorch 預先保留的快取，不全是權重。只用 Kev 的話，16GB 顯卡剩不到 1GB 給其他程式。

### 5.4 硬碟

| 檔案 | 大小 |
|---|---|
| `data/models/lm.tsv` | 1.0GB |
| `data/processed/lexicon.jsonl` | 24MB |
| `data/models/hf/`（BERT ONNX） | 391MB |
| Qwen3.5-4B-Base 基底模型（HF 快取，`~/.cache/huggingface`） | 8.8GB |
| `runs/zy-choice16k`（LoRA adapter 與分類頭） | 149MB |

## 6. 評測

- 指標：句準（整句完全正確的比例）、字準、解碼延遲 p50/p95。
- `eval` 先把音節序列合成鍵流，經 L1/L2 重組，驗證跟原序列一致，再解碼。
- 實驗台 `debug-acc.ts` 把評測集分成 dev（偶數句）與 test（奇數句），另外列出 N-best oracle（正解在 N-best 內的比例）。

已記錄的結果（口語／書面句準，出自 `rerank/src/kev.ts` 註解）：

| 設定 | 口語 | 書面 |
|---|---|---|
| 舊 `lm.json` L5 | 59.0% | 70.2% |
| 舊 `lm.json` + Kev choice 微調 w=2 | 71.9% | 85.0% |
| `lm.tsv` L5 | 76.7% | 80.4% |
| `lm.tsv` + Kev `runs/zy-choice16k` w=3 | 80.4% | 89.0% |

L3 只用合成錯誤評測過，錯誤分布跟 L3 共用同一張鄰鍵表與模糊音表，結果偏樂觀。

## 7. 根目錄的 `debug-*.ts`

一次性的調查腳本，直接 import `packages/*/src`，用 `npx tsx debug-xxx.ts` 跑。不是正式程式碼，可能過時。常用的：

| 腳本 | 用途 |
|---|---|
| `debug-acc.ts` | 一次載入、多組設定比較準確率 |
| `debug-l3.ts` | L3 在乾淨與加噪輸入上的效果 |
| `debug-lock.ts` | L7 防閃動的回滾次數與準確率 |
| `debug-threads.ts` | BERT worker 執行緒數對 L5 延遲的影響 |
| `debug-kev-train.ts` / `debug-kev-dump.ts` | 產生 Kev 微調資料、匯出 N-best 供離線評分 |

## 8. 測試

`npm test` 跑 vitest。測試檔：

- `core/test`：`index`、`pipeline`（L0–L5 串接）、`l3`、`x2`
- `lm/test/model.test.ts`
- `rerank/test/divergence.test.ts`（純函式，不需要模型）
- `data-pipeline/test`：注音解析、萌典、詞庫、清洗
- `cli/test`：引擎與 L3、引擎與非同步重排、引擎與 X2

## 9. 授權限制

- 每筆詞庫條目都帶 `provenance`（`moedict` / `libchewing` / `user` / `mined`）。新增來源時要在 `Provenance` 型別登記。
- libchewing 資料是 LGPL-2.1：原樣散布並保留授權聲明，修改過要另外標記。
- 萌典要標註來源。
- GPL 授權的模型權重不能提交，由使用者用腳本自己下載。

## 10. 已知限制與未做的部分

- X1 領域先驗沒有實作。
- 只有大千排列；`LAYOUTS` 預留了其他排列的位置。
- L3 沒有真實打字紀錄可評測；`KeyEvent.timestampMs` 已保留，但 L3 還沒用按鍵間隔。
- 每個音節完成就整句重解碼，長句的延遲會隨長度增加。
- 網頁測試台是單一引擎實例，只供本機開發。
