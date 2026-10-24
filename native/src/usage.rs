//! 使用紀錄（usage.jsonl，每行格式見 engine.rs usage_record）的統計：`zhuyin-native usage` 印出，學習資料頁顯示。
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn summary(text: &str) -> Value {
    let recs: Vec<Value> = text
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let (mut chars, mut keys, mut bs, mut picks, mut right) = (0, 0, 0, 0, 0);
    let mut fixes: HashMap<String, usize> = HashMap::new();
    let mut l3: HashMap<String, usize> = HashMap::new();
    let s = |v: &Value| v.as_str().unwrap_or("").to_string();
    for r in &recs {
        chars += s(&r["out"]).chars().count();
        keys += r["keys"].as_u64().unwrap_or(0);
        bs += r["bs"].as_u64().unwrap_or(0);
        right += (r["top1"] == r["out"]) as usize;
        for p in r["picks"].as_array().into_iter().flatten() {
            picks += 1;
            *fixes.entry(format!("{} → {}", s(&p["from"]), s(&p["to"]))).or_default() += 1;
        }
        for c in r["l3"].as_array().into_iter().flatten() {
            *l3.entry(format!("{} → {}", s(&c[0]), s(&c[1]))).or_default() += 1;
        }
    }
    // 次數多的在前，同次數照字排（輸出穩定）；只留前 20
    let top = |m: HashMap<String, usize>| {
        let mut v: Vec<_> = m.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        v.truncate(20);
        v
    };
    json!({
        "commits": recs.len(),
        "chars": chars,
        "keys": keys,
        "backspaces": bs,
        "right": right,
        "picks": picks,
        "l3": l3.values().sum::<usize>(),
        "topFixes": top(fixes),
        "topL3": top(l3),
    })
}

/// 紀錄 → 評測集格式（第一行中繼資料，之後每句 text＋syllables；音節照實際打的）
pub fn to_eval(text: &str, source: &str) -> String {
    let mut lines = vec![json!({ "source": source }).to_string()];
    for r in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        let syl: Vec<&str> = r["syl"].as_str().unwrap_or("").split(' ').collect();
        lines.push(json!({"text": r["out"], "syllables": syl}).to_string());
    }
    lines.join("\n") + "\n"
}
