# 微軟注音的選字行為：規格與 PIME 能做到的部分

2026-10-18 整理，未完成。下面每條都標了來源；「未確認」的是官方文件沒寫的部分。

## 1. 官方文件寫到的（第一手來源）

來源 A：[Microsoft Traditional Chinese IME](https://support.microsoft.com/help/5001290)（support.microsoft.com，Applies to Windows 11、Windows 10）的 Microsoft Bopomofo 段落。
來源 B：[Traditional Chinese IME](https://learn.microsoft.com/en-us/globalization/input/traditional-chinese-ime)（Microsoft Learn，2024-06-19）的「Use the Bopomofo IME」。

| 情況 | 按鍵 | 行為 | 來源 |
|---|---|---|---|
| 視窗還沒開 | ↓ | 開選字視窗："Enter the candidate window." | A |
| 視窗還沒開 | ↑ | 不開視窗、直接換成另一個候選："Change to another candidate without opening the candidate window." | A |
| 視窗開著 | ↓／↑ | 反白下移／上移 | A、B |
| 視窗開著 | Space | 下一頁 | A、B |
| 視窗開著 | Tab、→ | 展開成表格（B：表格可用方向鍵移動） | A（Tab、→）、B（只寫 Tab） |
| 視窗開著 | 數字 | 選對應的候選 | A、B |
| 視窗開著 | Enter | 選反白的候選 | A、B |
| 視窗開著 | Esc | 關視窗、不選，並刪掉打的字："close the window without making a selection and deleting the character you entered" | B（A 沒寫） |
| 選字之後 | Shift＋數字 | 聯想詞視窗（要開「Prompt associated phrases」設定） | A、B |
| 讀音顯示 | — | "IME suggests the Bopomofo reading of what is typed at the last candidate in the candidate window."：**候選清單的最後一項是打的注音本身** | A（Bopomofo 的 Other features） |

## 2. 官方文件沒寫、由使用者確認的（每天用微軟注音，2026-10-18）

| 項目 | 微軟注音的行為 | 本專案目前 |
|---|---|---|
| ↓ 開哪一段 | 游標**後面**那個字開始；游標在組字區最後時是最後一個字 | 相同（`menuStart`＝`min(cursor, n−1)`） |
| 視窗開著時 ← → | → 和 Tab 把清單展開成多欄表格。表格裡 ← → 左右換欄（同一列；那欄較短就到它最後一個）；最右欄再 → 到下一頁最左欄（最後一頁回第一頁），最左欄再 ← 回上一頁最右欄；只有第一頁最左欄的 ← 收回成一欄（使用者指定，2026-10-21）。**不是**改變選字範圍 | 已做（`pime.rs` 管展開／收回，引擎 `menu_move` 管換欄，見第 3 節） |
| 選字後游標 | 游標移到選定那段**後面的下一個字或詞的開頭** | 相同（2026-10-18 改：`select` 之後把游標設到 `pos + len`）。改之前游標留在選定那段的前面 |

仍未確認：PageUp／PageDown（本專案自訂為上一頁／下一頁）、視窗外 Home、End、Backspace、Delete 的細節。

## 3. PIME 的候選視窗能調什麼

依據：PIME `v2.0.0-beta` 的 `PIMETextService/PIMEClient.cpp`（`updateUI`、`updateSelectionKeys`、`updateCandidateList`、`updateStatus`）、`PIMETextService.cpp`／`.h`，以及 libIME2 `717b190` 的 `src/CandidateWindow.cpp`。

| 項目 | 能否控制 | 怎麼做（2026-10-18 已做） |
|---|---|---|
| 直排 | 能 | `customizeUI.candPerRow = 1` |
| 編號 | 能 | `setSelKeys` 設 `123456789`：每列畫成「1. 候選」（`CandidateWindow.cpp:256` 的 `L"?. "`） |
| 反白 | 能 | `customizeUI.candUseCursor = true`，加上每次送 `candidateCursor` |
| 字型、字級 | 能 | `onActivate` 送 `candFontName = "Microsoft JhengHei UI"`、`candFontSize = 14`（點數，`PIMETextService.cpp:416` 換算成像素）。`config.json` 的 `candFontName`／`candFontSize` 可改。字級 14 是估的，沒有和微軟注音並排量過 |
| 表格展開（→／Tab）、收回（←） | 能 | 使用者指定 9×4（2026-10-21）：直的 9 個、橫的 4 欄，每欄由上往下 1–9，一頁 36 個（引擎 `set_page_size`），反白走過最後一個就翻頁；← → 換欄、到邊界換頁、第一頁最左欄 ← 收回；數字選反白那一欄的第 n 個。DLL 逐列畫，所以 `pime.rs` `grid` 把引擎的欄順序轉置成列順序，每次帶候選清單時一起送對應的 `setSelKeys`（`1111 2222 …`）。最後一頁不滿時欄數跟著減（`menu_page_len_after` 先算出按鍵後那一頁的大小）；最後一欄中間的空格 DLL 仍會畫出「 . 」。收回成 1 欄 9 個。視窗關掉後再開，回到一欄。欄數每個 client 各記一份：每個程式各有一份 DLL，只記一份時別的程式 `onActivate` 後清單會變成橫的 1×9 |
| 顏色、圓角、陰影、分頁指示 | **不能** | 顏色寫死為系統色 `COLOR_WINDOWTEXT`／`COLOR_WINDOW`，邊框是 3D 邊框（`CandidateWindow.cpp:200–216`），協定沒有對應欄位 |
| 讀音放在清單最後一項 | 能 | 在 `candidateList` 最後加上讀音字串（引擎的工作，見第 4 節） |

`candPerRow` 的時機：`updateStatus` 最後才套用 `customizeUI`，而 `candPerRow` 要到下一次 `updateCandidates` 才會用上（`PIMETextService.cpp:269`）。所以和 `candidateList` 放在同一則回應時，新欄數要晚一個鍵才看得到。做法：在同一個鍵的 `filterKeyDown` 回應先送 `candPerRow`，`onKeyDown` 回應再帶候選清單。`filterKeyDown` 沒有 edit session，但 `updateUI` 不碰 session，所以安全。`debug-pime.ts` 的格式檢查會擋「`candPerRow` 和 `candidateList` 同一則」。

## 4. 引擎裡的三項（2026-10-18 完成）

`packages/cli/src/engine.ts` 與 `native/src/engine.rs`（`ImeEngine`）同時改，`debug-native-parity.ts` 對拍逐位元組相同。

1. **選字後游標**：`select` 之後游標設到選定那段的結尾（`pos + len`），也就是下一個字或詞的開頭。
2. **注音本身是清單最後一項**：清單最後加上游標後那個音節的注音（例如 `ㄧㄢˋ`；原樣字元沒有注音，不加）。
   - 選了它，那個音節就照打的注音輸出，送出也是注音。
   - 解碼器（`decode.ts`／`decode.rs` 的固定段處理）：長度 1、詞等於該音節的固定段，照原樣 token 的方式輸出，不查詞典。
   - 學習：這種段落和原樣字元一樣不學、當詞界（`opaque`），注音不會變成使用者詞，也不記選字。
3. **視窗外 ↑**：不開視窗，把從游標開始的那個詞換成清單裡的下一個候選。游標不動，連按就在同一處輪換，輪到最後回到第一個。注音本身不參加輪換（微軟注音是否包含它沒有確認）。
   - 換字的依據是首選路徑在游標處的那個詞。例如「經驗」按一次 ↑ 變成「經|驗」（字一樣，斷詞換了），再按一次變成「晶驗」。

## 5. PIME 還有沒有其他管道改選字視窗外觀（2026-10-18 調查）

### 結論

**沒有。** 協定能改外觀的只有 `customizeUI` 的四個欄位和 `setSelKeys`，PIME master（2026-10-18）也一樣。要更像微軟注音，建議**送修補給 PIME 上游**（第 5.3 節選項 1）。自己畫視窗、自己寫 TSF 都比較貴，理由見下。

另外，PIME 上游已經修掉 2026-10-18 那次 Explorer 連續當機的根因（見 5.4），**建議把 PIME 升到 v2.0.0-beta3**。

### 5.1 查了什麼

| 來源 | 版本 | 結果 |
|---|---|---|
| `PIMETextService/PIMEClient.cpp` `updateUI` | v2.0.0-beta 與 master（2026-10-18） | 只認 `candFontName`、`candFontSize`、`candPerRow`、`candUseCursor`（master 125–135 行） |
| `PIMETextService/PIMETextService.cpp` | master | 候選視窗外觀全交給 libIME2；318 行仍是 `TODO: implement ITfCandidateListUIElement interface to support UI less mode` |
| libIME2 `src/CandidateWindow.cpp` | `6446eed`（PIME master 的子模組） | 文字與背景用系統色 `GetSysColor(COLOR_WINDOWTEXT／COLOR_WINDOW)`（203–204 行），3D 邊框（218–219 行），選字鍵固定藍色 `RGB(0, 0, 255)`（381 行）。沒有 DPI 縮放、深色模式、圓角；只有 Windows 8「immersive」模式畫黑框（207–210 行） |
| libIME2 `CandidateWindow.cpp` 64、96 行 | 同上 | 有實作 `ITfUIElement`／`ITfCandidateListUIElement`：UI-less 的宿主程式（例如全螢幕遊戲）可以自己畫候選。這是宿主程式的選擇，輸入法後端不能用它改外觀 |
| PIME 的請求內容（`createRpcRequest`、`addKeyEventToRpcRequest`） | master | 沒有任何請求帶游標或組字區的螢幕座標。DLL 自己用 TSF 的 `selectionRect` 定位視窗（`PIMETextService.cpp` `updateCandidatesWindow`） |
| 其他後端 | 本機安裝的小麥注音（`node/input_methods/McBopomofo/index.js`）、新酷音（`chewing_ime.py`） | 都只送同樣的 `customizeUI`（小麥注音：`candFontName: "Microsoft YaHei"`、`candPerRow: 1`），沒有自己畫視窗 |
| 設定檔 | `PIMETextService.dll` 的字串 | DLL 只讀 `backends.json` 與各輸入法的 `ime.json`，沒有外觀設定檔 |

### 5.2 PIME 做不到的微軟注音外觀

- 顏色：深色模式、反白色、選字鍵顏色（固定藍色）。
- 圓角、陰影、Windows 11 的 Mica 材質。
- 高 DPI：視窗大小只照字級算，沒有依螢幕 DPI 調邊距。
- 分頁指示（例如「1/3」）。

### 5.3 三個替代方案

| | 1. 修補 PIME 的候選視窗 | 2. 後端自己畫候選視窗 | 3. 自己寫 TSF 輸入法，不用 PIME |
|---|---|---|---|
| 做法 | 在 libIME2 `CandidateWindow` 加顏色、深色模式（`DwmSetWindowAttribute`）、DPI 縮放、圓角；`PIMEClient.cpp` `updateUI` 多認幾個 `customizeUI` 欄位 | 後端行程開一個置頂、不搶焦點（`WS_EX_NOACTIVATE`）的視窗，PIME 的候選視窗不用 | 自己的 TSF DLL（COM：`ITfTextInputProcessorEx`、按鍵、組字、候選 UI、語言列、註冊；x86 與 x64），用管線連到 Rust 引擎，或直接把引擎編進 DLL |
| 能做到的外觀 | 微軟注音大部分的樣子 | 任意 | 任意，含 UI-less 模式 |
| 定位 | DLL 已經用 TSF 拿到準確的組字位置 | **拿不到。** 協定沒有座標；後端在另一個行程，只能猜（`GetGUIThreadInfo` 的 `rcCaret` 只對用 Win32 caret 的程式有效，Chrome、UWP、Office 多半不準） | 用 TSF 拿到準確位置 |
| 風險 | 自己編的 DLL 會被每個程式載入，有錯就讓所有程式當掉；要等上游合併或自己編、自己簽 | 視窗位置不準、和宿主程式的 z-order 打架；PIME 自己的視窗要另外藏起來 | 最大：所有 TSF 細節（UWP 與 AppContainer 權限、密碼框、無障礙、多執行緒、重新註冊）都要自己處理 |
| 工作量（估計） | 中：C++ 約 150–300 行；要 Visual Studio C++ 工具鏈；上游很活躍（2026-10-16～18 每天都有合併），送 PR 有機會進下一版 | 中到高，而且定位問題解不掉 | 很高：數週；Rust 可用 `windows` crate 實作 COM |
| 好處 | 小、其他 PIME 輸入法也受惠、不用另外維護 | 不用改 PIME | 完全掌控，不再受 PIME 的錯誤影響（例如 2026-10-18 那次） |

**建議：選項 1。** 先在 `customizeUI` 加 `candTextColor`、`candBgColor`、`candHighlightColor`、`candDarkMode` 這類欄位，送 PR 給 EasyIME/PIME。舊版 DLL 會忽略不認得的欄位（`updateUI` 只比對已知名稱），所以後端可以先送，不會壞。選項 3 只有在 PIME 的錯誤或限制一直擋路時才值得。

### 5.4 PIME 上游已修的相關錯誤

| 上游修正 | 合併日期 | 內容 | 對我們的影響 |
|---|---|---|---|
| EasyIME/PIME#905「Fix host app crash when PIMELauncher dies (#904)」 | 2026-10-16 | `handleRpcResponse` 先檢查 `msg.is_object()`，RPC 失敗不再丟例外（master `PIMEClient.cpp` 104–108 行） | 就是 2026-10-18 Explorer 連續當機的根因（docs/PIME-NOTES.md §4）。**已包含在 v2.0.0-beta2（10-16）與 beta3（10-17）**，本機裝的是 v2.0.0-beta（10-04） |
| 「increase timeout waiting for backend startup during init and activate」 | 2026-10-16 | `init`、`onActivate` 的逾時從 2 秒放寬到 15 秒，按鍵仍是 2 秒 | 我們的後端啟動很快，影響小 |
| `getPipeName` 回傳 `false` 當 `wstring` | 2026-10-16 | 取不到使用者名稱時存取違規 | 一般情況碰不到 |

仍然存在（master）：`updateMessageWindow` 在檢查 session 之前執行（master 151–160 行），沒有 edit session 的回應帶 `showMessage` 仍會當機。我們的後端與 `debug-pime.ts` 已經擋掉這種回應。
