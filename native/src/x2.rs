//! X2 使用者適應：packages/core/src/x2.ts UserAdapter 的移植。
//! 資料直接存成保留插入順序的 JSON 物件（serde_json preserve_order），
//! 讀寫的 adapter.json 與 TS 逐位元組相同，phrases 的順序（＝加詞順序）也一樣。
use serde_json::{json, Map, Value};
use std::collections::HashSet;

const BOOST_PER_COUNT: f64 = 0.55;
const MAX_SEQ_BOOST: f64 = 2.2;
const GLOBAL_FACTOR: f64 = 0.35;
const MANUAL_PHRASE_BOOST: f64 = 8.0;

/// 交給 Decoder.add_entry 的詞條
pub struct Entry {
    pub word: String,
    pub readings: Vec<Vec<String>>,
}

#[derive(Default)]
pub struct UserAdapter {
    pub enabled: bool,
    /// 讀音（音節以空白相接）→ 詞 → {count, lastAt}
    by_seq: Map<String, Value>,
    global: Map<String, Value>,
    /// 詞 → 詞條（word, readings, provenance, freq?／manual?）
    phrases: Map<String, Value>,
    injected: HashSet<String>,
}

fn bump(m: &mut Map<String, Value>, word: &str, at: f64) {
    let count = m.get(word).map_or(0.0, |r| r["count"].as_f64().unwrap());
    m.insert(
        word.into(),
        json!({ "count": num(count + 1.0), "lastAt": num(at) }),
    );
}

/// 整數存成整數（JSON 才會寫成 3 而不是 3.0，同 JS）
fn num(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9e15 {
        Value::from(x as i64)
    } else {
        Value::from(x)
    }
}

/// 半衰期 14 天的時間衰減
fn recency(last_at: f64, now: f64) -> f64 {
    let days = ((now - last_at) / 86_400_000.0).max(0.0);
    0.5f64.powf(days / 14.0)
}

fn boost(rec: Option<&Value>, cap: f64, now: f64) -> Option<f64> {
    let rec = rec?;
    let count = rec["count"].as_f64()?;
    (count > 0.0).then(|| {
        (BOOST_PER_COUNT * (1.0 + count).ln()).min(cap)
            * recency(rec["lastAt"].as_f64().unwrap(), now)
    })
}

impl UserAdapter {
    pub fn new() -> Self {
        UserAdapter {
            enabled: true,
            ..Default::default()
        }
    }

    pub fn record_selection(&mut self, seq: &[String], word: &str, at: f64) {
        if !self.enabled {
            return;
        }
        let m = self
            .by_seq
            .entry(seq.join(" "))
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .unwrap();
        bump(m, word, at);
        bump(&mut self.global, word, at);
    }

    /// U(w)；seq_key＝上下文音節以空白相接（呼叫端每次解碼算一次）
    pub fn modifier_for(&self, seq_key: &str, word: &str, at: f64) -> f64 {
        if !self.enabled {
            return 0.0;
        }
        if self.phrases.get(word).is_some_and(|p| p["manual"] == true) {
            return MANUAL_PHRASE_BOOST;
        }
        let mut u = 0.0;
        if let Some(b) = boost(
            self.by_seq.get(seq_key).and_then(|m| m.get(word)),
            MAX_SEQ_BOOST,
            at,
        ) {
            u += b;
        }
        // TS：min(...) * globalFactor * decay
        if let Some(g) = self.global.get(word) {
            let count = g["count"].as_f64().unwrap_or(0.0);
            if count > 0.0 {
                u += (BOOST_PER_COUNT * (1.0 + count).ln()).min(MAX_SEQ_BOOST / 2.0)
                    * GLOBAL_FACTOR
                    * recency(g["lastAt"].as_f64().unwrap(), at);
            }
        }
        u
    }

    pub fn set_user_phrase(&mut self, word: &str, reading: &[String]) {
        self.phrases.insert(
            word.into(),
            json!({ "word": word, "readings": [reading], "provenance": ["user"], "manual": true }),
        );
    }

    /// 送出時挖到的新詞：第一次出現就入格，重複出現只累加 freq
    pub fn mine_word(&mut self, word: &str, reading: &[String]) -> bool {
        if let Some(p) = self.phrases.get_mut(word) {
            if p["manual"] != true {
                let f = p["freq"].as_f64().unwrap_or(1.0);
                p["freq"] = num(f + 1.0);
            }
            return false;
        }
        // TS 的 word.length 是 UTF-16 長度
        if word.encode_utf16().count() < 2 {
            return false;
        }
        self.phrases.insert(
            word.into(),
            json!({ "word": word, "readings": [reading], "provenance": ["mined"], "freq": 1 }),
        );
        true
    }

    /// 還沒注入解碼器的詞條
    pub fn drain_pending(&mut self) -> Vec<Entry> {
        let mut out = vec![];
        for (w, p) in &self.phrases {
            if self.injected.insert(w.clone()) {
                let readings = p["readings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| {
                        r.as_array()
                            .unwrap()
                            .iter()
                            .map(|s| s.as_str().unwrap().to_string())
                            .collect()
                    })
                    .collect();
                out.push(Entry {
                    word: p["word"].as_str().unwrap().to_string(),
                    readings,
                });
            }
        }
        out
    }

    pub fn to_json(&self) -> String {
        let phrases: Vec<&Value> = self.phrases.values().collect();
        serde_json::to_string(&json!({
            "bySeq": self.by_seq,
            "global": self.global,
            "phrases": phrases,
        }))
        .unwrap()
    }

    pub fn from_json(s: &str) -> Result<Self, String> {
        let v: Value = serde_json::from_str(s).map_err(|e| e.to_string())?;
        let obj = |k: &str| {
            v.get(k)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default()
        };
        let mut a = UserAdapter::new();
        a.by_seq = obj("bySeq");
        a.global = obj("global");
        for p in v
            .get("phrases")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            a.phrases.insert(
                p["word"].as_str().ok_or("phrase 缺 word")?.into(),
                p.clone(),
            );
        }
        Ok(a)
    }
}
