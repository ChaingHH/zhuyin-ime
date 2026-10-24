# 注音 (zhuyin-native)

Windows 的注音輸入法（大千鍵盤）。用語言模型整句選字；打錯音、ㄣ／ㄥ 等模糊音會自動更正；會學你選過的詞。
測試句的整句正確率約 76%，微軟注音約 51%。

## 安裝

需要：Windows 10 或 11（64 位元）。其他什麼都不用先裝。

1. 到 [Releases](https://github.com/ChaingHH/zhuyin-ime/releases/latest) 下載 **`zhuyin-native-setup.exe`**。
2. 雙擊它。Windows 問「要允許此應用程式變更您的裝置嗎？」時按「是」。
   - 電腦上沒有 PIME（輸入法框架，本輸入法跑在它上面）時，會自動一起裝好。
   - SmartScreen 擋下時，按「其他資訊」→「仍要執行」。
3. 看到「完成」後**登出再登入**。登入後約一分鐘內，「注音 (zhuyin-native)」會自動加進鍵盤清單。

按 **Win＋空白鍵** 切到「注音 (zhuyin-native)」就能打字。

## 使用

| 按鍵 | 作用 |
|---|---|
| 大千鍵位 | 打注音，空白＝一聲。整句打完再選字也可以 |
| Shift（單按） | 切換注音／英文 |
| Enter | 送出 |
| Esc | 取消整段 |
| ← → | 移游標，改前面的字 |
| ↓ | 開選字視窗。↓ ↑ 移動、1–9 或 Enter 選、空白翻頁 |
| → 或 Tab（選字視窗中） | 展開成表格，一次看更多候選 |
| ↑ | 不開視窗，直接換成下一個候選 |

右鍵點工作列的「注／英」圖示：

- **學習資料與使用紀錄**：在瀏覽器裡看學到的詞，不要的可以刪；學習、使用紀錄各有開關，也能一次全部清除。
- **左 Shift／右 Shift 切換中英**：決定單按哪一顆 Shift 會切換。

學習資料存在 `%APPDATA%\PIME\zhuyin\`，只在你的電腦上，不會上傳。

## 更新

下載新版的 `zhuyin-native-setup.exe` 再執行一次。學習資料會保留。通常不用登出。

## 移除

「設定 > 應用程式 > 已安裝的應用程式」裡找「注音 (zhuyin-native) for PIME」→ 解除安裝。

- 如果它說「還在使用中」：登出再登入，再解除安裝一次。
- 移除完會問要不要一起解除安裝 PIME。PIME 上還有別的輸入法（新酷音等）要用的話，選「否」。

## 常見問題

- **登入後清單裡沒有它**：到「設定 > 時間與語言 > 語言與地區 > 中文(台灣) > 語言選項 > 鍵盤」，按「新增鍵盤」，選「注音 (zhuyin-native)」。
- **切過去打不出字**：再登出登入一次。還是不行，把 `%APPDATA%\PIME\zhuyin\backend.log` 附在 [Issues](https://github.com/ChaingHH/zhuyin-ime/issues) 回報。
- 完整的按鍵表、設定檔與疑難排解：[docs/PIME-INSTALL.md](docs/PIME-INSTALL.md)。

## 授權與資料來源

- 程式碼：Apache-2.0。
- 詞庫：
  - [萌典 g0v/moedict-data](https://github.com/g0v/moedict-data)：教育部《重編國語辭典修訂本》，政府資料開放授權條款，散布須標示來源。
  - [libchewing-data](https://github.com/chewing/libchewing-data)：LGPL-2.1-or-later。本專案有修改，安裝目錄的 `THIRD-PARTY-NOTICES.txt` 列出改了什麼。
- 語言模型的訓練語料：Hugging Face `yuhuanstudio/PTT-pretrain-zhtw`、`voidful/fineweb-zhtw`、`wikimedia/wikipedia`（經 OpenCC s2twp 轉繁體）。
- 安裝程式內附 [PIME](https://github.com/EasyIME/PIME) v2.0.0-beta3 官方安裝檔（LGPL），未修改。

## 開發者

使用者版本（Setup.exe）只有 Rust 編出的引擎與資料檔。這個 repo 還有引擎原始碼（`native/`）、資料管線與模型訓練（TypeScript）。

`master` 是開發中的程式碼，可能比最新的 Release 新，也還沒驗證過。要拿使用者版本的原始碼，切到 Release 的 tag（例如 `git checkout v1.0.1`）。舊的 TS 版引擎封存在 tag `archive/ts-engine`。

- 專案全貌、架構、評測：[docs/PROJECT.md](docs/PROJECT.md)
- 指令速查：[CLAUDE.md](CLAUDE.md)
- 從原始碼安裝到 PIME、做 Setup.exe：[docs/PIME-INSTALL.md](docs/PIME-INSTALL.md)
- 版本紀錄：[CHANGELOG.md](CHANGELOG.md)

```bash
npm install
npm run build
npm test
```
