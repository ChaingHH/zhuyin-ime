# PIME 筆記：架構、後端協定、生命週期與事故

本文件原本是 `docs/MEMORY.md` §6，2026-10-27 獨立出來。安裝教學見 [PIME-INSTALL.md](PIME-INSTALL.md)；記憶體與模型的實驗紀錄見 [MEMORY.md](MEMORY.md)。

各節標了量測日期。標「已被取代」的段落是當時的做法或數字，保留作紀錄，**不要照著做**。

## 現況（2026-10-27）

| 項目 | 現況 | 出處 |
|---|---|---|
| PIME 版本 | Setup 內附 PIME v2.0.0-beta3（v1.0.0 起）。v2.0.0-beta（10-04）的 DLL 在 RPC 失敗時讓宿主程式當掉，beta2 起修掉 | [CHANGELOG.md](../CHANGELOG.md) v1.0.0、[MS-CANDIDATES.md](MS-CANDIDATES.md) §5.4 |
| 後端 | `zhuyin-native.exe pime`，Rust 執行檔直接講 stdin/stdout 協定 | §2 |
| 生命週期 | 第一個組字鍵才載入引擎；閒置 `idleSecs`（預設 300 秒）或最後一個 client 停用就卸載 | §3 |
| 記憶體 | 打字中私有 15MB、工作集 69MB（2026-10-24，1500 句）；卸載後私有約 2MB、工作集 0.3MB（2026-10-17） | [PROJECT.md](PROJECT.md) §5、§3 |
| 延遲 | 每鍵 p50 0.22ms、p95 20.65ms、p99 41.72ms；Enter 17.48ms（2026-10-24）；卸載後第一鍵含載入約 15ms | [PROJECT.md](PROJECT.md) §5、§3 |
| 學習檔存檔 | Enter 只標記有改動，停手 30 秒、卸載或結束時才寫 | [MEMORY.md](MEMORY.md)「X2 學習資料的成長」 |
| 安裝 | `install.ps1` 改名取代、不停 PIME、不動其他後端；「只留本專案」由 `run.ps1` 改使用者的鍵盤清單 | §4、[PIME-INSTALL.md](PIME-INSTALL.md) |

後端必須守的規則（`debug-pime.ts` 會檢查；理由見 §1、§4）：

- **絕不停 PIMELauncher。** 啟動器停掉時，所有載入 PIME 的程式都會當掉。
- 每則帶 seqNum 的請求（含 `close`）都要回同一個 seqNum，而且要在 2 秒內回。PIMELauncher 15 秒沒收到回應就殺掉後端重開。
- 後端不能在處理請求時結束。
- `onCommand`、`onMenu` 等沒有 edit session 的回應不能帶 `showMessage`。

## 1. PIME 的架構（2026-10-16，讀原始碼＋實測）

PIME（[EasyIME/PIME](https://github.com/EasyIME/PIME)）是開源的 Windows 輸入法框架。2026-10-16 在本機安裝了 **2.0.0-beta**（`PIME-2.0.0-beta-setup.exe`，47.0MB，SignPath Foundation 簽章有效）。v1.0.0 起 Setup 改為內附 v2.0.0-beta3。

- **前端**：C++ 的 TSF DLL（`PIMETextService.dll`），x86／x64 各一份。
- **啟動器**：`PIMELauncher.exe`（2.0 改用 Rust 寫），實測會開兩個。
- **後端**：同一種後端只開一個行程，靠 stdin/stdout 一行一則訊息溝通。
  - 請求：`<client_id>|<JSON>`
  - 回應：`PIME_MSG|<client_id>|<JSON>`
  - 方法：`init`、`onActivate`、`filterKeyDown`／`onKeyDown` 等；回應帶 `compositionString`、`commitString`、`candidateList`。
  - 方法與回應欄位的完整清單在 `python\textService.py`（基底類別）。每則回應都要帶 `success`、`seqNum`；按鍵方法另帶 `return`。
- **哪些回應能動組字**（讀 `PIMETextService/PIMEClient.cpp`，`v2.0.0-beta`）：只有 `onKeyDown`、`onKeyUp` 把 edit session 傳給 `handleRpcResponse`，其他方法（`onCommand`、`onMenu`、`filterKeyDown`、`onActivate`…）都是空指標。`updateStatus` 裡的 `updateMessageWindow` 在檢查 session 之前執行，沒在組字時會呼叫 `session->context()`：**這些方法的回應帶 `showMessage` 會讓宿主程式當掉**。`commitString`／`compositionString`／候選視窗則是沒有 session 就直接忽略。2026-10-17 使用者點「注／英」圖示閃退就是這個原因（舊版在 `onCommand` 回 `showMessage`），`debug-pime.ts` 的行為檢查現在會擋。
- **RPC 失敗會讓宿主程式當掉**（`PIMETextService/PIMEClient.cpp`，`v2.0.0-beta`）：
  - `callRpcMethod`（703 行起）只在解析 JSON 與比對 `seqNum` 時有 `try`（717–725 行）。連不上啟動器（`waitForRpcConnection` 試 3 次）、寫入或讀取逾時（`callRpcPipe` 677 行 `timeoutMs = 2000`）、管線斷掉時，回傳 false，`ret` 留在預設的 null。
  - 呼叫端照樣執行 `handleRpcResponse(ret)`（393、402、414、438、464、478、588、600、611 行等），第 90 行 `msg.value("success", false)` 對 null 呼叫 `value()`。nlohmann 3.12（DLL 裡有 `json_abi_v3_12_0` 與 `cannot use value() with` 字串）在非物件上呼叫 `value()` 會丟 `type_error.306`（`json.hpp` 22282 行）。
  - 這個例外沒有人接，`std::terminate` → `abort`，在宿主程式裡以 `ucrtbase.dll` 的 `0xc0000409` 結束（SearchHost 先記到 MSVC C++ 例外 `0xe06d7363`）。
  - 所以**啟動器停掉、後端超過 2 秒沒回、或後端在處理請求時死掉，所有用著 PIME 的程式都會當掉**。Explorer 重開後一碰到輸入法又當，變成一秒一次。
- **log**：PIMELauncher 背景模式把 log 寫到 sink（`tracing_subscriber` 的 `std::io::sink`），`%LOCALAPPDATA%\PIME\Log\PIMELauncher.log` 是空的。`PIMELauncher.exe /console` 才會顯示 log 和後端的 stderr；`/quit` 會通知所有執行中的啟動器結束。
- **後端怎麼被找到**（讀 `PIMELauncher.exe`、`PIMETextService.dll` 裡的字串推得）：兩者都讀 `backends.json`，再掃每個後端 `<workingDir>\input_methods\*\ime.json` 的 `guid`。啟動器靠它把 TSF 送來的 GUID 對到後端行程；DLL 在 `regsvr32` 時靠它向 Windows 註冊輸入法。所以加一個輸入法＝放檔案＋改 `backends.json`＋重新 `regsvr32`。
- **內附執行環境**：
  - Python 3（`python\python3`）：新酷音等
  - Node **v22.14.0 ia32**（32 位元）：小麥注音、小麥族語、小麥他命

### 安裝注意事項

- 靜默安裝（`/S`）只裝 Python 後端。Node 後端要從安裝檔解出 `node\`，放進 `C:\Program Files (x86)\PIME\node`，再對 x64／x86 的 `PIMETextService.dll` 執行 `regsvr32`（需系統管理員權限）。
- 用 SendInput 打進自己的 WinForms 文字框時，PIME 會把按鍵原樣放行，但微軟注音可以用（需 `ImmSetOpenStatus`）。WPF 文字框則兩者都原樣放行，需要另外設定 TSF 的鍵盤開啟 compartment。原因沒有查清楚，所以 PIME 改用直接驅動後端的方式量測（`debug-pime.ts`）。

## 2. 本專案的 PIME 後端（2026-10-17，`native/src/pime.rs`）

沒有照原本的計畫包成 Node 輸入法，而是讓 Rust 執行檔自己當一個 PIME 後端：`zhuyin-native.exe pime` 直接講 stdin/stdout 協定。理由是 Node 本身就要約 70MB，Rust 整個行程打字中私有只要 13MB（模型是檔案映射，見 §3「記憶體跟著使用走」）。

下表是 2026-10-17 的版本。之後的改動（現在的行為以程式碼與 [PROJECT.md](PROJECT.md) §3「引擎與 PIME」為準）：

- 選字視窗 →／Tab 展開成表格（v0.99.0）。
- 每則帶 seqNum 的請求（含 `close`）都回應（2026-10-21，見檔頭規則）。
- adapter.json 改成停手 30 秒才寫，不是每次送出都寫（2026-10-18）。
- Shift 組合打半形標點，Ctrl＋原按鍵打全形（v1.0.2）；Shift＋字母打英文（v1.0.3）。
- 設定多了 `usageLog`、`learning`（v1.0.2、v1.0.3）。

| 協定 | 做法 |
|---|---|
| `filterKeyDown` | 組字中（含選字視窗）全部攔下。沒在組字時只攔注音／聲調／標點鍵（網頁測試台的 `SEND` 去掉編輯鍵）；Ctrl／Alt 組合鍵、空白、Enter、方向鍵交給應用程式。英文模式全部放行 |
| `onKeyDown` | 虛擬鍵碼轉成 `KeyboardEvent.code`，`charCode` 當 `KeyboardEvent.key`（標點靠它），交給 `ImeEngine.on_key`。Enter（選字視窗沒開）＝`commit(0)` |
| 單按 Shift | `filterKeyDown` 記下「按了 Shift、之後沒按別的鍵」，`filterKeyUp` 回 true，`onKeyUp` 切換注音／英文（組字區先送出），並用 `showMessage` 顯示「注」／「英」 |
| 組字 | `compositionString`＝首選＋游標處的未完成注音；`compositionCursor` 以 UTF-16 計 |
| 選字視窗 | 微軟注音鍵位（2026-10-17 改，TS／Rust 同步）：↓ 開、↓↑ 移反白（跨頁、循環）、空白／PageDown 下一頁、PageUp 上一頁、Enter 選反白、數字選、Esc 關。反白送 `candidateCursor`；`setSelKeys` 設 `123456789`，直排一列 |
| 語言列 | Win8 以上加 `windows-mode-icon` 按鈕（`zh.ico`／`en.ico`）。左鍵＝`onCommand` id 1，只換模式（組字中不換）；右鍵＝`onMenu` 回傳選單（切換中／英；Shift 三選一：id 4 兩邊、2 只用左、3 只用右。`menuFromJson` 沒有單選格式，用 `checked` 標目前那個），選了再送 `onCommand`（type 2） |
| 設定 | `%APPDATA%\PIME\zhuyin\config.json`：`shiftToggle`（`both`／`left`／`right`，右 Shift 用掃描碼 0x36 或 `keyStates[VK_RSHIFT]` 判斷）、`idleSecs`、`l3`；每次 `onActivate` 重讀 |
| `onCompositionTerminated` | 清空引擎、不學習。已顯示的組字留在文件裡 |
| X2 | 每次送出後存 `%APPDATA%\PIME\zhuyin\adapter.json`（先寫暫存檔再改名）。檔案讀不懂時，這次不學習、不覆寫原檔 |
| 出錯 | 單則訊息 panic 時回 `{"success":false}`、清空組字，後端不結束 |

限制：

- 所有 client 共用一份組字狀態和中英模式（`pime.rs` 的 `ponytail:` 註記）。別的 client 送按鍵時，前一個 client 未送出的組字會被丟掉。
- （已被取代，v1.0.2／v1.0.3）沒有全形／半形、Caps Lock；Shift+字母照網頁測試台當注音鍵，不是大寫英文。
- （已被取代：2026-10-17 已裝進 TSF 實際使用）協定沒有在真的 TSF 下跑過，只用 `debug-pime.ts` 模擬 DLL。裝上後要手動確認：候選視窗、語言列圖示、Shift 切換、`onCommand`、`showMessage`。

### 協定實測（2026-10-17，`debug-pime.ts zhuyin`，1500 句、59,095 鍵）

最新一次（2026-10-24）的數字見檔頭「現況」。

先跑行為檢查，通過後才打評測句。檢查項目：Shift+, → ，、Esc 清空、↓ 開選字視窗、2 選第二候選、Enter 送出、組字中單按 Shift 先送出再切英文、英文模式放行字母、切回注音。

| 設定 | 句 口語／書面 | 每鍵 p50／p95／p99／max | Enter | 每鍵 CPU | 結束時 WS／私有 | 峰值 WS |
|---|---|---|---|---|---|---|
| L3 關、不學習 | **76.1／79.4** | 0.15／11.5／19.6／373ms | 9.3ms | 2.2ms | 64／13MB | 67MB |
| L3 開、不學習 | 74.9／78.4 | 0.16／17.0／30.5／94ms | 14.1ms | 3.2ms | 65／14MB | 68MB |
| L3 開、從空的學習檔開始學（安裝後的預設；改 mmap 前量的） | 75.1／78.2 | 0.10／16.7／30.1／126ms | 20.0ms | 3.3ms | 81／78MB | 83MB |

- L3 關的句準確率和 `zhuyin-native eval` 完全相同（761／1000、397／500）。協定這一層沒有改變結果。
- L3 開在乾淨輸入上少 1.0～1.2 點。這是 L3 的代價，它只在打錯字時有用。
- 學習版的 Enter 較慢：當時每次送出都寫一次 adapter.json（2026-10-18 起改成停手 30 秒才寫）（跑完是 567KB）。私有記憶體多 17MB，是學到的詞與計數。
- 冷啟動 12ms（開行程到 `onActivate` 回來；模型要到第一個按鍵才載入）。
- 前兩列是改成記憶體映射、延遲載入之後量的。改之前同樣兩列是私有 61MB、每鍵 p95 10.9／15.8ms，準確率相同。
- L3 關那一輪有一鍵 373ms，p99 不變。原因沒查；可能是系統排程或映射頁被換出。要查就在 `debug-pime.ts` 記下最慢那一鍵的位置重跑。
- 學習那一列私有 78MB 是改 mmap 前量的；改之後應該約少 50MB（沒重量）。

### 與 PIME 內建、微軟注音比較（2026-10-17）

| | 本專案（Rust 後端） | PIME 新酷音 | PIME 小麥注音 | 微軟注音 |
|---|---|---|---|---|
| 句準確率 口語／書面 | **76.1／79.4**（L3 開 74.9／78.4） | 34.8／45.0 | 44.4／48.4 | 50.9／57.2 |
| 每鍵延遲 p50／p95／p99 | 0.15／11.5／19.6ms（L3 開 0.16／17.0／30.5） | 5.7／35／54ms | 0.08／0.19／0.29ms | 未測 |
| 每鍵 CPU | 2.2ms（L3 開 3.2） | 10.2ms | 0.09ms | 未測 |
| 冷啟動 | 12ms（模型在第一鍵才載入，約 15ms） | 81ms | 303ms | 登入時已載入 |
| 記憶體（私有） | 打字中 13MB（WS 64MB，大多是模型的檔案映射頁）；沒在用時 2MB（WS 0.3MB） | 7MB（WS 21MB） | 119MB（WS 102MB） | `ctfmon` 10MB（WS 78MB） |

PIME 三欄的量法相同：直接驅動後端，不含 TSF 開銷。

## 3. 後端行程的生命週期

### PIME 什麼時候開、關後端行程（2026-10-17）

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

### 記憶體跟著使用走（2026-10-17，`native/src/pime.rs`、`native/src/lm.rs`，目前做法）

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

### 實測（`debug-pime-idle.ts`，L3 開、不學習、`ZHUYIN_IDLE_SECS=2`）

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

## 4. 事故：Explorer 連續當機（2026-10-18、2026-10-20）

| 時間 | 事件（Windows 事件記錄、檔案時間） |
|---|---|
| 2026-10-17 23:08:11–23:08:53 | ApplicationFrameHost、Explorer 當掉 3 次：錯誤模組 `PIMETextService.dll`、`0xc0000005`、位移 `0x26d8f`。使用者點「注／英」圖示，`onCommand` 的回應帶 `showMessage`，DLL 解參考空的 edit session。3bb05bf 修掉 |
| 2026-10-18 00:33:16 | 3bb05bf 版 `install.ps1` 執行：先 `PIMELauncher.exe /quit`（沒停掉就強制結束），再複製新檔 |
| 00:33:20 | `%APPDATA%\PIME\zhuyin\adapter.json` 寫入：舊後端 stdin 關閉時卸載存檔，表示啟動器已經停了 |
| 00:34:58–00:35:19 | Explorer 每秒當一次，共 23 次：錯誤模組 `ucrtbase.dll`、`0xc0000409`。接著 ApplicationFrameHost（`0xc0000409`）、SearchHost（`0xe06d7363`） |
| 00:36:35 | 使用者重開機；啟動器在登入時（00:37:37）重新啟動，之後正常 |

根因（推論，證據如下）：

- **不是新後端的回應格式。** 3bb05bf 與正常運作的 2235772 在 `init`、`onActivate` 的回應逐位元組相同（`git diff 2235772 3bb05bf -- native/src/pime.rs` 只改了按鍵、選單、`onCommand`）。新版的每一則回應都通過 `debug-pime.ts` 的格式檢查，型別都是 DLL 讀得懂的。
- **是安裝腳本把 PIMELauncher 停掉。** 停掉之後，任何載入了 PIME 的程式一呼叫 DLL，RPC 就失敗，觸發 §1「RPC 失敗會讓宿主程式當掉」的未捕捉例外。Explorer（工作列、搜尋框都用 TSF）重開後馬上又呼叫、又當，變成一秒一次。舊版腳本不停 PIME，所以第一次安裝沒事。
- `0xc0000409` 在 `ucrtbase.dll`（`abort` 的 fail-fast），與 23:08 那次在 `PIMETextService.dll` 裡的 `0xc0000005` 不同，是另一個錯誤。
- 沒有直接證據：PIME 不寫 log，WER 報告要系統管理員權限才能讀，這段時間啟動器是否一直停著是從 adapter.json 的寫入時間與重開機後恢復推得的。

修正（`native/pime/install.ps1`）：

- 不再停 PIME。被鎖住的執行檔與映射中的模型改名成 `*.old-<時間>` 再放新檔：Windows 允許改名執行中的 exe 和有映射的檔案，只是不能覆寫（實測：覆寫失敗訊息與使用者看到的一樣；改名、甚至刪除改名後的映射檔都成功，後端照常回應）。
- 更新前把 `zhuyin\` 備份成 `zhuyin.prev\`，新增 `-Rollback`。
- 已經裝過時不再 `regsvr32`（只有第一次安裝、`-RestoreAll`、`-Uninstall` 才會）。
- 2026-10-20 12:05–12:06：Explorer 又一秒當一次（66 次，`ucrtbase.dll` `0xc0000409`，和 10/18 同樣的特徵），12:07 登出再登入後停止。前一刻（12:04）的安裝預設做了 `-OnlyZhuyin`：`backends.json` 只剩 zhuyin、重新註冊 DLL。使用者的鍵盤清單（`Get-WinUserLanguageList` 的 `InputMethodTips`）還留著 5 個被拿掉的 PIME 輸入法。推論：Explorer 裡這些輸入法的 DLL 實例向啟動器要一個已經不存在的後端，RPC 失敗，觸發未捕捉例外（沒看到傾印，時間與特徵吻合）。
- 修正：拿掉 `-OnlyZhuyin`。「只留本專案」改由 `run.ps1` 以一般權限改使用者的鍵盤清單：拿掉其他 PIME 的 tip（CLSID 從 `HKLM:\SOFTWARE\Microsoft\CTF\TIP` 找有本專案 profile 的那個），加上本專案，非 PIME 的（微軟注音）保留。不動 `backends.json`、不重新註冊。`-RestoreAll` 與 `-Uninstall` 仍會用 `backends.json.full` 還原舊狀態。
- `docs/PIME-INSTALL.md` 拿掉「`/quit` 後用 `/console` 看 log」的建議，加上不要停啟動器的警告。

後端這邊要守的規則（`debug-pime.ts` 會檢查）：每則請求都要在 2 秒內回（檢查器 1 秒就報錯），而且後端不能在處理請求時結束。

## 5. 初次安裝（2026-10-17，已被取代）

> **警告：不要照這一節做。** 第 4 步「結束 `PIMELauncher.exe`」會讓所有用著 PIME 的程式當掉（§4）。`install.ps1` 的參數與行為也已經改了（改名取代、`-Rollback`、不重複 `regsvr32`）。現在的安裝方式見 [PIME-INSTALL.md](PIME-INSTALL.md)。

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

## 6. PIME 內建模型 vs 本專案（2026-10-16，TS 引擎時代，已被取代）

本專案這一欄是當時的 Node／TS 引擎。Rust 後端的比較見 §2「與 PIME 內建、微軟注音比較」；其他三欄的數字仍然有效。

同一批評測句（口語 1000＋書面 500）、同樣的大千按鍵序列。PIME 是直接驅動後端（不含 TSF 開銷），本專案是直接呼叫 `ImeEngine`（只到 L5、不載入使用者資料）。

| | 本專案 | PIME 新酷音 | PIME 小麥注音 | 微軟注音 |
|---|---|---|---|---|
| 語言模型 | 詞級＋字級三元 KN | libchewing（詞頻＋規則） | unigram＋bigram | 未公開 |
| 句準確率 口語／書面 | **76.4／79.8** | 34.8／45.0 | 44.4／48.4 | 50.9／57.2 |
| 每鍵延遲 p50／p95／p99 | 0.00／14／23ms | 5.7／35／54ms | 0.08／0.19／0.29ms | 未測 |
| 每鍵 CPU | 2.8ms | 10.2ms | 0.09ms | 未測 |
| 冷啟動 | 約 1 秒（`lm.bin`＋詞典） | 81ms | 303ms | 登入時已載入 |
| 記憶體（私有） | 載入後約 115MB；打字中約 145MB（加 V8 參數，見 [MEMORY.md](MEMORY.md) §3），不加約 300MB | 7MB（WS 21MB） | 119MB（WS 102MB） | `ctfmon` 10MB（WS 78MB，含共享映射） |

量測說明：

- 本專案的延遲是 300 句、L3 關（解碼減垃圾之後）。L3 開時是 p95 22／p99 38ms。只有聲調鍵會觸發整句解碼，所以 p50 幾乎是 0。
- 新酷音的 p50 有 5.7ms，大部分是 Python 每則訊息的處理開銷（例如每次都檢查設定檔有沒有變）。
- 新酷音和微軟注音會從打過的字學習，所以跑越多句，結果越受前面句子影響。新酷音跑之前已清空學習檔。
- 評測集和本專案的訓練語料同領域（PTT＋維基），本專案的準確率有領域優勢。
- 評測集裡有少數錯字句（例如「毛盾」），其他輸入法打出正確的「矛盾」反而算錯。
