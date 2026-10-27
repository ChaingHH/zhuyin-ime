//! X2 使用者適應：packages/core/src/x2.ts UserAdapter 的移植。
//! 資料存成保留插入順序的 IndexMap（JS Map／物件的順序），讀寫的 adapter.json 與 TS 逐位元組相同，
//! phrases 的順序（＝加詞順序）也一樣。上限與整理（compact）照 TS 的 X2_LIMITS；刪除用 shift_remove，
//! 保持其他項目的順序。
//! 不用 serde_json::Value 存：每筆 {count, lastAt} 要約 350 bytes，1.9MB 的學習檔佔 35MB。
//! 讀檔時不認得的欄位會丟掉（TS 會留著）；TS 自己寫的檔沒有這種欄位。
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::OnceLock;

/// 非台灣繁體字（packages/data-pipeline/scripts/build-nontrad.ts 產生，與 core/src/nontrad.ts 同一份）
fn is_traditional_word(w: &str) -> bool {
    static BAD: OnceLock<HashSet<char>> = OnceLock::new();
    let bad = BAD.get_or_init(|| include_str!("nontrad.txt").chars().collect());
    !w.chars().any(|c| bad.contains(&c))
}

const BOOST_PER_COUNT: f64 = 0.55;
const MAX_SEQ_BOOST: f64 = 2.2;
const GLOBAL_FACTOR: f64 = 0.35;
const MANUAL_PHRASE_BOOST: f64 = 8.0;
/// 手動造詞每多一個音節再加多少（算到 6 音節；同 TS manualPhraseBoostPerSyllable）
const MANUAL_PHRASE_BOOST_PER_SYLLABLE: f64 = 10.0;
/// 使用者詞每多用一次（送出裡有它）再加 MANUAL_USE_BOOST × ln(次數)；使用者改掉它（選了別的）就回到 1 次
const MANUAL_USE_BOOST: f64 = 6.0;

/// 挖詞要在幾次送出出現過才加進解碼器（同 TS MINED_MIN_FREQ）：只出現一次的多半是斷錯的片段
const MINED_MIN_FREQ: f64 = 2.0;

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
/// freq：挖詞是出現次數；使用者詞是用過幾次（沒有＝1）
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

/// 選字次數 +1：舊次數先衰減到現在（TS bump）
fn bump(m: &mut IndexMap<String, Rec>, word: &str, at: f64) {
    let count = m
        .get(word)
        .map_or(0.0, |r| r.count * recency(r.last_at, at));
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

/// count／lastAt 不是數字的記錄丟掉（TS fromJSON 同）
fn rec(v: &Value) -> Option<Rec> {
    Some(Rec {
        count: v["count"].as_f64()?,
        last_at: v["lastAt"].as_f64()?,
    })
}

fn recs(v: Option<&Value>) -> IndexMap<String, Rec> {
    v.and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(k, r)| Some((k.clone(), rec(r)?)))
        .collect()
}

/// 現在時間比學習檔最後一筆晚超過這麼多（365 天），載入時不整理
const CLOCK_JUMP_MS: f64 = 365.0 * 86_400_000.0;

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64
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
            now: now_ms(),
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

    /// 送出裡有這個使用者詞（選了或沒選）：用過的次數加一
    pub fn use_phrase(&mut self, word: &str, at: f64) {
        if let Some(p) = self.phrases.get_mut(word).filter(|p| p.is_manual()) {
            p.freq = Some(p.freq.unwrap_or(1.0) + 1.0);
            p.last_at = Some(at);
        }
    }

    /// 使用者把第一名裡的這個使用者詞改成別的：用過的次數回到 1（加成回到基本值）
    pub fn demote(&mut self, word: &str) {
        if let Some(p) = self.phrases.get_mut(word).filter(|p| p.is_manual()) {
            p.freq = None;
        }
    }

    /// U(w)；seq_key＝上下文音節以空白相接（呼叫端每次解碼算一次）
    pub fn modifier_for(&self, seq_key: &str, word: &str, at: f64) -> f64 {
        if !self.enabled {
            return 0.0;
        }
        if self.phrases.get(word).is_some_and(Phrase::is_manual) {
            // 讀音越長加成越大，算到 6 音節（同 TS manualPhraseBoostPerSyllable）
            let extra = seq_key.split(' ').count().min(6).saturating_sub(2) as f64;
            let uses = self.phrases[word].freq.unwrap_or(1.0);
            return MANUAL_PHRASE_BOOST
                + MANUAL_PHRASE_BOOST_PER_SYLLABLE * extra
                + MANUAL_USE_BOOST * uses.ln();
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
        // 已經是使用者詞：次數由 record_selection 算，這裡不重設
        if self.phrases.get(word).is_some_and(Phrase::is_manual) {
            return;
        }
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

    /// 送出時挖到的新詞：freq 記出現次數（每次送出最多算一次），到 MINED_MIN_FREQ 才入格（drain_pending）
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

    /// 學習資料頁的刪除（pime.rs）：拿掉使用者詞，連同這個詞的選字紀錄（各讀音與全域）。
    /// 回傳它的讀音（呼叫端從解碼器拿掉）；沒有這個詞回空的
    pub fn remove_phrase(&mut self, word: &str) -> Vec<Vec<String>> {
        let readings = self
            .phrases
            .shift_remove(word)
            .map_or(vec![], |p| p.readings);
        self.injected.remove(word);
        self.by_seq.retain(|_, m| {
            m.shift_remove(word);
            !m.is_empty()
        });
        self.global.shift_remove(word);
        readings
    }

    /// 學習資料頁的刪除：一筆選字紀錄。reading＝音節以空白相接（依讀音的那筆），None＝全域那筆
    pub fn remove_selection(&mut self, reading: Option<&str>, word: &str) -> bool {
        match reading {
            None => self.global.shift_remove(word).is_some(),
            Some(k) => {
                let Some(m) = self.by_seq.get_mut(k) else {
                    return false;
                };
                let hit = m.shift_remove(word).is_some();
                if m.is_empty() {
                    self.by_seq.shift_remove(k);
                }
                hit
            }
        }
    }

    /// 還沒注入解碼器的詞條
    pub fn drain_pending(&mut self) -> Vec<Entry> {
        let mut out = vec![];
        for (w, p) in &self.phrases {
            // 舊 adapter.json 可能有非台灣繁體字的詞，不入格（x2.ts 同步）
            // 挖詞要出現 MINED_MIN_FREQ 次才入格（mine_word）
            if !p.is_manual() && p.freq.unwrap_or(1.0) < MINED_MIN_FREQ {
                continue;
            }
            if is_traditional_word(w) && self.injected.insert(w.clone()) {
                out.push(Entry {
                    word: w.clone(),
                    readings: p.readings.clone(),
                });
            }
        }
        out
    }

    /// 所有使用者詞與挖詞的詞條（關掉學習時從解碼器拿掉）；清空注入紀錄，再打開時 drain_pending 重新給
    pub fn take_entries(&mut self) -> Vec<Entry> {
        self.injected.clear();
        self.phrases
            .iter()
            .map(|(w, p)| Entry {
                word: w.clone(),
                readings: p.readings.clone(),
            })
            .collect()
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
        Self::from_json_at(s, now_ms())
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
            // 壞詞條跳過（TS 同）
            let Some(word) = p["word"].as_str() else {
                continue;
            };
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
        let latest = a
            .global
            .values()
            .chain(a.by_seq.values().flat_map(IndexMap::values))
            .map(|r| r.last_at)
            .chain(a.phrases.values().filter_map(|p| p.last_at))
            .fold(f64::NEG_INFINITY, f64::max);
        // 時鐘跳到未來時，整理會把全部記錄當成過期刪光：跳過，等時鐘正常
        if latest.is_finite() && at - latest > CLOCK_JUMP_MS {
            eprintln!("x2：現在時間比學習檔最後一筆晚超過 365 天，跳過整理（時鐘錯了？）");
        } else {
            a.compact(at);
        }
        Ok(a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: f64 = 1.7e12;
    const DAY: f64 = 86_400_000.0;

    fn rd(s: &str) -> Vec<String> {
        s.split(' ').map(String::from).collect()
    }

    #[test]
    fn selection_boost_by_reading_and_global() {
        let mut a = UserAdapter::new();
        a.record_selection(&rd("ㄕˋ ㄐㄧㄢ"), "事件", T0);
        let g = BOOST_PER_COUNT * 2f64.ln();
        assert_eq!(
            a.modifier_for("ㄕˋ ㄐㄧㄢ", "事件", T0),
            g + g * GLOBAL_FACTOR
        );
        // 別的讀音只有全域那份；14 天後減半
        assert_eq!(a.modifier_for("ㄕˋ", "事件", T0), g * GLOBAL_FACTOR);
        assert_eq!(
            a.modifier_for("ㄕˋ", "事件", T0 + 14.0 * DAY),
            g * GLOBAL_FACTOR / 2.0
        );
        // 加成有上限
        for _ in 0..100 {
            a.record_selection(&rd("ㄕˋ ㄐㄧㄢ"), "事件", T0);
        }
        let u = a.modifier_for("ㄕˋ ㄐㄧㄢ", "事件", T0);
        assert_eq!(u, MAX_SEQ_BOOST + MAX_SEQ_BOOST / 2.0 * GLOBAL_FACTOR);
        a.enabled = false;
        assert_eq!(a.modifier_for("ㄕˋ ㄐㄧㄢ", "事件", T0), 0.0);
        a.record_selection(&rd("ㄕˋ"), "是", T0);
        assert_eq!(a.stats(), (1, 1, 0, 0));
    }

    #[test]
    fn manual_phrase_boost_grows_with_syllables() {
        let mut a = UserAdapter::new();
        a.set_user_phrase("狀態欄", &rd("ㄓㄨㄤˋ ㄊㄞˋ ㄌㄢˊ"));
        let boost = |k: &str| a.modifier_for(k, "狀態欄", T0);
        assert_eq!(boost("a b"), MANUAL_PHRASE_BOOST);
        assert_eq!(
            boost("a b c"),
            MANUAL_PHRASE_BOOST + MANUAL_PHRASE_BOOST_PER_SYLLABLE
        );
        // 算到 6 音節
        assert_eq!(
            boost("a b c d e f g h"),
            MANUAL_PHRASE_BOOST + 4.0 * MANUAL_PHRASE_BOOST_PER_SYLLABLE
        );
        assert_eq!(a.stats(), (0, 0, 1, 0));
    }

    #[test]
    fn manual_phrase_use_count_survives_json() {
        let mut a = UserAdapter::new();
        let r = rd("ㄓㄨㄤˋ ㄊㄞˋ");
        a.set_user_phrase("狀態", &r);
        a.use_phrase("狀態", T0);
        let b = UserAdapter::from_json(&a.to_json()).unwrap();
        assert_eq!(
            b.modifier_for("a b", "狀態", T0),
            MANUAL_PHRASE_BOOST + MANUAL_USE_BOOST * 2f64.ln()
        );
    }

    #[test]
    fn mined_word_enters_after_two_commits() {
        let mut a = UserAdapter::new();
        assert!(!a.mine_word("字", &rd("ㄗˋ")), "單字不挖");
        assert!(a.mine_word("狀態", &rd("ㄓㄨㄤˋ ㄊㄞˋ")));
        assert!(a.drain_pending().is_empty());
        assert!(!a.mine_word("狀態", &rd("ㄓㄨㄤˋ ㄊㄞˋ")));
        let e = a.drain_pending();
        assert_eq!(e.len(), 1);
        assert_eq!(
            (e[0].word.as_str(), e[0].readings.clone()),
            ("狀態", vec![rd("ㄓㄨㄤˋ ㄊㄞˋ")])
        );
        // 注入過的不再給；take_entries 清掉注入紀錄後再給一次
        assert!(a.drain_pending().is_empty());
        assert_eq!(a.take_entries().len(), 1);
        assert_eq!(a.drain_pending().len(), 1);
        assert_eq!(a.stats(), (0, 0, 0, 1));
    }

    #[test]
    fn mining_does_not_touch_manual_phrase_and_nontraditional_is_skipped() {
        let mut a = UserAdapter::new();
        a.set_user_phrase("狀態", &rd("ㄓㄨㄤˋ ㄊㄞˋ"));
        assert!(!a.mine_word("狀態", &rd("ㄓㄨㄤˋ ㄊㄞˋ")));
        assert!(!a.to_json().contains("\"freq\""));
        // 非台灣繁體字的詞不入格（手動詞也一樣）
        a.set_user_phrase("这个", &rd("ㄓㄜˋ ㄍㄜ˙"));
        let words: Vec<_> = a.drain_pending().into_iter().map(|e| e.word).collect();
        assert_eq!(words, ["狀態"]);
    }

    #[test]
    fn remove_phrase_and_selection() {
        let mut a = UserAdapter::new();
        a.set_user_phrase("狀態欄", &rd("ㄓㄨㄤˋ ㄊㄞˋ ㄌㄢˊ"));
        a.record_selection(&rd("ㄓㄨㄤˋ ㄊㄞˋ ㄌㄢˊ"), "狀態欄", T0);
        a.record_selection(&rd("ㄕˋ"), "是", T0);
        assert_eq!(a.remove_phrase("狀態欄"), vec![rd("ㄓㄨㄤˋ ㄊㄞˋ ㄌㄢˊ")]);
        assert_eq!(a.stats(), (1, 1, 0, 0));
        assert!(a.remove_phrase("沒有").is_empty());
        assert!(!a.remove_selection(Some("ㄕˋ"), "事"));
        assert!(a.remove_selection(Some("ㄕˋ"), "是"));
        assert!(!a.remove_selection(Some("ㄕˋ"), "是"));
        assert!(a.remove_selection(None, "是"));
        assert_eq!(a.stats(), (0, 0, 0, 0));
        assert_eq!(a.to_json(), r#"{"bySeq":{},"global":{},"phrases":[]}"#);
    }

    #[test]
    fn compact_drops_decayed_records() {
        let mut a = UserAdapter::new();
        a.record_selection(&rd("ㄕˋ"), "是", T0);
        // 1 × 0.5^(70/14) = 0.03125 ≥ 0.025 留著；75 天 < 0.025 刪掉
        a.compact(T0 + 70.0 * DAY);
        assert_eq!(a.stats(), (1, 1, 0, 0));
        a.compact(T0 + 75.0 * DAY);
        assert_eq!(a.stats(), (0, 0, 0, 0));
        // 手動詞不衰減
        a.set_user_phrase("狀態", &rd("ㄓㄨㄤˋ ㄊㄞˋ"));
        a.compact(T0 + 1000.0 * DAY);
        assert_eq!(a.stats(), (0, 0, 1, 0));
    }

    #[test]
    fn weakest_drops_below_threshold_then_down_to_cap() {
        let items = vec![("a", 0.01), ("b", 3.0), ("c", 1.0), ("d", 1.0), ("e", 2.0)];
        let mut out = weakest(items.clone(), 10, 0.025);
        assert_eq!(out, ["a"]);
        // 同分刪前面的
        out = weakest(items, 2, 0.025);
        assert_eq!(out, ["a", "c", "d"]);
    }

    #[test]
    fn json_round_trip() {
        let mut a = UserAdapter::new();
        a.record_selection(&rd("ㄕˋ ㄐㄧㄢ"), "事件", T0);
        a.set_user_phrase("狀態欄", &rd("ㄓㄨㄤˋ ㄊㄞˋ ㄌㄢˊ"));
        a.mine_word("狀態", &rd("ㄓㄨㄤˋ ㄊㄞˋ"));
        let s = a.to_json();
        assert_eq!(
            s,
            r#"{"bySeq":{"ㄕˋ ㄐㄧㄢ":{"事件":{"count":1,"lastAt":1700000000000}}},"global":{"事件":{"count":1,"lastAt":1700000000000}},"phrases":[{"word":"狀態欄","readings":[["ㄓㄨㄤˋ","ㄊㄞˋ","ㄌㄢˊ"]],"provenance":["user"],"manual":true,"lastAt":1700000000000},{"word":"狀態","readings":[["ㄓㄨㄤˋ","ㄊㄞˋ"]],"provenance":["mined"],"freq":1,"lastAt":1700000000000}]}"#
        );
        assert_eq!(UserAdapter::from_json_at(&s, T0).unwrap().to_json(), s);
        assert!(UserAdapter::from_json_at("{", T0).is_err());
    }

    #[test]
    fn from_json_skips_compaction_after_clock_jump() {
        let mut a = UserAdapter::new();
        a.record_selection(&rd("ㄕˋ"), "是", T0);
        let s = a.to_json();
        assert_eq!(
            UserAdapter::from_json_at(&s, T0 + 400.0 * DAY)
                .unwrap()
                .stats(),
            (1, 1, 0, 0)
        );
        assert_eq!(
            UserAdapter::from_json_at(&s, T0 + 300.0 * DAY)
                .unwrap()
                .stats(),
            (0, 0, 0, 0)
        );
    }
}
