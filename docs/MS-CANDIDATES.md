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
| 視窗開著時 ← → | → 和 Tab 把清單展開成多欄表格，← 收回成一欄。**不是**改變選字範圍 | 已做（`pime.rs`，見第 3 節） |
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
| 表格展開（→／Tab）、收回（←） | 能，有限制 | 改 `candPerRow`：展開成每列 3 個（一頁 9 個 → 3×3），收回成 1。視窗關掉後再開，回到一欄 |
| 顏色、圓角、陰影、分頁指示 | **不能** | 顏色寫死為系統色 `COLOR_WINDOWTEXT`／`COLOR_WINDOW`，邊框是 3D 邊框（`CandidateWindow.cpp:200–216`），協定沒有對應欄位 |
| 表格一次顯示多頁 | **不能** | DLL 的候選數不能超過選字鍵數（`PIMETextService.cpp:273` 的 assert），一頁最多 9 個，表格只是同一頁換成多欄 |
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
