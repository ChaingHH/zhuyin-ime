//! 繁轉簡（簡體輸出）：OpenCC ver.1.4.2 的 TSPhrases（詞組）＋ TSCharacters（單字），原樣放在 opencc/（Apache-2.0）。
//! 只轉送給 PIME 的文字（pime.rs handle 的回應）；解碼、X2 學習、使用紀錄都是繁體。
//! 最長匹配：詞組先比，剩下逐字；一個字有幾種簡體時取第一個（同 OpenCC t2s）。

use std::collections::HashMap;
use std::sync::OnceLock;

/// （繁→簡，最長的鍵幾個字）。第一次轉換才建（約 5,500 筆）
fn table() -> &'static (HashMap<&'static str, &'static str>, usize) {
    static T: OnceLock<(HashMap<&'static str, &'static str>, usize)> = OnceLock::new();
    T.get_or_init(|| {
        let mut m = HashMap::new();
        let lines = include_str!("opencc/TSCharacters.txt")
            .lines()
            .chain(include_str!("opencc/TSPhrases.txt").lines());
        for line in lines.filter(|l| !l.starts_with('#')) {
            let Some((k, v)) = line.split_once('\t') else {
                continue;
            };
            let v = v.split(' ').next().unwrap_or(k);
            // 只收 UTF-16 長度不變的：組字區游標（compositionCursor）照轉換前算
            if k.encode_utf16().count() == v.encode_utf16().count() {
                m.insert(k, v);
            }
        }
        let max = m.keys().map(|k| k.chars().count()).max().unwrap_or(1);
        (m, max)
    })
}

pub fn convert(s: &str) -> String {
    let (m, max) = table();
    let at: Vec<usize> = s.char_indices().map(|(i, _)| i).chain([s.len()]).collect();
    let n = at.len() - 1;
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < n {
        let hit = (1..=(*max).min(n - i))
            .rev()
            .find_map(|l| m.get(&s[at[i]..at[i + l]]).map(|v| (l, *v)));
        let (l, v) = hit.unwrap_or((1, &s[at[i]..at[i + 1]]));
        out.push_str(v);
        i += l;
    }
    out
}

#[cfg(test)]
#[test]
fn phrases_first_then_chars() {
    // 逐字
    assert_eq!(convert("頭髮"), "头发");
    assert_eq!(convert("發展"), "发展");
    assert_eq!(convert("我們的軟體"), "我们的软体");
    // 詞組優先：乾 逐字是 干、瞭 逐字不轉
    assert_eq!(convert("乾元"), "乾元");
    assert_eq!(convert("乾杯"), "干杯");
    assert_eq!(convert("我不瞭解"), "我不了解");
    // 英文、標點、表外的字原樣
    assert_eq!(convert("Hi，ㄅ😀"), "Hi，ㄅ😀");
    assert_eq!(convert(""), "");
}
