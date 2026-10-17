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

4. 登出再登入，讓 PIME 重新讀設定。或者結束 `PIMELauncher.exe`，再用**一般權限**重新啟動它。

5. 到「設定 > 時間與語言 > 語言與地區 > 中文(台灣) > 語言選項 > 鍵盤 > 新增鍵盤」，加入「注音 (zhuyin-native)」。

6. 用 `Win + 空白鍵` 切到它，開始打字。

## 使用

- 鍵位：大千。
- 單按 Shift：切換注音／英文。
- ↓：開選字視窗，數字鍵選字。←→：移游標改前面的字。
- Enter：送出。Esc：取消整段。
- 打錯音、ㄣ／ㄥ 等模糊音會自動更正（L3，預設開）。

## 記憶體

- 沒在打字時：私有約 2MB。
- 打字中：私有約 13MB，工作集約 65MB。工作集大多是模型的檔案映射頁，Windows 可以隨時收回。
- 閒置 5 分鐘、或切到別的輸入法，就卸載模型。下次打字第一鍵多約 15ms。

## 調整（可選）

後端行程應該沿用 `PIMELauncher.exe` 的環境變數（推論，沒查證）。要改時，設成使用者環境變數，再重新登入；生效與否可在工作管理員看 `zhuyin-native.exe` 的記憶體何時降下來：

| 變數 | 預設 | 作用 |
|---|---|---|
| `ZHUYIN_IDLE_SECS` | 300 | 閒置幾秒卸載模型 |
| `ZHUYIN_L3` | 開 | `0` 關閉打錯／模糊音更正 |
| `ZHUYIN_ADAPTER` | `%APPDATA%\PIME\zhuyin\adapter.json` | 學習檔路徑；`off` 不學習 |

## 移除

系統管理員 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\q2927\Desktop\vscode\type\native\pime\install.ps1 -Uninstall
```

再登出登入。學習檔 `%APPDATA%\PIME\zhuyin\` 不會被刪，要的話手動刪。

## 授權

`lexicon.bin` 來自萌典（需標示出處）與 libchewing（LGPL-2.1）。只在自己電腦安裝不算散布；要給別人安裝包時，附上授權與出處（見 `CLAUDE.md`「Data licensing constraints」）。
