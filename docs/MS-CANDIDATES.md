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

## 2. 官方文件沒寫的（未確認）

- ↓ 開的是哪一段（游標前的字、游標後的字、還是整個詞）。
- 視窗開著時 ← 的作用，以及 ←／→ 能不能擴大或縮小選字範圍。A 只說 → 是「展開成表格」，和使用者預期的「→ 擴大範圍」衝突，要實測。
- 選字後游標停在哪裡。
- PageUp／PageDown。
- 視窗外 Home、End、Backspace、Delete 的行為。

要確認這些只能實測微軟注音。`debug-ms-bopomofo.ps1` 會佔用鍵盤，使用者不在電腦前才能跑。另一種做法是請使用者手動按，記錄每一步畫面上的結果。

## 3. PIME 的候選視窗能調什麼

依據：PIME `v2.0.0-beta` 的 `PIMETextService/PIMEClient.cpp`（`updateUI`、`updateSelectionKeys`、`updateCandidateList`），以及 libIME2 `717b190` 的 `src/CandidateWindow.cpp`。

| 項目 | 能否控制 | 怎麼做 |
|---|---|---|
| 直排 | 能 | `customizeUI.candPerRow = 1`（目前已設） |
| 編號 | 能 | `setSelKeys`：每列畫成「1. 候選」（`CandidateWindow.cpp:256` 的 `L"?. "`） |
| 反白 | 能 | `customizeUI.candUseCursor = true`，加上 `candidateCursor`（目前已送） |
| 字型、字級 | 能 | `customizeUI.candFontName`（string）、`candFontSize`（int） |
| 顏色、圓角、陰影、分頁指示 | **不能** | 顏色寫死為系統色 `COLOR_WINDOWTEXT`／`COLOR_WINDOW`，邊框是 3D 邊框（`CandidateWindow.cpp:200–216`），協定沒有對應欄位 |
| 表格展開（Tab／→） | **不能用 PIME 原生視窗做** | 只能把每列欄數 `candPerRow` 改大來模擬 |
| 注音讀音放在清單最後一項 | 能 | 在 `candidateList` 最後加上讀音字串（引擎的工作，見第 4 節） |

## 4. 還沒做的

- `pime.rs` 的外觀調整：設 `candFontName`、`candFontSize`，並把這兩個欄位加進 `debug-pime.ts` 的格式檢查（型別已經在檢查）。
- 引擎行為：選字範圍、選字後游標、清單最後一項放讀音、視窗外 ↑ 直接換字。這些都在 `ImeEngine`（`packages/cli/src/engine.ts`、`native/src/engine.rs`）。依指示要等 lexicon-english 分支併進 master 之後再改，並用 `debug-native-parity.ts` 對拍。
- 第 2 節的未確認項目要先實測。
