# zhuyin-ime

平台無關的注音輸入法核心。以微軟拼音的能力清單（模糊音、讀音自動糾錯、領域詞庫、使用者學習）為藍本，補齊注音輸入法缺席的 `P(K|S)` 通道模型層與現代化 `P(H)` 語言模型層。

架構文件見專案研究報告：L0 按鍵事件 → L1 鍵盤映射 → L2 槽位組字 → L3 假設展開（運動/認知雙通道）→ L4 詞格 → L5 解碼 → L6 神經重排（選配）→ L7 呈現遲滯，外加 X1 領域先驗 / X2 使用者適應 / X3 遙測三個橫切模組。

## Packages

| Package | 職責 |
|---|---|
| `@zhuyin/core` | L0–L7 + X1–X3 純函式管線，零 IO |
| `@zhuyin/lm` | n-gram 語言模型訓練與 runtime 查詢 |
| `@zhuyin/data-pipeline` | 公開資料源下載→清洗→詞庫/LM/評測集建置 |
| `@zhuyin/rerank` | L6 神經重排（ONNX PLL） |
| `@zhuyin/cli` | 測試台：互動打字、鍵流 replay、批次評測 |

## 開發

```bash
npm install
npm run build
npm test
```

### 資料管線（Phase 0）

```bash
# 詞庫：萌典 + libchewing → data/processed/lexicon.jsonl
npm run data:lexicon

# 語料：PTT 口語域 + 書面域抽樣 → data/processed/corpus/
npm run data:corpus
```

## 授權與資料來源

- 專案程式碼：Apache-2.0
- 詞庫：
  - [萌典 g0v/moedict-data](https://github.com/g0v/moedict-data)：教育部重編國語辭典修訂本，政府資料開放授權條款——散布須標註來源
  - [libchewing-data](https://github.com/chewing/libchewing-data)：LGPL-2.1-or-later，原樣散布並保留授權聲明；任何修改須另行標記
- 語料：Hugging Face `yuhuanstudio/PTT-pretrain-zhtw`、`voidful/fineweb-zhtw`、`wikimedia/wikipedia`（經 OpenCC s2twp 轉繁中）
- 所有衍生資料逐筆記錄 `provenance` 欄位；GPL 授權之模型權重不隨本 repo 散布，由使用者以腳本自行取得
