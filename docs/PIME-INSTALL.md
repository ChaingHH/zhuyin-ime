# 安裝到 PIME：注音 (zhuyin-native)

把本專案的 Rust 引擎裝成 PIME 的一個輸入法。技術細節與量測見 [PIME-NOTES.md](PIME-NOTES.md)。

一般使用者用 Releases 的 `zhuyin-native-setup.exe` 就好（見 [README](../README.md)）。本文件給從原始碼安裝、做 Setup.exe 的人。

## 從原始碼：雙擊 install.cmd

1. 在檔案總管打開 repo 的 `native\pime\`。
2. 雙擊 **`install.cmd`**。
   - 它會先建置執行檔（要有 Rust；一般權限）。
   - 接著 Windows 跳出「使用者帳戶控制」視窗，按「是」。只有安裝這一步用系統管理員權限。
   - 最後視窗顯示結果，按 Enter 關閉。
3. 第一次安裝：**登出再登入，再雙擊一次 `install.cmd`**。第二次會把「注音 (zhuyin-native)」加進鍵盤清單（見「只留『注音 (zhuyin-native)』」）。
   - 第一次不直接加：PIME 的啟動器只在登入時讀 `backends.json`。還沒登出時它不認得 zhuyin，程式一切過來就找不到後端。
   - 也可以登入後自己到「設定 > 時間與語言 > 語言與地區 > 中文(台灣) > 語言選項 > 鍵盤」加入。
4. 更新：通常不用登出，看視窗裡的說明。

同一個資料夾的另外兩個：

| 檔案 | 作用 |
|---|---|
| `uninstall.cmd` | 移除。分兩次：第一次從鍵盤清單拿掉，登出再登入後第二次才真的移除（見「移除」） |
| `rollback.cmd` | 換回上一版（每次更新前會自動備份上一版） |

它們做的事和下面「步驟」一節的指令相同，安全規則也一樣：不停 PIME、被鎖的檔案改名不覆寫、保留上一版。按「否」拒絕權限時，什麼都不會改。

`install.cmd` 會順便把 PIME 升到 GitHub 上最新的一版（含 beta，`install.ps1` 的 `Update-Pime`；`-NoPimeUpdate` 不升級）：

- PIME 沒裝、`x64\` 或 `x86\PIMETextService.dll` 不見、或已裝的比最新版舊時，下載官方安裝檔、驗 GitHub 給的 SHA-256，再 `/S` 靜默安裝。
- 不升級的情況：已裝的是 v2.0.0-beta 或更舊（PIME 的安裝程式會停掉啟動器，舊 DLL 會讓所有程式當掉）；PIME 目錄有排在重開機時刪除的檔案（裝好的檔重開機後會被刪掉，而且 beta4 的安裝程式靜默執行時看到這種排程會**直接重開機**，`installer.nsi` `.onInit`）。後者要先重開機再裝。
- PIME 的安裝程式會重寫 `backends.json`，腳本接著把 zhuyin 加回去。啟動器只在啟動時讀 `backends.json`，所以腳本接著用 `Restart-LauncherWorker` 只結束啟動器的 `/worker` 行程：beta4 起 watchdog 會在 1 秒後重開 worker，新的 worker 重讀設定，不用登出（2026-10-27 實測：新 worker 1 秒後起來，Explorer 沒重開、沒有應用程式錯誤事件，切到注音後 `zhuyin-native` 在新 worker 底下啟動、可以打字）。沒有 worker 行程（舊版結構）或 PIME 早於 beta2 時照舊請你登出再登入。第一次安裝本專案（不升級 PIME）也走同一條路。
- 下載失敗（離線）而 PIME 完整時，照常只裝本專案。

v2.0.0-beta4（2026-10-23）的安裝程式改成先把被鎖的 DLL 改名再排刪除（`macros.nsh` `SafeDeleteFile`），修掉了 2026-10-26「重開機後 DLL 不見」那種情況（[PIME-NOTES.md](PIME-NOTES.md) §4b）。

## 給沒有 repo 的人：Setup.exe

要給別人安裝（對方不需要 repo、Rust）時，做一個 `zhuyin-native-setup.exe`：

1. 安裝 [Inno Setup 6](https://jrsoftware.org/isdl.php)。它的安裝程式能不能不用系統管理員權限、只裝給自己，沒有查證；編譯本身（`ISCC.exe`）不需要系統管理員權限。
2. 雙擊 `native\pime\build-setup.cmd`：建置 → 組出 `native\pime\dist\zhuyin\` → 下載 GitHub 上最新的 PIME 官方安裝檔到 `native\pime\vendor\`（驗 GitHub 給的 SHA-256，不進 git）→ 用 `/DPimeSetup=<檔名>` 編出 `native\pime\dist\zhuyin-native-setup.exe`。沒裝 Inno Setup 時只會組好檔案並說明。
3. 把 `zhuyin-native-setup.exe` 給對方（或上傳到 GitHub Releases）。執行時會要系統管理員權限，結束時跳出結果，之後登出再登入。

Setup.exe 做的事：

- 把內附的 PIME 安裝檔交給 `install.ps1 -PimeSetup`：規則同上面 `install.cmd` 的 PIME 升級（沒裝、DLL 不見、比內附的舊才裝）。
- 第一次安裝（`backends.json` 裡還沒有 zhuyin）：在提權帳號的 HKCU `RunOnce` 寫一筆，登入時跑 `install.ps1 -Keyboard add -WaitReady 120`，等啟動器讀到 zhuyin 後把它加進鍵盤清單。用別的管理員帳號提權時會寫到那個帳號，使用者要自己到「設定」加入。
- 其餘只是把檔案帶過去，再呼叫同一支 `install.ps1 -From`，所以安全規則完全一樣。它在 `C:\ProgramData\zhuyin-native-setup\` 留一份 `install.ps1` 與檔案副本，給「新增或移除程式」裡的解除安裝用。

解除安裝也分兩次，和 `uninstall.cmd` 一樣：

1. 第一次：把它從鍵盤清單拿掉，跳出「還在使用中，請登出再登入，再解除安裝一次」，並中止解除安裝（檔案留著）。
2. 登出再登入後再解除安裝一次，才真的移除。

記錄檔在 `C:\ProgramData\zhuyin-native-uninstall.log`，不會隨解除安裝刪掉。

真的移除之後，會問「也要解除安裝 PIME 嗎？」（預設「否」）。選「是」就開 PIME 自己的 `Uninstall.exe`。PIME 的解除安裝會停掉 PIMELauncher，所以 PIME 版本早於 2.0.0-beta2 時不執行，改請使用者登出再登入後從「設定」移除（見 `install.ps1` 檔頭警告）。

安裝包附 `THIRD-PARTY-NOTICES.txt`（萌典出處、libchewing 的 LGPL 聲明與修改說明）和 `LICENSE-LGPL-2.1.txt`，會裝進 `PIME\zhuyin\`。

沒有用 MSI：MSI 的元件模型和修復、回復機制，不適合「改 PIME 的 `backends.json`、執行 `regsvr32`」這種安裝；WiX 也比較重。

## 會改到什麼

- `C:\Program Files (x86)\PIME\backends.json` 多一筆 `zhuyin` 後端（先備份成 `backends.json.bak`）。
- `C:\Program Files (x86)\PIME\zhuyin\`：執行檔、模型與授權聲明，約 60MB。更新時上一版留在 `zhuyin.prev\`（給 `-Rollback` 用）；`-Rollback` 前的版本留在 `zhuyin.next\`。
- 第一次安裝時註冊 PIME 的 `PIMETextService.dll`（x64、x86 各一次）。更新時發現沒註冊（例如上次註冊失敗）也會補註冊。
- 你的鍵盤清單：`install.cmd` 第二次執行時加入、`uninstall.cmd` 拿掉（見「只留『注音 (zhuyin-native)』」「移除」）。
- 學習資料存在 `%APPDATA%\PIME\zhuyin\adapter.json`。從空的開始，不會沿用網頁測試台的 `data\user\adapter.json`。

> **警告：不要停掉 PIMELauncher.exe**（不要執行 `PIMELauncher.exe /quit`，也不要在工作管理員結束它）。PIME 2.0.0-beta 的 `PIMETextService.dll` 連不上啟動器時，會讓每個載入它的程式當掉；Explorer 會一秒當一次，只能重開機。2026-10-18 的當機就是 3bb05bf 版的安裝腳本這樣做造成的（詳見 [PIME-NOTES.md](PIME-NOTES.md) §4）。現在的腳本不會停 PIME。

> **警告**：`backends.json` 格式錯了，PIME 的**所有**輸入法都會失效。腳本會先備份；萬一出事，把 `backends.json.bak` 改名回 `backends.json` 再重新登入。

## 需要

- 已安裝 PIME 2.0.0-beta（在 `C:\Program Files (x86)\PIME`）。
- Rust 工具鏈（`cargo`）。
- 本專案的 `data\models\lm.bo.bin`、`data\processed\lexicon.bin`、`data\processed\syllables.json`。

## 步驟（手動，等同 install.cmd）

1. 建置執行檔（一般權限）：

   ```powershell
   cd C:\Users\q2927\Desktop\vscode\type\native
   cargo build --release
   ```

2. （可選）先組到暫存目錄檢查內容，不動系統：

   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\Users\q2927\Desktop\vscode\type\native\pime\install.ps1 -Stage $env:TEMP\zhuyin-stage -Data C:\Users\q2927\Desktop\vscode\type\data
   ```

   這是 PowerShell 的寫法。在「命令提示字元」（cmd）裡要把 `$env:TEMP` 換成 `%TEMP%`。反過來，在 PowerShell 裡打 `%TEMP%` 不會展開，會在目前的資料夾建出一個名叫 `%TEMP%` 的資料夾。

3. 開一個**系統管理員**的 PowerShell，安裝：

   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\Users\q2927\Desktop\vscode\type\native\pime\install.ps1 -Data C:\Users\q2927\Desktop\vscode\type\data
   ```

4. 登出再登入，讓 PIME 重新讀 `backends.json`。

5. 加入鍵盤：用一般權限的 PowerShell 執行下面的指令（加入本專案，其他輸入法不動）。或到「設定 > 時間與語言 > 語言與地區 > 中文(台灣) > 語言選項 > 鍵盤 > 新增鍵盤」自己加入「注音 (zhuyin-native)」。

   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\Users\q2927\Desktop\vscode\type\native\pime\install.ps1 -Keyboard add
   ```

6. 用 `Win + 空白鍵` 切到它，開始打字。

## 更新（改過程式之後重新安裝）

再雙擊一次 `install.cmd`。手動的話：

1. 在 `native\` 重新 `cargo build --release`。
2. 系統管理員 PowerShell 再跑一次第 3 步的安裝指令。
3. 看輸出的說明決定要不要登出（PIME v2.0.0-beta2 以上、沒關 `hotUpdate` 時不用）。

- 腳本**不停 PIME**。執行中的後端鎖著 `zhuyin-native.exe` 和映射中的 `lm.bo.bin`，不能覆寫，但可以改名。每個檔案都這樣放：
  1. 先複製成 `*.new`。
  2. 舊檔改名成 `*.old-<時間>`。
  3. 把 `*.new` 改名過去。這一步失敗就把舊檔改回來，所以不會有「沒有執行檔」的時候。
  沒被鎖的舊檔馬上刪，被鎖的下次更新時刪。內容沒變的檔案不動。
- 新模型在下次載入時生效（閒置卸載後、或切回這個輸入法時）。
- 新執行檔：PIME v2.0.0-beta2 以上時，執行檔有變就由腳本結束執行中的 `zhuyin-native`（只結束它，不碰 PIMELauncher），PIMELauncher 約 1 秒後開新版，裝完馬上就能測。組字中的字會清掉；停手不到 30 秒就安裝的話，最後幾句的學習還沒寫檔，會少記。更舊的 PIME 要登出再登入才生效。
- 更新前，腳本把目前的 `PIME\zhuyin\` 整個複製成 `PIME\zhuyin.prev\`。要裝的執行檔和目前裝的相同（例如連裝兩次）時不複製，`zhuyin.prev\` 保持原本的上一版。學習檔和設定檔在 `%APPDATA%`，不受影響。

### 不登出就換新執行檔（`hotUpdate`，要 PIME v2.0.0-beta2 以上）

> **警告：PIME v2.0.0-beta（2026-10-04）不能開。** 那一版的 DLL 遇到後端結束會讓所有宿主程式當掉，Explorer 一秒當一次（[PIME-NOTES.md](PIME-NOTES.md) §1、§4）。先把 PIME 升到 v2.0.0-beta3。沒設定時，後端看到 beta 版會自己關掉這個選項，不要在 `config.json` 強制打開。

PIME 是 v2.0.0-beta2 以上時預設就開（後端讀 PIME 目錄的 `version.txt`；安裝腳本用同樣的規則決定要不要叫你登出），`config.json` 設 `"hotUpdate": false` 可關掉。之後裝了新版，舊後端會在下面兩種時候自己結束：

- 閒置 `idleSecs` 秒、模型卸載之後（預設 5 分鐘沒打字）。
- 最後一個用這個輸入法的程式停用它之後。

結束前會先存好學習檔。打字中、組字到一半都不會結束。PIMELauncher 約 1 秒後開新版的後端。

代價：當時連著這個輸入法的其他程式會斷線。每個程式的下一個按鍵會直接送給程式、不經輸入法（例如打出一個英文字母），之後自動重新連上。

依據（PIME 原始碼，v2.0.0-beta3）：

| 問題 | 結論 | 出處 |
|---|---|---|
| 後端自己結束，啟動器會不會重開 | 會。行程結束當成錯誤，斷開這個後端的所有 client，1 秒後再開一個新的行程。新行程讀的是磁碟上的新執行檔 | `PIMELauncher/src/backend_manager.rs` 的 `spawn_backend_process` 迴圈、`forward_inputs_to_backend` 的 `child_process.wait()` |
| 重開那 1 秒內送來的請求 | 已斷線 client 的請求被丟掉；重新連上的 client 的請求排隊，新後端開好後照送 | 同上，`Discarding stale message from disconnected client` |
| DLL 遇到連線斷掉會不會讓程式當掉 | beta2 以上不會：失敗的請求回傳 false、關掉管線，下一個請求重新連線，並重送 `init` 與 `onActivate` | `PIMETextService/PIMEClient.cpp` 的 `handleRpcResponse`（先檢查 `is_object()`，EasyIME/PIME#905）、`callRpcMethod`、`waitForRpcConnection` |

沒有實機驗證過，因為本機的 PIME 還是 beta 版。已驗證的只有後端這一側（換掉執行檔的修改時間後，卸載完就以結束碼 0 結束；沒開 `hotUpdate` 就不會結束）。

注意（v2.0.0-beta4，已讀原始碼、沒實機驗證）：啟動器重開後端前，會清空那 1 秒內排隊的請求（EasyIME/PIME#943，`backend_manager.rs` 的 `while stdin_rx.try_recv().is_ok() {}`）。beta4 的 DLL 改成在背景連線（`AsyncConnector`），連上之前 `ensureConnected` 回 false，按鍵直接交給程式；連線握手的逾時是 15 秒（`kServerStartupTimeoutMs`）。所以重新連上的程式如果剛好在那 1 秒內送出握手，最壞會有 15 秒按鍵都變成英文，之後自己恢復。只在後端結束時發生（`hotUpdate` 換執行檔、後端當掉），平常閒置卸載不結束行程，不受影響。

### 換回上一版

新版有問題時，雙擊 `rollback.cmd`，或用系統管理員 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\q2927\Desktop\vscode\type\native\pime\install.ps1 -Rollback
```

再登出登入。它做的事：

1. 把目前的 `zhuyin\` 複製成 `zhuyin.next\`。換回之後發現上一版更糟，可以從這裡手動拿回來。
2. 把 `zhuyin.prev\` 的檔案放回 `zhuyin\`。同樣用改名的方式，不停 PIME；內容相同的檔案不動。
3. 刪掉 `zhuyin\` 裡上一版沒有的檔案。被鎖的改名成 `*.old-<時間>`。

## 只留「注音 (zhuyin-native)」（預設）

`install.cmd` 裝完會用一般權限調整**你的鍵盤清單**（`install.ps1 -Keyboard add`）：加入「注音 (zhuyin-native)」，其他輸入法照舊。PIME 的安裝程式會把它所有的輸入法（新酷音等）加進清單，`Update-Pime` 裝完 PIME 會把清單換回裝之前的樣子：原本有的留著，原本沒有的拿掉（2026-10-27 以前是「PIME 的輸入法只留本專案」）。

- 只在 PIME 已經認得 zhuyin 時才改：每個 `PIMELauncher.exe` 都要在 `backends.json` 最後一次修改之後才啟動。第一次安裝時不成立，所以只提示「登出再登入後，再執行一次 install.cmd」。
- 這和在「設定 > 時間與語言 > 語言與地區 > 中文(台灣) > 語言選項 > 鍵盤」裡加入、移除鍵盤是同一件事。要其他輸入法，到那裡加回來。
- 不動 PIME 的 `backends.json`，也不重新註冊 DLL。

警告：**不要從 PIME 拿掉其他後端**（舊版的 `-OnlyZhuyin`，已移除）。2026-10-20 這樣做之後，鍵盤清單裡還留著那些輸入法，Explorer 一呼叫就找不到後端，一秒當一次，直到登出。

舊版 `-OnlyZhuyin` 留下的狀態（PIME 目錄有 `backends.json.full`）：

- `-Uninstall` 會先用它還原其他輸入法，再移除本專案。只還原 PIME 目錄裡資料夾（`workingDir`）還在的輸入法；`-RestoreAll` 也一樣。
- 要單獨還原，用系統管理員 PowerShell 執行下面的指令，跑完**馬上登出再登入**：

  ```powershell
  powershell -ExecutionPolicy Bypass -File C:\Users\q2927\Desktop\vscode\type\native\pime\install.ps1 -RestoreAll
  ```

## 使用

| 狀態 | 按鍵 | 作用 |
|---|---|---|
| 任何時候 | 單按 Shift | 切換注音／英文。組字中按：先送出，再切換。可設成只用左邊或只用右邊的 Shift（見「設定」） |
| 任何時候 | 點工作列的「注／英」圖示 | 切換注音／英文。組字中點不切換（先 Enter 送出或 Esc 取消） |
| 任何時候 | 右鍵點「注／英」圖示 | 選單：「總控台（學習資料、實驗功能）…」用瀏覽器開一個頁面（見「總控台」）：學到的詞每一列可以「刪除」（馬上生效、馬上存檔；刪使用者詞會連同它的選字次數一起刪），也有學習、使用紀錄、打錯自動更正與實驗性功能的開關和「全部清除」。頁面由後端在本機開的小網頁服務提供（只有本機連得到、網址帶隨機密碼；分頁全部關掉幾秒後就停，萬一瀏覽器沒通知，最多 3 分鐘也會停）；開不起來時退回唯讀的 `%APPDATA%\PIME\zhuyin\learned.html`；「左 Shift 切換中英」「右 Shift 切換中英」兩個開關，點一下切換打勾（打勾＝單按那顆 Shift 會切換中英）；「鍵盤排列」子選單選大千、倚天、許氏、IBM、倚天 26 鍵（打勾的是目前的排列，打到一半的注音會丟掉）；「簡體輸出」開關（同 Ctrl+Shift+F） |
| 注音模式 | Shift＋標點鍵 | 打半形符號（Shift+, → `<`、Shift+/ → `?`、Shift+5 → `%`…），組字中插在游標處 |
| 注音模式 | Shift＋字母 | 打英文字母，同英文模式（大小寫照 CapsLock）：組字區空就直接輸出，組字中併進英文。只開 CapsLock 不按 Shift 仍打注音 |
| 注音模式 | Ctrl+Shift+F | 切換繁體／簡體輸出（同微軟注音）。組字中按會馬上換字形。只轉顯示和送出的字，打字和學習仍用繁體。右鍵選單的「簡體輸出」開關效果相同（組字中從選單切換，下一個鍵才換字形） |
| 注音模式 | Ctrl＋標點鍵 | 打全形標點：Ctrl+, → ，、Ctrl+. → 。、Ctrl+/ → ？、Ctrl+; → ：、Ctrl+' → ；、Ctrl+1 → ！、Ctrl+[ → 「、Ctrl+] → 」、Ctrl+Shift+[ → 『、Ctrl+Shift+] → 』、Ctrl+9 → （、Ctrl+0 → ）、Ctrl+\ → 、、Ctrl+` → ～。這些組合在注音模式不會傳給程式（例如 VS Code 的 Ctrl+[ 縮排），切到英文模式就照常 |
| 組字中 | 注音鍵位 | 打注音；空白＝一聲。排列見「設定」的 `layout` |
| 組字中 | ← → Home End | 移游標，改前面的字 |
| 組字中 | ↓ | 開選字視窗：列出從游標那個字開始的詞（長詞在前），最後一項是那個字的注音本身；游標在最後時是最後一個字 |
| 組字中 | ↑ | 不開視窗，直接把游標處的詞換成下一個候選；連按輪換，游標不動 |
| 組字中 | Enter | 送出 |
| 組字中 | Esc | 取消整段 |
| 組字中 | Backspace／Delete | 刪游標前／後一個字（或打到一半的注音） |
| 選字視窗 | ↓ ↑ | 移動反白；跨頁會自動翻頁，頭尾循環 |
| 選字視窗 | 空白、PageDown | 下一頁（反白移到該頁第一個） |
| 選字視窗 | PageUp | 上一頁 |
| 選字視窗 | Enter | 選反白的候選。選完游標跳到這段後面（下一個字或詞的開頭） |
| 選字視窗 | 1–9 | 選本頁第 n 個（表格：反白那一欄的第 n 個） |
| 選字視窗 | → 或 Tab | 展開成表格：直的 9 個、橫的 4 欄，每欄由上往下 1–9 |
| 表格 | ← → | 換到左右那一欄。最右欄再 → 到下一頁，最左欄再 ← 回上一頁 |
| 表格 | ←（第一頁最左欄） | 收回成一欄 |
| 組字中 | 其他 Ctrl／Alt 組合鍵（Ctrl+V…） | 先送出組字，再交給程式 |
| 組字中 | 數字鍵盤的數字與 + − × ÷ . | 照原樣插進組字區 |
| 選字視窗 | Esc、Backspace | 關閉視窗，不改字 |

- 選字視窗的鍵位照微軟官方說明（[Microsoft Traditional Chinese IME](https://support.microsoft.com/help/5001290) 的 Bopomofo 選字視窗）：↓ 進入視窗、↓↑ 移動、空白翻頁、數字選、Enter 選反白。
- 選了清單最後一項（注音本身），那個字就照打的注音送出，不會被學成詞。
- 沒做的微軟注音功能：Shift＋數字的聯想詞、全形英數字。
- PIME 的視窗一次只能畫一頁，顏色固定用系統色；表格最後一欄沒填滿時，空格會畫出「 . 」。
- 打錯音、ㄣ／ㄥ 等模糊音會自動更正（L3，預設開）。

## 記憶體

- 沒在打字時：私有約 2MB。
- 打字中：私有約 13MB，工作集約 65MB。工作集大多是模型的檔案映射頁，Windows 可以隨時收回。
- 閒置 5 分鐘、或切到別的輸入法，就卸載模型。下次打字第一鍵多約 15ms。

## 設定

設定檔在 `%APPDATA%\PIME\zhuyin\config.json`（沒有就用預設）。每次切到這個輸入法時重讀，改完不用重開。右鍵選單的 Shift 開關、鍵盤排列與簡體輸出開關、學習資料頁的兩個開關也是寫進這個檔。

```json
{
  "shiftToggle": "right",
  "layout": "dachen",
  "idleSecs": 300,
  "l3": true,
  "candFontName": "Microsoft JhengHei UI",
  "candFontSize": 14
}
```

| 項目 | 預設 | 作用 |
|---|---|---|
| `shiftToggle` | `"both"` | 哪一邊的 Shift 單按會切換中英：`"both"` 兩邊、`"left"` 只有左邊、`"right"` 只有右邊、`"none"` 都不切換（用左鍵點圖示切換）。關掉的那邊單按不做事；其他值當 `"both"` |
| `layout` | `"dachen"` | 鍵盤排列：`"dachen"` 大千、`"eten"` 倚天（41 鍵）、`"hsu"` 許氏、`"ibm"` IBM、`"eten26"` 倚天 26 鍵。鍵位照新酷音（libchewing）。許氏、倚天 26 鍵一鍵多音：同一個音節裡依前面打的符號判斷（例如許氏的 J 開頭是 ㄐ，後面接 ㄨ 或韻母就換成 ㄓ；已有符號時 S D F J 是聲調鍵），規則同新酷音，所以 ㄟ、ㄝˋ 這類單韻母音節有幾個打不出來。右鍵選單「鍵盤排列」切換；沒寫或其他值當大千 |
| `learning` | `true` | `false`：關掉學習。不學新的，已學到的也暫停使用（資料保留）。學習資料頁的「學習」開關切換 |
| `usageLog` | `false` | `true`：記錄使用情形。學習資料頁的「使用紀錄」開關切換 |
| `simplified` | `false` | `true`：簡體輸出（組字區、候選、送出的字轉成簡體；轉換表是 OpenCC 的 TSPhrases＋TSCharacters，詞組優先）。學習資料與使用紀錄仍存繁體。Ctrl+Shift+F 或右鍵選單「簡體輸出」切換 |
| `idleSecs` | 300 | 閒置幾秒卸載模型 |
| `l3` | `true` | `false` 關閉打錯／模糊音更正。總控台的「打錯自動更正」切換 |
| `refine` | `true` | 實驗：打錯成另一個字（魔跳出東西）時，解碼後看前後文換回來。總控台切換 |
| `menuPromote` | `false` | 實驗：選字視窗把最可能的更正字排到第二個。總控台切換 |
| `typoLearning` | `false` | 實驗：學你的打錯習慣（從選字視窗選了更正讀音的字就記一次），存在 `typos.json`。總控台切換 |
| `candFontName` | `"Microsoft JhengHei UI"` | 選字視窗的字型（1–31 字元的字型名） |
| `candFontSize` | `14` | 選字視窗的字級（點數，6–72） |
| `hotUpdate` | 看 PIME 版本 | `true`：裝了新的執行檔後，不用登出。舊後端在閒置卸載後自己結束，PIMELauncher 會開新版。沒設定時，後端讀 PIME 目錄的 `version.txt`：v2.0.0-beta2 以上就開，v2.0.0-beta 或讀不到就關。見「不登出就換新執行檔」 |

學習檔在同一個目錄的 `adapter.json`。1.0.1 以前的 `halfWidth` 設定已拿掉：注音模式的 Shift 組合一律打半形，全形改用 Ctrl 組合。

## 總控台

右鍵點「注／英」圖示 →「總控台（學習資料、實驗功能）…」，在瀏覽器裡管理學習資料、使用紀錄，也可以開關打錯自動更正與實驗性功能（改了馬上生效）。資料都只存在這台電腦，不會上傳。

| | 學習資料 | 使用紀錄 |
|---|---|---|
| 做什麼 | 記住選過的字詞、常打的詞，之後優先出現 | 記下每次送出的經過，用來找出打字時錯在哪裡；不影響選字 |
| 預設 | 開 | 關 |
| 關掉時 | 不學新的，已學到的也暫停使用；資料保留，打開就恢復 | 不再記錄；已有的紀錄還在 |
| 檔案 | `%APPDATA%\PIME\zhuyin\adapter.json` | `%APPDATA%\PIME\zhuyin\usage.jsonl` |
| 刪除 | 每一列的「刪除」 | 「刪除使用紀錄」 |

「全部清除」一次刪掉學習資料、使用紀錄和學到的打錯習慣（連同唯讀快照 `learned.html`），刪了不能復原。

使用紀錄的細節：

- 打開後，每次送出在 `%APPDATA%\PIME\zhuyin\usage.jsonl` 加一行：時間、打出的注音、輸入法原本猜的字、最後送出的字、用 ↓ 改過的段落、自動更正（L3）改掉的注音、按鍵數、退格次數。
- 紀錄裡有你打過的所有文字，只存在這台電腦，不會上傳。超過 10MB 時丟掉舊的一半。
- 看統計（要 repo）：`native\target\release\zhuyin-native.exe usage %APPDATA%\PIME\zhuyin\usage.jsonl`，印出不用改就對的比例、每 100 字改幾次、最常改的字、L3 更正。
- 看不到的：送出之後才在程式裡刪掉重打的錯字。

開發用的環境變數（後端不一定收得到 PIMELauncher 的環境變數，平常用設定檔）：`ZHUYIN_ADAPTER`（學習檔路徑或 `off`）、`ZHUYIN_CONFIG`（設定檔路徑或 `off`）、`ZHUYIN_IDLE_SECS`、`ZHUYIN_L3`。設定檔裡有的項目會蓋過環境變數。

## 疑難排解

- 後端的記錄檔：`%APPDATA%\PIME\zhuyin\backend.log`（超過 1MB 改名成 `backend.log.old`）。每次啟動、結束（含原因）、載入／卸載模型、出錯（panic）都會記一行，有時間。打字當掉或字突然不見時，先看這個檔最後幾行。環境變數 `ZHUYIN_LOG`＝路徑或 `off`。
- 記錄檔裡連續出現「啟動」、中間沒有「結束」：後端是被 PIMELauncher 殺掉的。它在某則請求 15 秒沒回應時會這樣做。
- 不重裝、只想重開後端：先停手 30 秒（讓學習檔寫完），再執行 `Stop-Process -Name zhuyin-native`，PIMELauncher 約 1 秒後會開新的。`install.cmd` 換了執行檔時會自己這樣做。**只能結束 `zhuyin-native`，不要結束 PIMELauncher。**

- PIME 2.0 的啟動器平常**不寫 log**（背景模式把 log 丟掉），`%LOCALAPPDATA%\PIME\Log\PIMELauncher.log` 會是空的。
- `PIMELauncher.exe /console` 可以顯示 log，但要先停掉正在跑的啟動器，那會讓所有程式當掉（見上面的警告）。**不要用。**要查後端的行為，在 repo 裡用 `debug-pime.ts` 直接驅動後端（不經 PIME）。
- 程式當掉時看「事件檢視器 > Windows 記錄 > 應用程式」的事件 1000：
  - 錯誤模組是 `PIMETextService.dll`、例外 `0xc0000005`：DLL 解參考空指標（例如沒有 edit session 的回應帶 `showMessage`）。
  - 錯誤模組是 `ucrtbase.dll`、例外 `0xc0000409`，而且是 Explorer 一秒當一次：DLL 連不上 PIMELauncher（啟動器被停掉或掛了）。重開機即可恢復。
- 2026-10-18 的 Explorer 連續當機：3bb05bf 版的安裝腳本在安裝前執行 `PIMELauncher.exe /quit`，啟動器停著的那段時間，Explorer 一碰到輸入法就當掉。現在的腳本不再停 PIME。
- 2026-10-17 修掉的閃退：點工作列的「注／英」圖示會讓正在打字的程式當掉。原因是 PIME 的 DLL 處理圖示點擊（`onCommand`）時沒有 edit session，回應裡卻有 `showMessage`，DLL 拿空指標去開組字。現在點圖示只回 `changeButton`。

## 移除

> **警告**：PIME 執行中改 `backends.json`、重新註冊 DLL，會讓 Explorer 連續當機（2026-10-20）。所以移除分兩次，第一次只改鍵盤清單。

1. 雙擊 `uninstall.cmd`。它用一般權限把「注音 (zhuyin-native)」從你的鍵盤清單拿掉，然後請你登出。這次不改 PIME。
2. **登出再登入。**
3. 再雙擊一次 `uninstall.cmd`。這次 zhuyin 不在任何鍵盤清單、後端也沒在跑，才會要系統管理員權限：改 `backends.json`、重新註冊 DLL、刪掉 `zhuyin\`、`zhuyin.prev\`、`zhuyin.next\`。

手動的話，第 3 步用系統管理員 PowerShell（會順便還原舊版藏起來的 PIME 輸入法）：

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\q2927\Desktop\vscode\type\native\pime\install.ps1 -Uninstall
```

- `-Uninstall` 自己也會檢查。zhuyin 還在任何已登入使用者的鍵盤清單裡、或後端還在跑時，什麼都不改（結束碼 2）：只把它從目前使用者的清單拿掉，請你登出後再跑一次。
- 刪資料夾是整個一起：裡面有任何檔案被用著就整個保留，不會只刪掉一半。
- 學習檔與設定檔 `%APPDATA%\PIME\zhuyin\` 不會被刪，要的話手動刪。

## 授權

`lexicon.bin` 來自萌典（需標示出處）與 libchewing（LGPL-2.1）。安裝包與 `PIME\zhuyin\` 都附上 `native\pime\THIRD-PARTY-NOTICES.txt`（出處、授權、libchewing 資料的修改說明）與 `LICENSE-LGPL-2.1.txt`（見 `CLAUDE.md`「Data licensing constraints」）。換了資料來源或授權時，要一起改這個檔。
