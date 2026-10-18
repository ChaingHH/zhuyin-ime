//! X2 使用者適應：packages/core/src/x2.ts UserAdapter 的移植。
//! 資料存成保留插入順序的 IndexMap（JS Map／物件的順序），讀寫的 adapter.json 與 TS 逐位元組相同，
//! phrases 的順序（＝加詞順序）也一樣。上限與整理（compact）照 TS 的 X2_LIMITS；刪除用 shift_remove，
//! 保持其他項目的順序。
//! 不用 serde_json::Value 存：每筆 {count, lastAt} 要約 350 bytes，1.9MB 的學習檔佔 35MB。
//! 讀檔時不認得的欄位會丟掉（TS 會留著）；TS 自己寫的檔沒有這種欄位。
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::HashSet;

const BOOST_PER_COUNT: f64 = 0.55;
const MAX_SEQ_BOOST: f64 = 2.2;
const GLOBAL_FACTOR: f64 = 0.35;
const MANUAL_PHRASE_BOOST: f64 = 8.0;

/// 學習資料的上限，同 TS 的 X2_LIMITS（說明見那裡與 docs/MEMORY.md「X2 學習資料的成長」）
const MAX_SEQ: usize = 10_000;
const MAX_GLOBAL: usize = 10_000;
const MAX_MINED: usize = 5_000;
const MAX_MANUAL: usize = 20_000;
const DROP_BELOW: f64 = 0.025;
const COMPACT_EVERY: usize = 2_000;

/// 交給 Decoder.add_entry 的詞條
pub struct Entry {
    pub word: String,
    pub readings: Vec<Vec<String>>,
}

#[derive(Clone, Copy)]
struct Rec {
    count: f64,
    last_at: f64,
}

/// 使用者詞條（詞是 phrases 的鍵）。JSON 欄位順序固定：word, readings, provenance, manual?, freq?, lastAt?
struct Phrase {
    readings: Vec<Vec<String>>,
    provenance: Vec<String>,
    manual: Option<bool>,
    freq: Option<f64>,
    last_at: Option<f64>,
}

impl Phrase {
    fn is_manual(&self) -> bool {
        self.manual == Some(true)
    }
}

#[derive(Default)]
pub struct UserAdapter {
    pub enabled: bool,
    /// 讀音（音節以空白相接）→ 詞 → 記錄
    by_seq: IndexMap<String, IndexMap<String, Rec>>,
    global: IndexMap<String, Rec>,
    phrases: IndexMap<String, Phrase>,
    injected: HashSet<String>,
    /// 最近一次看到的時間（record_selection／載入）；造詞、挖詞用它
    now: f64,
    /// 上次整理後新增的項目數
    added: usize,
}

/// 要刪的項目：衰減到 drop 以下的全部，再從剩下最弱的刪到 cap 個（同分刪前面的）
fn weakest<T>(items: Vec<(T, f64)>, cap: usize, drop: f64) -> Vec<T> {
    let (mut out, mut keep): (Vec<_>, Vec<_>) = items.into_iter().partition(|x| x.1 < drop);
    if keep.len() > cap {
        keep.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        let n = keep.len() - cap;
        out.extend(keep.into_iter().take(n));
    }
    out.into_iter().map(|x| x.0).collect()
}

fn decayed(count: f64, last_at: f64, now: f64) -> f64 {
    count * recency(last_at, now)
}

fn bump(m: &mut IndexMap<String, Rec>, word: &str, at: f64) {
    let count = m.get(word).map_or(0.0, |r| r.count);
    m.insert(
        word.into(),
        Rec {
            count: count + 1.0,
            last_at: at,
        },
    );
}

/// 半衰期 14 天的時間衰減
fn recency(last_at: f64, now: f64) -> f64 {
    let days = ((now - last_at) / 86_400_000.0).max(0.0);
    0.5f64.powf(days / 14.0)
}

/// 數字照 JSON.stringify：整數寫成整數
fn num(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 9e15 {
        (x as i64).to_string()
    } else {
        serde_json::to_string(&x).unwrap()
    }
}

fn js(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str().map(String::from))
        .collect()
}

fn rec(v: &Value) -> Rec {
    Rec {
        count: v["count"].as_f64().unwrap_or(0.0),
        last_at: v["lastAt"].as_f64().unwrap_or(0.0),
    }
}

fn recs(v: Option<&Value>) -> IndexMap<String, Rec> {
    v.and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(k, r)| (k.clone(), rec(r)))
        .collect()
}

fn write_recs(out: &mut String, m: &IndexMap<String, Rec>) {
    out.push('{');
    for (i, (k, r)) in m.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            "{}:{{\"count\":{},\"lastAt\":{}}}",
            js(k),
            num(r.count),
            num(r.last_at)
        ));
    }
    out.push('}');
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
        self.now = at;
        let m = self.by_seq.entry(seq.join(" ")).or_default();
        self.added += !m.contains_key(word) as usize + !self.global.contains_key(word) as usize;
        bump(m, word, at);
        bump(&mut self.global, word, at);
        self.maybe_compact();
    }

    /// U(w)；seq_key＝上下文音節以空白相接（呼叫端每次解碼算一次）
    pub fn modifier_for(&self, seq_key: &str, word: &str, at: f64) -> f64 {
        if !self.enabled {
            return 0.0;
        }
        if self.phrases.get(word).is_some_and(Phrase::is_manual) {
            return MANUAL_PHRASE_BOOST;
        }
        let mut u = 0.0;
        if let Some(r) = self.by_seq.get(seq_key).and_then(|m| m.get(word)) {
            if r.count > 0.0 {
                u += (BOOST_PER_COUNT * (1.0 + r.count).ln()).min(MAX_SEQ_BOOST)
                    * recency(r.last_at, at);
            }
        }
        // TS：min(...) * globalFactor * decay
        if let Some(g) = self.global.get(word) {
            if g.count > 0.0 {
                u += (BOOST_PER_COUNT * (1.0 + g.count).ln()).min(MAX_SEQ_BOOST / 2.0)
                    * GLOBAL_FACTOR
                    * recency(g.last_at, at);
            }
        }
        u
    }

    pub fn set_user_phrase(&mut self, word: &str, reading: &[String]) {
        self.added += !self.phrases.contains_key(word) as usize;
        self.phrases.insert(
            word.into(),
            Phrase {
                readings: vec![reading.to_vec()],
                provenance: vec!["user".into()],
                manual: Some(true),
                freq: None,
                last_at: Some(self.now),
            },
        );
        self.maybe_compact();
    }

    /// 送出時挖到的新詞：第一次出現就入格，重複出現只累加 freq
    pub fn mine_word(&mut self, word: &str, reading: &[String]) -> bool {
        if let Some(p) = self.phrases.get_mut(word) {
            if !p.is_manual() {
                p.freq = Some(p.freq.unwrap_or(1.0) + 1.0);
                p.last_at = Some(self.now);
            }
            return false;
        }
        // TS 的 word.length 是 UTF-16 長度
        if word.encode_utf16().count() < 2 {
            return false;
        }
        self.phrases.insert(
            word.into(),
            Phrase {
                readings: vec![reading.to_vec()],
                provenance: vec!["mined".into()],
                manual: None,
                freq: Some(1.0),
                last_at: Some(self.now),
            },
        );
        self.added += 1;
        self.maybe_compact();
        true
    }

    fn maybe_compact(&mut self) {
        if self.added >= COMPACT_EVERY {
            self.compact(self.now);
        }
    }

    /// 整理：刪掉衰減完的記錄與挖詞，超過上限的從最弱的刪。已注入解碼器的詞留到下次載入
    pub fn compact(&mut self, at: f64) {
        self.added = 0;
        let w = |r: &Rec| decayed(r.count, r.last_at, at);
        let pairs: Vec<((String, String), f64)> = self
            .by_seq
            .iter()
            .flat_map(|(k, m)| {
                m.iter()
                    .map(move |(word, r)| ((k.clone(), word.clone()), w(r)))
            })
            .collect();
        for (k, word) in weakest(pairs, MAX_SEQ, DROP_BELOW) {
            let m = self.by_seq.get_mut(&k).unwrap();
            m.shift_remove(&word);
            if m.is_empty() {
                self.by_seq.shift_remove(&k);
            }
        }
        let globals = self
            .global
            .iter()
            .map(|(word, r)| (word.clone(), w(r)))
            .collect();
        for word in weakest(globals, MAX_GLOBAL, DROP_BELOW) {
            self.global.shift_remove(&word);
        }
        // 舊檔的詞條沒有 lastAt：從現在開始算
        for p in self.phrases.values_mut() {
            p.last_at.get_or_insert(at);
        }
        let (manual, mined): (Vec<_>, Vec<_>) =
            self.phrases.iter().partition(|(_, p)| p.is_manual());
        let mined = mined
            .into_iter()
            .map(|(word, p)| {
                let f = decayed(p.freq.unwrap_or(1.0), p.last_at.unwrap(), at);
                (word.clone(), f)
            })
            .collect();
        let manual = manual
            .into_iter()
            .map(|(word, p)| (word.clone(), p.last_at.unwrap()))
            .collect();
        let drop: Vec<String> = weakest(mined, MAX_MINED, DROP_BELOW)
            .into_iter()
            .chain(weakest(manual, MAX_MANUAL, f64::NEG_INFINITY))
            .collect();
        for word in drop {
            self.phrases.shift_remove(&word);
        }
    }

    /// 還沒注入解碼器的詞條
    pub fn drain_pending(&mut self) -> Vec<Entry> {
        let mut out = vec![];
        for (w, p) in &self.phrases {
            if self.injected.insert(w.clone()) {
                out.push(Entry {
                    word: w.clone(),
                    readings: p.readings.clone(),
                });
            }
        }
        out
    }

    /// 項目數：(讀音×詞, 全域詞, 使用者詞, 挖詞)
    pub fn stats(&self) -> (usize, usize, usize, usize) {
        let seq = self.by_seq.values().map(IndexMap::len).sum();
        let manual = self.phrases.values().filter(|p| p.is_manual()).count();
        (seq, self.global.len(), manual, self.phrases.len() - manual)
    }

    /// 同 TS 的 JSON.stringify(toJSON())
    pub fn to_json(&self) -> String {
        let mut out = String::from("{\"bySeq\":{");
        for (i, (k, m)) in self.by_seq.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&js(k));
            out.push(':');
            write_recs(&mut out, m);
        }
        out.push_str("},\"global\":");
        write_recs(&mut out, &self.global);
        out.push_str(",\"phrases\":[");
        for (i, (w, p)) in self.phrases.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&format!(
                "{{\"word\":{},\"readings\":{},\"provenance\":{}",
                js(w),
                serde_json::to_string(&p.readings).unwrap(),
                serde_json::to_string(&p.provenance).unwrap()
            ));
            if let Some(m) = p.manual {
                out.push_str(&format!(",\"manual\":{m}"));
            }
            if let Some(f) = p.freq {
                out.push_str(&format!(",\"freq\":{}", num(f)));
            }
            if let Some(t) = p.last_at {
                out.push_str(&format!(",\"lastAt\":{}", num(t)));
            }
            out.push('}');
        }
        out.push_str("]}");
        out
    }

    /// 讀回並以現在的時間整理一次
    pub fn from_json(s: &str) -> Result<Self, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as f64;
        Self::from_json_at(s, now)
    }

    /// 讀回 to_json 的資料並整理一次（at＝現在，決定衰減）
    pub fn from_json_at(s: &str, at: f64) -> Result<Self, String> {
        let v: Value = serde_json::from_str(s).map_err(|e| e.to_string())?;
        let mut a = UserAdapter::new();
        a.by_seq = v
            .get("bySeq")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .map(|(k, m)| (k.clone(), recs(Some(m))))
            .collect();
        a.global = recs(v.get("global"));
        for p in v
            .get("phrases")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let word = p["word"].as_str().ok_or("phrase 缺 word")?;
            a.phrases.insert(
                word.into(),
                Phrase {
                    readings: p["readings"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(strings)
                        .collect(),
                    provenance: strings(&p["provenance"]),
                    manual: p["manual"].as_bool(),
                    freq: p["freq"].as_f64(),
                    last_at: p["lastAt"].as_f64(),
                },
            );
        }
        drop(v);
        a.now = at;
        a.compact(at);
        Ok(a)
    }
}
