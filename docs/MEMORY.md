# 記憶體與輸入法宿主：微軟注音、PIME 與本專案

本文件記錄 2026-10-15～16 的量測與改動：

- 微軟注音怎麼載入、佔多少記憶體
- 本專案 LM 用雜湊表的理由與代價
- 已經做的縮小改動，以及還能怎麼縮
- PIME 的架構，以及 PIME 內建模型和本專案的比較

量測腳本都在 repo 根目錄（`debug-*.ts`、`debug-*.ps1`），指令見 [CLAUDE.md](../CLAUDE.md)。標「估計」的數字沒有實測。

## 1. 結論

- 微軟注音的引擎和字典常駐在系統行程 `ctfmon.exe`。字典是檔案映射的共享頁，私有記憶體只有約 10MB。打字的程式只載入一層薄通訊元件。
- 本專案的 RSS 從 690MB 降到 **250MB**（載入後），準確率不變（句 76.4／79.8，原本 76.5／79.8），解碼還變快：
  1. 剪枝 `tri>=4`
  2. 最小完美雜湊：大表 308 → 109MB
  3. 詞典索引只存詞字串
  4. 載入後做壓縮式 GC
- 打字中的 RSS 原本會被解碼垃圾撐到約 740MB（存活只有約 80MB）。解碼減垃圾後降到 430MB（L3 開 500MB），每鍵配置 9.5 → 3.7MB，延遲和 CPU 也砍半，結果逐位元不變。閒置時做一次壓縮式 GC（約 50ms）就回到約 250MB；網頁測試台在停打 3 秒後自動做。
- 和 PIME 內建的兩個注音引擎比（同一批 1500 句、只到 L5）：
  - 句準確率：本專案 76.4／79.8，新酷音 34.8／45.0，小麥注音 44.4／48.4。
  - 記憶體（私有）：本專案載入後約 250MB、打字中約 430MB，新酷音 7MB，小麥注音 119MB。
  - 延遲：本專案每鍵 p95／p99 為 14／23ms，新酷音 35／54ms，小麥注音不到 1ms。
- PIME 的行程模型和本專案規劃的「一個常駐引擎服務所有程式」一致。它的 Node 後端是 v22.14.0，但是 **32 位元**。
- 2026-10-17：Rust 引擎直接當 PIME 後端（`zhuyin-native pime`）。透過協定打 1500 句，句準確率 76.1／79.4（與引擎本身相同），每鍵 p95 11ms。模型改成記憶體映射、用到才載入、閒置就卸載：打字中私有 13MB（工作集 65MB），沒在用時私有 2MB（工作集 0.3MB），重新載入約 15ms。安裝檔已備好、尚未安裝（§6）。

## 2. 微軟注音怎麼載入（實測）

| 項目 | 結果 | 怎麼量的 |
|---|---|---|
| 引擎與字典在哪個行程 | `ctfmon.exe` 開著 `IMTCCORE.DLL` 和 `IMTCT.IMD` | Restart Manager `RmGetList` 查檔案使用者 |
| 什麼時候載入 | 登入時；`ctfmon.exe` 從開機登入就一直在 | 行程啟動時間 |
| `ctfmon.exe` 記憶體 | 工作集 78MB，私有 10MB | `Get-Process` |
| 磁碟上的字典＋DLL | 80.4MB（`IMTCT.IMD` 49.8MB） | 檔案大小 |
| 打字程式多載入什麼 | `textinputframework.dll`、`CoreMessaging.dll` 等通訊元件；沒有注音引擎 | 探測程式比對前後模組 |
| 程式內啟用耗時 | 3–5ms（`ActivateProfile`） | 探測程式計時 |
| 何時真正連上引擎 | 視窗有焦點、按下第一個鍵之後 | 沒焦點時只載入 `msctf.dll` |

登錄檔裡，微軟注音的 CLSID `{B115690A-…}` 同時登記了舊的 `IMTCTIP.DLL`（InProcServer32）和 `ChtIME.exe`（LocalServer32），並屬於 `GipFactory` 類別。實測時兩者都沒有被載入或啟動。

推論（沒有驗證）：

- 工作集與私有記憶體差了約 68MB。這部分應該是字典和 DLL 的檔案映射共享頁。`ctfmon.exe` 以高權限執行，一般權限打不開，量不到各檔案的常駐量。要驗證，用系統管理員身分跑 Sysinternals VMMap，看 `ctfmon.exe` 的 `.IMD` 映射。
- 78MB 不全是注音的。`ctfmon.exe` 也是整個 TSF 的管理行程。

快的原因：整台電腦只有一份引擎，登入時就載入了。字典直接映射，不用解析。每個程式只付通訊層的成本。

## 3. 本專案的記憶體

### 改動前後（實測，`debug-prune.ts`、`debug-mem.ts`、`debug-lexmem.ts`）

| 階段 | RSS | 大表 | 句準確率 | 每句 ms |
|---|---|---|---|---|
| 改動前（`tri>=3`、48 bit 指紋、開放定址） | 686MB | 308MB | 76.5／79.8 | 44／64 |
| ＋`tri>=4`、40 bit 指紋 | 611MB | 223MB | 76.4／79.8 | 38／56 |
| ＋詞典索引只存詞、載入後壓縮 GC | 379MB | 223MB | 76.4／79.8 | 40／53 |
| ＋最小完美雜湊（**目前預設**） | **250MB** | **109MB** | **76.4／79.8** | **35／50** |

`lm.bin` 從 334MB 降到 125MB。

### 目前的組成（估算）

| 部分 | 大小 |
|---|---|
| Node 本身 | 約 70MB |
| LM 大表（完美雜湊） | 109MB |
| LM 小 Map（詞彙、接續計數等，62 萬筆） | 約 36MB |
| 詞典索引 | 約 45MB（heap） |

### 詞典那 270MB 是什麼（`debug-lexmem.ts`）

- 真正存活的只有 110MB。其餘約 170MB 是解析 24MB 的 `lexicon.jsonl` 時產生的暫時物件：已經回收，但 V8 沒把空頁還給系統。
- 存活的 110MB 裡，51MB 是 `push` 長大的陣列預留的空位，29MB 是字串，22MB 是 `{word, reading}` 物件和讀音陣列。`reading` 從來沒被讀過，因為查詢時讀音就是鍵本身。
- 改成清單只存詞字串、建完後縮成剛好大小：存活 heap 110 → 45MB。
- 載入後在 `loadRuntime` 外層做一次 `last-resort` GC。必須在外層做，因為內層函式結束前，`lexRaw`、`entries` 還活著，回收不到。

### 打字中的 heap（`debug-latency.ts`、`debug-alloc.ts`）

解碼每次都產生大量短命物件，V8 會把 heap 撐大來減少 GC 次數。`runtime.ts` 匯出 `releaseHeap()`，常駐的引擎宿主應在閒置時呼叫；`web.ts` 在停打 3 秒後呼叫。

`debug-alloc.ts` 用 V8 取樣配置分析器（含已回收的物件）找垃圾來源。解碼器的改動與每鍵配置量（100 句、3655 鍵）：

| 改動 | 每鍵配置 |
|---|---|
| 改動前 | 9.5MB |
| LM 查詢分段雜湊（`get2`／`get3`，不組 `"c1 c2"` 等字串）、分數放重用的 `Float64Array` | 9.4MB |
| 先算分數再建路徑物件；每狀態的前 nBest 在插入時維持（`insert`），同組同詞只算一次鍵和尾字 | 6.7MB |
| 全域 beam 改用分數門檻（`Float64Array` 排序，不用比較函式），沒超過 beam 就不做 | 6.0MB |
| 位置上的路徑超過 2×beam 就先剪一次，之後低於門檻的路徑直接不建（`floors`） | **3.7MB** |

對照實驗：LM 換成回傳常數時，解碼器自己每鍵仍配置 3.5MB。原因是每個（狀態組 × 候選詞）幾乎都是新狀態，每鍵約 4300 條路徑、5300 個鍵字串，每次解碼約 84% 的路徑最後會被 beam 剪掉。上表最後一列就是在處理這件事。

每個改動都用 `debug-decode-dump.ts` 比對 1500 句的前 4 名結果和分數（6000 行），改動前後逐位元相同。

| | 改動前 | 改動後 |
|---|---|---|
| 每句解碼 | 32／45ms | 22／31ms |
| 每鍵 p95／p99／最大（L3 關） | 28／52／97ms | 14／23／41ms |
| 每鍵 p95／p99（L3 開） | 41／75ms | 22／38ms |
| 每鍵 CPU | 6.4ms | 2.8ms |
| 打 300 句後 RSS（L3 關／開） | 723／733MB | 431／501MB |
| 閒置壓縮 GC 後 | 約 270MB | 約 250MB |

heap 上限：改動前設 256MB 可把 RSS 壓到約 477MB；改動後再設只到 420／452MB，L3 開時多一次 93ms 停頓，不划算。160MB 以下會在載入時（解析 `lexicon.jsonl`）記憶體不足當掉。

### 更激進的計數剪枝（2026-10-16，`debug-prune.ts`，q=8、完美雜湊）

| bi／tri 下限 | 大表 | 筆數（詞二／詞三／字二／字三，百萬） | RSS | 句 口語／書面 |
|---|---|---|---|---|
| 2／4（預設） | 109MB | 8.2／6.7／2.7／8.0 | 259MB | 76.4／79.8 |
| 5／10 | 47MB | 3.5／2.2／1.6／3.4 | 174MB | 75.0／76.6 |
| 10／20 | 26MB | 1.9／1.0／1.1／1.8 | 153MB | 73.8／74.0 |
| 20／50 | 13MB | 1.1／0.3／0.8／0.7 | 140MB | 70.1／71.4 |
| 50／100 | 7MB | 0.5／0.1／0.4／0.4 | 132MB | 68.8／69.0 |
| 100／300 | 3MB | 0.3／0.0／0.3／0.1 | 127MB | 66.2／66.6 |

- 大表縮到 3MB，RSS 只降到約 127MB：剩下的是 Node、詞典索引、LM 小 Map，剪枝碰不到。
- 書面掉得比口語快。計數剪枝只看次數，不看刪掉後機率變多少；熵剪枝應該在同樣大小下掉得少（未驗證）。
- 最小的設定仍比微軟注音（50.9／57.2）高約 10 點。

### 退回式模型＋加權差異剪枝（2026-10-16，`debug-shrink.ts`、`debug-prune.ts`，**目前預設**）

存算好的 KN 機率與退回權重（`BackoffLM`），8 位元均勻碼本、16 位元指紋。剪枝分數＝出現比例 ×｜log 原機率 − log 退回後機率｜，刪完重算退回權重。

| 設定 | 大表 | RSS | 句 口語／書面 |
|---|---|---|---|
| 計數模型 `lm.bin`（2／4）＋二進位詞典 | 109MB | 220MB | 76.4／79.8 |
| 不剪枝，16 位元機率 | 299MB | — | 76.7／80.4（與計數全模型相同） |
| 不剪枝，8 位元 | 220MB | — | 76.0／80.6 |
| 18M 筆（權重 1:1:2:2） | 70MB | 137MB | 77.4／79.4 |
| **12M 筆（權重 1:1:2:2，預設）** | **46MB** | **115MB** | **76.1／79.4** |
| 8M 筆（1:1:1:1） | 32MB | 100MB | 75.2／76.2 |
| 6M 筆（1:1:2:2） | 25MB | 92MB | 75.1／76.4 |
| 6M 筆（1:0.5:1:0.5） | 24MB | 93MB | 74.3／75.4 |
| 4M 筆（1:1:1:1） | 17MB | 86MB | 73.6／73.6 |

- 同樣約 25MB，計數剪枝（10／20）是 73.8／74.0，加權差異多 +1.3／+2.4。
- 6M 筆時改四表權重（字級、三元各 ×0.5 或 ×2）只差 ±0.7；書面在 25MB 固定掉約 3.4 點，剪枝準則的極限。
- 指紋 16 或 32 位元結果一樣（誤中不是問題）。
- 踩過的坑：分位數碼本把格子給中段，P≈1 的尾端一格很寬，8 位元口語掉到 65；表裡 0 代表「沒存」，P≈1 量化成 0 會被當成沒存；EOS 只在 `cont` 裡，一元表漏掉它句尾全變詞彙外。前兩個都讓口語掉約 10 點，用 `debug-bo-diff.ts` 找到。
- RSS ≈ 70MB ＋ 大表大小（4M～18M 五個點都符合）。

### 打字中的 RSS 與 V8 heap 參數（2026-10-17，`debug-latency.ts 300`，預設 lm.bo.bin）

| V8 參數 | 打字 300 句後 RSS（L3 關／開） | 每鍵 p95（L3 關／開） | 閒置 GC 後 |
|---|---|---|---|
| 預設 | 299／315MB | 40／51ms | 122MB |
| `--max-semi-space-size=4` | 185／200MB | 37／48ms | 125MB |
| **`--max-semi-space-size=4 --max-old-space-size=128`（建議）** | **144／146MB** | **33／52ms** | **122MB** |
| `--max-semi-space-size=4 --max-old-space-size=96` | 146／148MB | 40／52ms | 124MB |
| 對照：計數模型 lm.bin、預設參數 | 403／472MB | 28／41ms | 226MB |

- 打字中的漲幅主要是新生代（semi-space）：解碼每鍵配置約 3.7MB 的短命物件；新生代上限縮小後，這些垃圾在新生代就被回收，不會一路升到舊生代把 heap 撐大（推論，依 heap 總量 209 → 40MB）。
- 打字中存活的 heap 只有 17～40MB，所以 old-space 上限 128MB 很安全。64MB 時 heap 曾用到 57MB，太貼近，不建議。以前 160MB 以下會當掉是解析 lexicon.jsonl 造成的，改讀 lexicon.bin 後已不需要。
- 延遲差異在量測誤差內（預設設定兩次量測 p95 分別是 34 與 40ms）。
- 常駐宿主（PIME）啟動 node 時要加這兩個參數；`.claude/launch.json` 的網頁測試台已加上。


### Rust 引擎（2026-10-17，`native/`）

`native/` 是引擎的 Rust 移植，涵蓋輸入法行程需要的全部層，加上 PIME 後端協定（`pime.rs`，見 §6）：

| 檔案 | 移植自 | 內容 |
|---|---|---|
| `keymap.rs`、`slots.rs` | `core/src/keymap.ts`、`slots.ts` | L1 大千、L2 組字區（游標、原樣字元、Backspace／Delete） |
| `l3.rs` | `core/src/l3.ts` | L3 通道 `Channel` |
| `decode.rs` | `core/src/decode.ts` | L4＋L5，加上 L3 更正讀音、固定段、X2 修飾、`breakdown.reading` |
| `lexicon.rs` | `core/src/lexicon.ts` | `lexicon.bin`＋執行中加詞的疊加層（`LexiconIndex.add` 語意） |
| `x2.rs` | `core/src/x2.ts` | `UserAdapter`，讀寫同格式的 `adapter.json` |
| `engine.rs` | `cli/src/engine.ts` | `ImeEngine`：選字視窗、游標鍵、標點、Esc、英文模式、送出學習 |

沒有移植：IDF 加成、基線模式（都要計數模型）、L6／L7（已封存）。

#### 對拍（`debug-native-parity.ts`，與 TS 逐位元組比較）

| 層 | 輸入 | 結果 |
|---|---|---|
| L1／L2 | 1500 句的大千按鍵 | 音節序列完全相同 |
| L4／L5 | 1500 句前 4 名 | 6000 行詞與分數完全相同（與原型相同） |
| L3 | 1500 句前 4 名，L3 開 | 6000 行詞、分數、採用讀音完全相同 |
| L3 | `debug-l3.ts` 的乾淨＋有錯輸入（a=0.8，s=1、1.5） | 3000 句首選與分數完全相同；句準確率與 `debug-l3.ts` 一致（s=1 有錯口語 53.4／47.4、書面 52.0／60.8） |
| X2 | 真實 `adapter.json`（16KB）讀進來再寫出 | 與 TS 寫出的、與原檔都相同 |
| 引擎 | 1500 句重播，72,818 個事件（含選字視窗 1,275 次、游標插字、Backspace／Delete、組字中空格與標點、Esc、英文模式、第 2 候選送出），L3 關／開各一次，固定時鐘 | 每個事件後的組字字串、合法旗標、游標、未完成注音、選字頁、直接輸出，以及送出文字都相同；學習後的 `adapter.json`（648KB，631 個使用者詞、1222 個挖詞）也相同 |

逐位元相同的做法：

- 迭代順序照 JS：狀態依插入順序、L3 候選依第一次出現的位置（更低代價只更新代價與讀音，不換位置）、穩定排序。
- 詞用編號比對：執行中加的詞若已存在於詞典（別的讀音下），沿用原編號，否則狀態鍵會和 TS（用字串）不同。
- `adapter.json` 用 serde_json 的 `preserve_order`：物件鍵保持插入順序，整數寫成整數。`phrases` 的順序就是加詞順序，會影響候選順序。
- X2 的 `Math.log`、`Math.pow` 改用 Rust 的 `ln`、`powf`，這次的資料上沒有出現末位差異。沒有證明一定相同。

#### 記憶體（`K32GetProcessMemoryInfo`）

| | Rust | Node |
|---|---|---|
| 載入後 | 工作集 63MB、私有 60MB | RSS 115MB |
| 重播 1500 句（L3 開、帶使用者資料、含選字） | 結束時工作集 56MB、私有 52MB；峰值工作集 91MB、峰值私有 90MB | 打 300 句約 312MB，閒置 GC 後 136MB |
| 每事件 | L3 關 1.6ms、L3 開 1.9ms（含重解碼與選字視窗） | TS 重播同一檔約 6 分鐘（L3 關），Rust 約 2 分鐘 |
| 載入時間 | 25ms | 約 1 秒 |
| 執行檔 | 609KB（release，含除錯符號表） | Node 本身約 70MB |

- 打完之後私有記憶體比載入後還低（60 → 52MB），原因沒查。
- 峰值 90MB 是某一刻的暫時配置，結束時已經放掉。沒查是哪一步；可能是很長的組字（游標插字讓句子變長）或選字視窗列全部候選。要查就在 `replay` 每個事件後記峰值。
- 剩下的約 60MB 幾乎全是模型：`lm.bo.bin` 51.5MB，詞典約 8MB。
- 模型已改成 mmap（§6「記憶體跟著使用走」）：私有 60 → 12MB，51MB 變成檔案映射頁。打字中的工作集不變（雜湊表的頁 10 句內就讀到 91–100%），但沒在用時會卸載。

#### 重現

```bash
cd native && cargo build --release && cd ..
ZHUYIN_DATA=<data 目錄> native/target/release/zhuyin-native.exe dump rust.txt 4 l3
ZHUYIN_DATA=<data 目錄> npx tsx debug-native-parity.ts dump node.txt 4 l3   # 兩個檔應該完全相同
ZHUYIN_DATA=<data 目錄> npx tsx debug-native-parity.ts events ev.txt
ZHUYIN_DATA=<data 目錄> ZHUYIN_L3=1 ZHUYIN_CLOCK=1792200000000 ZHUYIN_ADAPTER=adapter.json native/target/release/zhuyin-native.exe replay ev.txt rust.txt rust.json
ZHUYIN_DATA=<data 目錄> ZHUYIN_L3=1 ZHUYIN_CLOCK=1792200000000 ZHUYIN_ADAPTER=adapter.json npx tsx debug-native-parity.ts replay ev.txt node.txt node.json
```

`keys`、`l3` 子命令見 `native/src/main.rs` 檔頭。`ZHUYIN_A` 設詞級權重（預設 1；`debug-l3.ts` 用 0.8）。

### 兩個專家的貢獻（句準確率，口語／書面，`debug-expert.ts`）

| 設定 | 口語 | 書面 |
|---|---|---|
| 詞＋字（a=1，γ=0.5） | 76.5 | 79.8 |
| 只用詞級（γ=0） | 72.7 | 78.6 |
| 只用字級（a=0） | 69.7 | 73.0 |

字級模型貢獻 3.8／1.2 點，不能直接拿掉。

## 4. 雜湊表的好處與代價

載入 `lm.tsv` 時用開放定址表（`HashTable`）累加計數。打包時（`pack.ts`）再轉成最小完美雜湊表（`PerfectTable`）。兩者都只存指紋、不存鍵字串，實作在 `packages/lm/src/hashtable.ts`。

### 好處

- **直接用字串查。** 不必先把詞轉成編號。使用者造詞、詞典外的詞都能直接查，查不到就回 0。
- **點查很快。** 解碼一句會做大量查詢，多數查不到；雜湊對「查不到」也一樣快。完美雜湊固定 2–3 次陣列讀取，不需要探測。
- **不存鍵字串。** 開放定址表每鍵 5 bytes 指紋；完美雜湊每鍵 2 bytes 指紋，再加約 0.5 byte 的位移值。
- **GC 不掃描。** 資料放在 typed array 裡。改回 JS Map 時，實測每句多 700ms 延遲。
- **存檔簡單。** 陣列原樣倒出，`lm.bin` 載入約 1 秒。

### 代價（實測）

| 代價 | 數據 |
|---|---|
| 空槽（開放定址） | 載入率 0.75 時 25% 是空槽。0.9 不掉準確率，但慢約 25%。完美雜湊只留 3% 空槽 |
| 指紋誤中 | 開放定址 32 bit 指紋時，查不到的鍵約 0.7% 誤中，句準確率掉 1.5／2.6 點；40 bit 以上無損。完美雜湊 16 bit 指紋約 1/65536 誤中，實測無損 |
| 沒有區域性 | 開放定址表打第 1 句就碰到每張表 60–97% 的頁，10 句碰到 91–100%（`debug-pages.ts`，只支援 `ZHUYIN_LM_MPH=0`）。所以 mmap 省不了常駐記憶體 |
| 只能點查 | 不能列出「某上下文後面接過哪些詞」。之後要做下一詞預測，需要另一種索引 |
| 存計數不存機率 | 每次查詢都要算一次 KN，還要另外存上下文的總量和型別數（小 Map 約 36MB） |

## 5. 還能縮的地方

| # | 改動 | 影響 | 預期 | 狀態 |
|---|---|---|---|---|
| 1 | `tri>=4`、40 bit 指紋 | 大表 | 308 → 223MB | **已完成** |
| 2 | 詞典索引只存詞、縮陣列、載入後壓縮 GC | 詞典 | RSS −230MB | **已完成** |
| 3 | 最小完美雜湊 | 大表 | 223 → 109MB | **已完成，預設** |
| 4 | 閒置時壓縮 GC | 打字中的 heap | 閒置後回到約 250MB | **已完成**（`web.ts`） |
| 4b | 解碼減垃圾（見 §3） | 打字中的 heap | 每鍵配置 9.5 → 3.7MB，RSS 733 → 431MB | **已完成** |
| 5 | 存量化後的機率和退回權重，不存計數 | 小 Map＋bi 欄 | 估計 −20～30MB，查詢少算 KN | **已完成**（`BackoffLM`，預設） |
| 6 | 詞典改成預先編好的二進位（字串表＋索引） | 詞典 | RSS 259 → 220MB，載入 27ms | **已完成**（`lexicon.bin`） |
| 7 | 熵剪枝 | 大表 | 46MB 時 −0.3／−0.4；25MB 時 −1.3／−3.4 | **已完成**（加權差異版，12M 筆預設） |
| 8 | 依上下文排序的 trie | 大表 | 有區域性，適合 mmap | 未做，只有要 mmap 時才值得 |
| 9 | 引擎改用 Rust 等原生語言 | Node 本身 | 70 → 約 5MB | **完成**（`native/`，打字中私有 13MB、閒置 2MB，L1–L5＋X2＋引擎，與 TS 逐位元相同；PIME 後端已接，見 §6） |

## 6. PIME

PIME（[EasyIME/PIME](https://github.com/EasyIME/PIME)）是開源的 Windows 輸入法框架。2026-10-16 在本機安裝了 **2.0.0-beta**（`PIME-2.0.0-beta-setup.exe`，47.0MB，SignPath Foundation 簽章有效）。

### 架構（讀原始碼＋實測）

- **前端**：C++ 的 TSF DLL（`PIMETextService.dll`），x86／x64 各一份。
- **啟動器**：`PIMELauncher.exe`（2.0 改用 Rust 寫），實測會開兩個。
- **後端**：同一種後端只開一個行程，靠 stdin/stdout 一行一則訊息溝通。
  - 請求：`<client_id>|<JSON>`
  - 回應：`PIME_MSG|<client_id>|<JSON>`
  - 方法：`init`、`onActivate`、`filterKeyDown`／`onKeyDown` 等；回應帶 `compositionString`、`commitString`、`candidateList`。
  - 方法與回應欄位的完整清單在 `python\textService.py`（基底類別）。每則回應都要帶 `success`、`seqNum`；按鍵方法另帶 `return`。
- **後端怎麼被找到**（讀 `PIMELauncher.exe`、`PIMETextService.dll` 裡的字串推得）：兩者都讀 `backends.json`，再掃每個後端 `<workingDir>\input_methods\*\ime.json` 的 `guid`。啟動器靠它把 TSF 送來的 GUID 對到後端行程；DLL 在 `regsvr32` 時靠它向 Windows 註冊輸入法。所以加一個輸入法＝放檔案＋改 `backends.json`＋重新 `regsvr32`。
- **內附執行環境**：
  - Python 3（`python\python3`）：新酷音等
  - Node **v22.14.0 ia32**（32 位元）：小麥注音、小麥族語、小麥他命
- **授權**：LGPL-2.1。

### 安裝注意事項

- 靜默安裝（`/S`）只裝 Python 後端。Node 後端要從安裝檔解出 `node\`，放進 `C:\Program Files (x86)\PIME\node`，再對 x64／x86 的 `PIMETextService.dll` 執行 `regsvr32`（需系統管理員權限）。
- 用 SendInput 打進自己的 WinForms 文字框時，PIME 會把按鍵原樣放行，但微軟注音可以用（需 `ImmSetOpenStatus`）。WPF 文字框則兩者都原樣放行，需要另外設定 TSF 的鍵盤開啟 compartment。原因沒有查清楚，所以 PIME 改用直接驅動後端的方式量測（`debug-pime.ts`）。

### PIME 內建模型 vs 本專案（實測）

同一批評測句（口語 1000＋書面 500）、同樣的大千按鍵序列。PIME 是直接驅動後端（不含 TSF 開銷），本專案是直接呼叫 `ImeEngine`（只到 L5、不載入使用者資料）。

| | 本專案 | PIME 新酷音 | PIME 小麥注音 | 微軟注音 |
|---|---|---|---|---|
| 語言模型 | 詞級＋字級三元 KN | libchewing（詞頻＋規則） | unigram＋bigram | 未公開 |
| 句準確率 口語／書面 | **76.4／79.8** | 34.8／45.0 | 44.4／48.4 | 50.9／57.2 |
| 每鍵延遲 p50／p95／p99 | 0.00／14／23ms | 5.7／35／54ms | 0.08／0.19／0.29ms | 未測 |
| 每鍵 CPU | 2.8ms | 10.2ms | 0.09ms | 未測 |
| 冷啟動 | 約 1 秒（`lm.bin`＋詞典） | 81ms | 303ms | 登入時已載入 |
| 記憶體（私有） | 載入後約 115MB；打字中約 145MB（加 V8 參數，見 §3），不加約 300MB | 7MB（WS 21MB） | 119MB（WS 102MB） | `ctfmon` 10MB（WS 78MB，含共享映射） |

量測說明：

- 本專案的延遲是 300 句、L3 關（解碼減垃圾之後）。L3 開時是 p95 22／p99 38ms。只有聲調鍵會觸發整句解碼，所以 p50 幾乎是 0。
- 新酷音的 p50 有 5.7ms，大部分是 Python 每則訊息的處理開銷（例如每次都檢查設定檔有沒有變）。
- 新酷音和微軟注音會從打過的字學習，所以跑越多句，結果越受前面句子影響。新酷音跑之前已清空學習檔。
- 評測集和本專案的訓練語料同領域（PTT＋維基），本專案的準確率有領域優勢。
- 評測集裡有少數錯字句（例如「毛盾」），其他輸入法打出正確的「矛盾」反而算錯。

### PIME 什麼時候開、關後端行程

結論：**用到才開，開了就不關，掛了 1 秒後自動重開。** 所以要讓記憶體跟著使用走，只能在後端行程裡自己載入、卸載模型，不能靠結束行程。

證據：

| 來源 | 內容 |
|---|---|
| PIMELauncher 原始碼，`v2.0.0-beta` 標籤（本機裝的版本）的 `PIMELauncher/src/backend_manager.rs` | `get_backend_input` 在後端還沒有行程時才呼叫 `spawn_backend_process`。它是 `send_to_backend` 的第一步，所以第一則送往這個後端的訊息（client 啟用輸入法時的 `init`）才開行程 |
| 同一檔案 | 行程結束（不論正常結束或當掉）都回報 `Error`，`sleep(1s)` 後重開。只有啟動器本身關閉（輸入 channel 關掉）才停 |
| 同一檔案 | 沒有閒置計時、沒有「沒有 client 就關後端」的邏輯。client 斷線只會送 `{"method":"close"}` 給後端 |
| 同一檔案 | 看門狗：送出的請求 15 秒（`HANG_TIMEOUT`）沒回應，或寫入 stdin 卡 5 秒，就殺掉後端再重開。所以按鍵時載入模型必須遠低於 15 秒（實測 15–38ms） |
| `PIMELauncher.exe` 裡的字串 | 有 `Spawning backend`、`Restarting in 1s...`、`Forcing restart`，和原始碼一致 |
| 本機實測（2026-10-17 上午，只列行程、沒改任何設定） | 只有登入時（09:49:45）啟動的 `PIMELauncher.exe` 和它的 `/worker` 在跑，沒有任何 python／node 後端行程。PIME 的輸入法今天沒被用過，所以後端沒被開過 |

- 每個 client 是一個用輸入法的程式執行緒。同一個後端的所有 client 共用一個行程。
- master 在 2026-10-15 之後改了：重開前會把這個後端的 client 全部斷線，逼它們重新 `init`。`v2.0.0-beta` 不會斷線，重開後的新行程直接收到按鍵。本專案的後端不依賴 `init`／`onActivate` 也能處理按鍵，兩種版本都能用。
- 沒有實際在 TSF 下切換輸入法來驗證（會動到使用者正在用的輸入法）。要驗證：啟用新酷音後看工作管理員出現 `python.exe`，切走後它仍在。

### 記憶體跟著使用走（`native/src/pime.rs`、`native/src/lm.rs`）

| 時機 | 做法 |
|---|---|
| 後端行程啟動、`init`、`onActivate` | 不載入任何模型 |
| 第一個要組字的按鍵（`onKeyDown`） | 載入 `lm.bo.bin`（記憶體映射）、`lexicon.bin`、使用者詞 |
| 英文模式、沒在組字時的編輯鍵 | 不載入 |
| 閒置 `ZHUYIN_IDLE_SECS` 秒（預設 300）沒按鍵 | 存 adapter.json、丟掉引擎、`HeapCompact`＋清空工作集。組字到一半時不卸載，再等一輪 |
| 最後一個 client `onDeactivate` 或 `close` | 同上，立刻卸載 |
| 載入失敗（檔案不見） | 記到 stderr（啟動器會記 log），之後按鍵全部放行給應用程式，不重試 |

- **模型改用記憶體映射**（`MapViewOfFile`）。原本整個讀進 heap 再 leak，51.5MB 全算私有記憶體，也永遠放不掉。映射後：
  - 模型頁是檔案映射：不算私有、可以和其他行程共用，閒置時 Windows 可以直接丟掉（不必寫進分頁檔）。
  - 卸載時解除映射，工作集立刻歸零。
  - 準確率、速度不變：`zhuyin-native eval` 761／1000、397／500，每句 11.3ms（原本 11.9ms）。
- 詞典（約 8MB）是解析後的陣列，仍算私有；卸載時一起釋放。

#### 實測（`debug-pime-idle.ts`，L3 開、不學習、`ZHUYIN_IDLE_SECS=2`）

| 階段 | 私有記憶體 | 工作集 |
|---|---|---|
| 行程啟動、`onActivate` 後（沒載入） | 0.7MB | 4.6MB |
| 第一句打完（已載入） | 12.2MB | 53.7MB |
| 打完 300 句 | 13.3MB | 65.0MB |
| 閒置 2 秒卸載後 | 2.1–3.0MB | 0.3MB |
| 重新載入、打完一句 | 11.6MB | 50.2MB |
| 最後一個 client 停用後（停用那則訊息 5ms） | 2.0MB | 0.7MB |

對照：改之前常駐就是私有 61MB、工作集 64MB，不會降。

| 載入延遲 | 第一鍵（含載入） | 第一句裡最慢的一鍵 |
|---|---|---|
| 檔案快取熱（卸載後再打字） | 13.5–16.4ms | 31–39ms |
| 近似冷快取（`robocopy /J` 不經快取複製模型，再從副本載入），兩次 | 30.0／37.5ms | 116／178ms |
| 對照：已載入時的一般按鍵 | p50 0.09ms | p99 約 20–30ms |

- 第一句最慢的那一鍵是第一次整句解碼：要把映射的模型頁從檔案快取或磁碟讀進來。冷快取時約多 0.1 秒，只發生在開機後第一次打字。
- 「冷快取」是近似值：`robocopy /J` 用不經快取的 I/O 寫副本，但沒有驗證副本一定不在快取裡。真正的冷快取要重開機後量。
- 閒置 300 秒的預設是猜的。卸載的代價只有下一句第一鍵多約 15ms，所以設短一點（例如 60 秒）也可以。

### 本專案的 PIME 後端（2026-10-17，`native/src/pime.rs`）

沒有照原本的計畫包成 Node 輸入法，而是讓 Rust 執行檔自己當一個 PIME 後端：`zhuyin-native.exe pime` 直接講 stdin/stdout 協定。理由是 Node 本身就要約 70MB，Rust 整個行程打字中私有只要 13MB（模型是檔案映射，見下面「記憶體跟著使用走」）。

| 協定 | 做法 |
|---|---|
| `filterKeyDown` | 組字中（含選字視窗）全部攔下。沒在組字時只攔注音／聲調／標點鍵（網頁測試台的 `SEND` 去掉編輯鍵）；Ctrl／Alt 組合鍵、空白、Enter、方向鍵交給應用程式。英文模式全部放行 |
| `onKeyDown` | 虛擬鍵碼轉成 `KeyboardEvent.code`，`charCode` 當 `KeyboardEvent.key`（標點靠它），交給 `ImeEngine.on_key`。Enter（選字視窗沒開）＝`commit(0)` |
| 單按 Shift | `filterKeyDown` 記下「按了 Shift、之後沒按別的鍵」，`filterKeyUp` 回 true，`onKeyUp` 切換注音／英文（組字區先送出），並用 `showMessage` 顯示「注」／「英」 |
| 組字 | `compositionString`＝首選＋游標處的未完成注音；`compositionCursor` 以 UTF-16 計 |
| 選字視窗 | ↓ 開、數字選、Space／↓↑ 換頁、Esc 關（引擎原本的行為）；`setSelKeys` 設 `123456789`，直排一列 |
| 語言列 | Win8 以上加 `windows-mode-icon` 按鈕（`zh.ico`／`en.ico`），點它也能切換 |
| `onCompositionTerminated` | 清空引擎、不學習。已顯示的組字留在文件裡 |
| X2 | 每次送出後存 `%APPDATA%\PIME\zhuyin\adapter.json`（先寫暫存檔再改名）。檔案讀不懂時，這次不學習、不覆寫原檔 |
| 出錯 | 單則訊息 panic 時回 `{"success":false}`、清空組字，後端不結束 |

限制：

- 所有 client 共用一份組字狀態和中英模式（`pime.rs` 的 `ponytail:` 註記）。別的 client 送按鍵時，前一個 client 未送出的組字會被丟掉。
- 沒有全形／半形、Caps Lock；Shift+字母照網頁測試台當注音鍵，不是大寫英文。
- 協定沒有在真的 TSF 下跑過，只用 `debug-pime.ts` 模擬 DLL。裝上後要手動確認：候選視窗、語言列圖示、Shift 切換、`onCommand`、`showMessage`。

#### 協定實測（`debug-pime.ts zhuyin`，1500 句、59,095 鍵）

先跑行為檢查，通過後才打評測句。檢查項目：Shift+, → ，、Esc 清空、↓ 開選字視窗、2 選第二候選、Enter 送出、組字中單按 Shift 先送出再切英文、英文模式放行字母、切回注音。

| 設定 | 句 口語／書面 | 每鍵 p50／p95／p99／max | Enter | 每鍵 CPU | 結束時 WS／私有 | 峰值 WS |
|---|---|---|---|---|---|---|
| L3 關、不學習 | **76.1／79.4** | 0.15／11.5／19.6／373ms | 9.3ms | 2.2ms | 64／13MB | 67MB |
| L3 開、不學習 | 74.9／78.4 | 0.16／17.0／30.5／94ms | 14.1ms | 3.2ms | 65／14MB | 68MB |
| L3 開、從空的學習檔開始學（安裝後的預設；改 mmap 前量的） | 75.1／78.2 | 0.10／16.7／30.1／126ms | 20.0ms | 3.3ms | 81／78MB | 83MB |

- L3 關的句準確率和 `zhuyin-native eval` 完全相同（761／1000、397／500）。協定這一層沒有改變結果。
- L3 開在乾淨輸入上少 1.0～1.2 點。這是 L3 的代價，它只在打錯字時有用。
- 學習版的 Enter 較慢：每次送出都寫一次 adapter.json（跑完是 567KB）。私有記憶體多 17MB，是學到的詞與計數。
- 冷啟動 12ms（開行程到 `onActivate` 回來；模型要到第一個按鍵才載入）。
- 前兩列是改成記憶體映射、延遲載入之後量的。改之前同樣兩列是私有 61MB、每鍵 p95 10.9／15.8ms，準確率相同。
- L3 關那一輪有一鍵 373ms，p99 不變。原因沒查；可能是系統排程或映射頁被換出。要查就在 `debug-pime.ts` 記下最慢那一鍵的位置重跑。
- 學習那一列私有 78MB 是改 mmap 前量的；改之後應該約少 50MB（沒重量）。

#### 與 PIME 內建、微軟注音比較

| | 本專案（Rust 後端） | PIME 新酷音 | PIME 小麥注音 | 微軟注音 |
|---|---|---|---|---|
| 句準確率 口語／書面 | **76.1／79.4**（L3 開 74.9／78.4） | 34.8／45.0 | 44.4／48.4 | 50.9／57.2 |
| 每鍵延遲 p50／p95／p99 | 0.15／11.5／19.6ms（L3 開 0.16／17.0／30.5） | 5.7／35／54ms | 0.08／0.19／0.29ms | 未測 |
| 每鍵 CPU | 2.2ms（L3 開 3.2） | 10.2ms | 0.09ms | 未測 |
| 冷啟動 | 12ms（模型在第一鍵才載入，約 15ms） | 81ms | 303ms | 登入時已載入 |
| 記憶體（私有） | 打字中 13MB（WS 64MB，大多是模型的檔案映射頁）；沒在用時 2MB（WS 0.3MB） | 7MB（WS 21MB） | 119MB（WS 102MB） | `ctfmon` 10MB（WS 78MB） |

PIME 三欄的量法相同：直接驅動後端，不含 TSF 開銷。

#### 安裝本專案的後端（**尚未執行**，等使用者核准）

檔案在 `native/pime/`：

| 檔案 | 內容 |
|---|---|
| `ime.json` | 名稱「注音 (zhuyin-native)」、GUID `{64b60746-4570-4343-a34a-85c12f03a93a}`、zh-Hant-TW |
| `icon.ico`、`zh.ico`、`en.ico` | 輸入法圖示、注音／英文模式圖示（16／32／48px） |
| `install.ps1` | 組資料夾、改 `backends.json`、重新註冊 DLL；`-Stage` 只組資料夾，`-Uninstall` 移除 |

安裝後 PIME 目錄多出這些（`-Stage` 實測過）：

```
C:\Program Files (x86)\PIME\
  backends.json        多一筆 {"name":"zhuyin","command":"zhuyin\\zhuyin-native.exe","workingDir":"zhuyin","params":"pime"}
  zhuyin\zhuyin-native.exe
  zhuyin\data\models\lm.bo.bin            51.5MB
  zhuyin\data\processed\lexicon.bin
  zhuyin\data\processed\syllables.json
  zhuyin\input_methods\zhuyin\ime.json、icon.ico、zh.ico、en.ico
```

警告：第 3 步會改 PIME 的 `backends.json`，格式錯了 PIME 的所有輸入法都會失效。腳本會先備份成 `backends.json.bak`；輸出格式已在副本上驗證過。

1. 建置：`cd native && cargo build --release`。
2. （可選）先組出來看：`powershell -ExecutionPolicy Bypass -File native\pime\install.ps1 -Stage <暫存目錄> -Data <data 目錄>`。
3. 用**系統管理員**的 PowerShell 執行：`powershell -ExecutionPolicy Bypass -File native\pime\install.ps1 -Data C:\Users\q2927\Desktop\vscode\type\data`。腳本會：
   - 備份 `backends.json`，再加一筆 `zhuyin`（不含 BOM 的 UTF-8）。
   - 把上面的檔案複製到 `PIME\zhuyin\`。
   - 對 x64、x86 的 `PIMETextService.dll` 執行 `regsvr32 /s`。
4. 登出再登入，或結束 `PIMELauncher.exe` 後用**一般權限**重新啟動它。啟動器應該只在啟動時讀 `backends.json`（推論，沒查證）。
5. 到「設定 > 時間與語言 > 語言與地區 > 中文(台灣) > 語言選項 > 鍵盤」加入「注音 (zhuyin-native)」。
6. 移除：系統管理員 PowerShell 執行 `install.ps1 -Uninstall`。順序是先 `regsvr32 /u`（趁後端還在），再刪檔、改 `backends.json`，最後重新 `regsvr32` 其他輸入法。

授權：`lexicon.bin` 來自萌典（要標出處）與 libchewing（LGPL-2.1）。只在本機安裝不算散布；要散布安裝包時，照 CLAUDE.md「Data licensing constraints」附上授權與出處。
