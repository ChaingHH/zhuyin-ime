# 安裝到 PIME：注音 (zhuyin-native)

把本專案的 Rust 引擎裝成 PIME 的一個輸入法。技術細節與量測見 `docs/MEMORY.md` §6。

## 會改到什麼

- `C:\Program Files (x86)\PIME\backends.json` 多一筆 `zhuyin` 後端（先備份成 `backends.json.bak`）。
- `C:\Program Files (x86)\PIME\zhuyin\`：執行檔與模型，約 60MB。
- 重新註冊 PIME 的 `PIMETextService.dll`（x64、x86 各一次）。
- 學習資料存在 `%APPDATA%\PIME\zhuyin\adapter.json`。從空的開始，不會沿用網頁測試台的 `data\user\adapter.json`。

> **警告**：`backends.json` 格式錯了，PIME 的**所有**輸入法都會失效。腳本會先備份；萬一出事，把 `backends.json.bak` 改名回 `backends.json` 再重新登入。

## 需要

- 已安裝 PIME 2.0.0-beta（在 `C:\Program Files (x86)\PIME`）。
- Rust 工具鏈（`cargo`）。
- 本專案的 `data\models\lm.bo.bin`、`data\processed\lexicon.bin`、`data\processed\syllables.json`。

## 步驟

1. 建置執行檔（一般權限）：

   ```powershell
   cd C:\Users\q2927\Desktop\vscode\type\native
   cargo build --release
   ```

2. （可選）先組到暫存目錄檢查內容，不動系統：

   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\Users\q2927\Desktop\vscode\type\native\pime\install.ps1 -Stage $env:TEMP\zhuyin-stage -Data C:\Users\q2927\Desktop\vscode\type\data
   ```

3. 開一個**系統管理員**的 PowerShell，安裝：

   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\Users\q2927\Desktop\vscode\type\native\pime\install.ps1 -Data C:\Users\q2927\Desktop\vscode\type\data
   ```

4. 登出再登入，讓 PIME 重新讀設定。或者在**一般權限**的 PowerShell 執行 `& 'C:\Program Files (x86)\PIME\PIMELauncher.exe'` 重新啟動它（安裝腳本已經先用 `PIMELauncher.exe /quit` 把它停掉）。

5. 到「設定 > 時間與語言 > 語言與地區 > 中文(台灣) > 語言選項 > 鍵盤 > 新增鍵盤」，加入「注音 (zhuyin-native)」。

6. 用 `Win + 空白鍵` 切到它，開始打字。

## 更新（改過程式之後重新安裝）

1. 在 `native\` 重新 `cargo build --release`。
2. 系統管理員 PowerShell 再跑一次第 3 步的安裝指令。

腳本會先執行 `PIMELauncher.exe /quit` 停掉 PIME：執行中的後端鎖著 `zhuyin-native.exe` 和模型檔，不停掉就複製不進去；只殺後端的話，PIME 1 秒後會再把它開起來。所以更新期間所有 PIME 輸入法都會暫停，裝完要做第 4 步重新啟動 PIME。學習檔和設定檔不受影響。

## 只留「注音 (zhuyin-native)」

要讓 Windows 只列出本專案、不再列出新酷音、小麥注音等 PIME 內建輸入法時，用系統管理員 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\q2927\Desktop\vscode\type\native\pime\install.ps1 -OnlyZhuyin
```

- 第一次執行會把完整的 `backends.json` 備份成 `backends.json.full`，再把 `backends.json` 縮成只有 `zhuyin` 一筆，並重新註冊 PIME 的 DLL（先取消註冊全部，再註冊剩下的）。
- 內建輸入法的檔案都還在，只是不再註冊。
- 還原全部：

  ```powershell
  powershell -ExecutionPolicy Bypass -File C:\Users\q2927\Desktop\vscode\type\native\pime\install.ps1 -RestoreAll
  ```

- 兩者都要重新登入（或重開 `PIMELauncher.exe`）才生效。
- 在 `-OnlyZhuyin` 狀態下 `-Uninstall` 會拒絕執行，要先 `-RestoreAll`，否則 PIME 會一個輸入法都不剩。

## 使用

| 狀態 | 按鍵 | 作用 |
|---|---|---|
| 任何時候 | 單按 Shift | 切換注音／英文。組字中按：先送出，再切換。可設成只用左 Shift（見「設定」） |
| 任何時候 | 點工作列的「注／英」圖示 | 切換注音／英文。組字中點不切換（先 Enter 送出或 Esc 取消） |
| 任何時候 | 右鍵點「注／英」圖示 | 選單：切換中／英、只用左 Shift 切換中英（打勾＝開） |
| 組字中 | 大千鍵位 | 打注音；空白＝一聲 |
| 組字中 | ← → Home End | 移游標，改前面的字 |
| 組字中 | ↓ | 開選字視窗：列出從游標那個字開始的詞（長詞在前）；游標在最後時是最後一個字 |
| 組字中 | Enter | 送出 |
| 組字中 | Esc | 取消整段 |
| 組字中 | Backspace／Delete | 刪游標前／後一個字（或打到一半的注音） |
| 選字視窗 | ↓ ↑ | 移動反白；跨頁會自動翻頁，頭尾循環 |
| 選字視窗 | 空白、PageDown | 下一頁（反白移到該頁第一個） |
| 選字視窗 | PageUp | 上一頁 |
| 選字視窗 | Enter | 選反白的候選 |
| 選字視窗 | 1–9 | 選本頁第 n 個 |
| 選字視窗 | Esc、Backspace | 關閉視窗，不改字 |

- 選字視窗的鍵位照微軟官方說明（[Microsoft Traditional Chinese IME](https://support.microsoft.com/help/5001290) 的 Bopomofo 選字視窗）：↓ 進入視窗、↓↑ 移動、空白翻頁、數字選、Enter 選反白。
- 沒做的微軟注音功能：Tab／→ 展開成表格、↑ 不開視窗直接換字、Shift＋數字的聯想詞、全形／半形。
- 打錯音、ㄣ／ㄥ 等模糊音會自動更正（L3，預設開）。

## 記憶體

- 沒在打字時：私有約 2MB。
- 打字中：私有約 13MB，工作集約 65MB。工作集大多是模型的檔案映射頁，Windows 可以隨時收回。
- 閒置 5 分鐘、或切到別的輸入法，就卸載模型。下次打字第一鍵多約 15ms。

## 設定

設定檔在 `%APPDATA%\PIME\zhuyin\config.json`（沒有就用預設）。每次切到這個輸入法時重讀，改完不用重開。右鍵選單的「只用左 Shift 切換中英」也是寫進這個檔。

```json
{
  "shiftToggle": "left",
  "idleSecs": 300,
  "l3": true
}
```

| 項目 | 預設 | 作用 |
|---|---|---|
| `shiftToggle` | `"both"` | `"left"`：只有左 Shift 單按會切換中英，右 Shift 單按不做事 |
| `idleSecs` | 300 | 閒置幾秒卸載模型 |
| `l3` | `true` | `false` 關閉打錯／模糊音更正（下次載入模型時生效） |

學習檔在同一個目錄的 `adapter.json`。

開發用的環境變數（後端不一定收得到 PIMELauncher 的環境變數，平常用設定檔）：`ZHUYIN_ADAPTER`（學習檔路徑或 `off`）、`ZHUYIN_CONFIG`（設定檔路徑或 `off`）、`ZHUYIN_IDLE_SECS`、`ZHUYIN_L3`。設定檔裡有的項目會蓋過環境變數。

## 疑難排解

- PIME 2.0 的啟動器平常**不寫 log**（背景模式把 log 丟掉），`%LOCALAPPDATA%\PIME\Log\PIMELauncher.log` 會是空的。
- 要看 log：一般權限 PowerShell 先執行 `& 'C:\Program Files (x86)\PIME\PIMELauncher.exe' /quit`，再執行 `& 'C:\Program Files (x86)\PIME\PIMELauncher.exe' /console`。會開一個主控台視窗，顯示啟動器的 log；後端寫到 stderr 的訊息（`[pime] 載入引擎` 等）顯示為 `[zhuyin stderr] …`。看完關掉視窗後，再不加參數執行一次 `PIMELauncher.exe`。
- 2026-10-17 修掉的閃退：點工作列的「注／英」圖示會讓正在打字的程式當掉。原因是 PIME 的 DLL 處理圖示點擊（`onCommand`）時沒有 edit session，回應裡卻有 `showMessage`，DLL 拿空指標去開組字。現在點圖示只回 `changeButton`。

## 移除

系統管理員 PowerShell（用過 `-OnlyZhuyin` 的話先 `-RestoreAll`）：

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\q2927\Desktop\vscode\type\native\pime\install.ps1 -Uninstall
```

再登出登入。學習檔與設定檔 `%APPDATA%\PIME\zhuyin\` 不會被刪，要的話手動刪。

## 授權

`lexicon.bin` 來自萌典（需標示出處）與 libchewing（LGPL-2.1）。只在自己電腦安裝不算散布；要給別人安裝包時，附上授權與出處（見 `CLAUDE.md`「Data licensing constraints」）。
