//! L3 假設展開（通道模型）：packages/core/src/l3.ts Channel 的移植。
//! 展開順序、同代價的排序都照 TS（Map 插入順序＋穩定排序），結果逐項相同。
use crate::keymap::{key_neighbors, slot_of, Layout, Mapped, FINALS, INITIALS, MARKS, MEDIALS};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq)]
pub struct Hypothesis {
    pub syl: String,
    pub cost: f64,
}

#[derive(Clone, Copy)]
pub struct ChannelOptions {
    pub sub: f64,
    pub extra: f64,
    pub miss: f64,
    pub tone_adj: f64,
    pub tone: f64,
    pub fuzzy: f64,
    pub nasal: f64,
    pub max_alts: usize,
}

impl Default for ChannelOptions {
    fn default() -> Self {
        ChannelOptions {
            // 與 TS 同步（packages/core/src/l3.ts）：寧可不修也不要修錯
            sub: 18.0,
            extra: 21.0,
            miss: 24.0,
            tone_adj: 15.0,
            tone: 21.0,
            fuzzy: 15.0,
            nasal: 3.5,
            max_alts: 24,
        }
    }
}

pub const FUZZY_PAIRS: [(&str, &str); 7] = [
    ("ㄣ", "ㄥ"),
    ("ㄓ", "ㄗ"),
    ("ㄔ", "ㄘ"),
    ("ㄕ", "ㄙ"),
    ("ㄈ", "ㄏ"),
    ("ㄌ", "ㄋ"),
    ("ㄌ", "ㄖ"),
];

/// 聲母、介音、韻母、聲調標記
type Parts = ([Option<&'static str>; 3], &'static str);

fn intern(s: &str) -> Option<&'static str> {
    INITIALS
        .iter()
        .chain(MEDIALS.iter())
        .chain(FINALS.iter())
        .chain(MARKS.iter())
        .find(|x| **x == s)
        .copied()
}

fn parse(syl: &str) -> Option<Parts> {
    let mut p: Parts = ([None; 3], "");
    for ch in syl.chars() {
        let s = intern(&ch.to_string())?;
        if MARKS[1..].contains(&s) {
            p.1 = s;
            continue;
        }
        let slot = slot_of(s)?;
        if p.0[slot].is_some() {
            return None;
        }
        p.0[slot] = Some(s);
    }
    Some(p)
}

fn join(p: &Parts) -> String {
    p.0.iter().flatten().copied().collect::<String>() + p.1
}

pub struct Channel {
    legal: HashSet<String>,
    o: ChannelOptions,
    cache: RefCell<HashMap<String, Vec<Hypothesis>>>,
    sym_neighbors: HashMap<&'static str, Vec<&'static str>>,
    tone_neighbors: HashMap<&'static str, Vec<&'static str>>,
    fuzzy: HashMap<&'static str, Vec<&'static str>>,
    /// 使用者的打錯習慣：(打出的符號, 想打的符號) → 次數（learn）。換符號、換聲調才記
    learned: HashMap<(&'static str, &'static str), f64>,
    /// 想打的符號（含聲調）出現幾次（observe）：改法要占它的 learn_rate 以上才算習慣
    seen: HashMap<&'static str, f64>,
    /// 學過 n 次的改法代價 ÷ (1 + n / learn_k)，最低 nasal
    pub learn_k: f64,
    /// 0＝不看比例（只看次數）
    pub learn_rate: f64,
    /// false＝學到的不用（照原本的代價）；資料保留（set_use_learned）
    use_learned: bool,
}

impl Channel {
    pub fn new(legal: HashSet<String>, o: ChannelOptions) -> Self {
        Self::with_layout(legal, o, Layout::Dachen)
    }

    /// 鄰鍵依排列的實體鍵位推回注音：同一個鍵有好幾個符號（許氏、倚天 26 鍵）時都算
    pub fn with_layout(legal: HashSet<String>, o: ChannelOptions, layout: Layout) -> Self {
        let near = |m: Mapped| {
            let code = layout.code_of(m).unwrap();
            key_neighbors(&code)
                .iter()
                .flat_map(|n| layout.meanings(n))
                .collect::<Vec<_>>()
        };
        let sym_neighbors = INITIALS
            .iter()
            .chain(&MEDIALS)
            .chain(&FINALS)
            .map(|&s| {
                let nb = near(Mapped::Symbol(s)).into_iter().filter_map(|m| match m {
                    Mapped::Symbol(x) => Some(x),
                    _ => None,
                });
                (s, nb.collect())
            })
            .collect();
        let tone_neighbors = (1..=5u8)
            .map(|t| {
                let nb = near(Mapped::Tone(t)).into_iter().filter_map(|m| match m {
                    Mapped::Tone(x) => Some(MARKS[x as usize - 1]),
                    _ => None,
                });
                (MARKS[t as usize - 1], nb.collect())
            })
            .collect();
        let mut fuzzy: HashMap<&'static str, Vec<&'static str>> = HashMap::new();
        for (a, b) in FUZZY_PAIRS {
            fuzzy.entry(a).or_default().push(b);
            fuzzy.entry(b).or_default().push(a);
        }
        Channel {
            legal,
            o,
            cache: RefCell::default(),
            sym_neighbors,
            tone_neighbors,
            fuzzy,
            learned: HashMap::new(),
            seen: HashMap::new(),
            learn_k: 3.0,
            learn_rate: 0.05,
            use_learned: true,
        }
    }

    pub fn relayout(self, layout: Layout) -> Self {
        let mut c = Self::with_layout(self.legal, self.o, layout);
        (c.learned, c.seen, c.learn_k, c.learn_rate, c.use_learned) = (
            self.learned,
            self.seen,
            self.learn_k,
            self.learn_rate,
            self.use_learned,
        );
        c
    }

    /// 記一次「打 observed、其實要 intended」。只差一個符號（同槽）或只差聲調才記，回傳記了沒
    pub fn learn(&mut self, observed: &str, intended: &str) -> bool {
        let (Some(a), Some(b)) = (parse(observed), parse(intended)) else {
            return false;
        };
        let diff: Vec<usize> = (0..3).filter(|&i| a.0[i] != b.0[i]).collect();
        let pair = match (diff.as_slice(), a.1 == b.1) {
            ([i], true) => match (a.0[*i], b.0[*i]) {
                (Some(x), Some(y)) => (x, y),
                _ => return false,
            },
            ([], false) => (a.1, b.1),
            _ => return false,
        };
        *self.learned.entry(pair).or_default() += 1.0;
        self.cache.borrow_mut().clear();
        true
    }

    /// 學到的改法：(打出的, 想打的, 次數, 已經算習慣)，次數多的在前
    pub fn learned_list(&self) -> Vec<(String, String, f64, bool)> {
        let mut v: Vec<_> = self
            .learned
            .iter()
            .map(|(&(a, b), &n)| {
                let seen = self.seen.get(b).copied().unwrap_or(0.0);
                let on = self.learn_rate == 0.0 || n / (seen + 20.0) >= self.learn_rate;
                (a.to_string(), b.to_string(), n, on)
            })
            .collect();
        v.sort_by(|x, y| y.2.partial_cmp(&x.2).unwrap().then_with(|| x.0.cmp(&y.0)));
        v
    }

    pub fn set_use_learned(&mut self, on: bool) {
        self.use_learned = on;
        self.cache.borrow_mut().clear();
    }

    pub fn has_learned(&self) -> bool {
        !self.learned.is_empty() || !self.seen.is_empty()
    }

    pub fn clear_learned(&mut self) {
        self.learned.clear();
        self.seen.clear();
        self.cache.borrow_mut().clear();
    }

    /// 存檔格式：{"pairs": [[打出的, 想打的, 次數], …], "seen": {符號: 次數}}
    pub fn learned_json(&self) -> serde_json::Value {
        let pairs: Vec<_> = self
            .learned
            .iter()
            .map(|(&(a, b), &n)| serde_json::json!([a, b, n]))
            .collect();
        serde_json::json!({ "pairs": pairs, "seen": self.seen })
    }

    /// 讀 learned_json 的格式；看不懂的項目略過
    pub fn load_learned(&mut self, v: &serde_json::Value) {
        for p in v["pairs"].as_array().into_iter().flatten() {
            if let (Some(a), Some(b), Some(n)) = (
                p[0].as_str().and_then(intern),
                p[1].as_str().and_then(intern),
                p[2].as_f64(),
            ) {
                self.learned.insert((a, b), n);
            }
        }
        for (k, n) in v["seen"].as_object().into_iter().flatten() {
            if let (Some(k), Some(n)) = (intern(k), n.as_f64()) {
                self.seen.insert(k, n);
            }
        }
        self.cache.borrow_mut().clear();
    }

    /// 記一個送出的（想打的）音節：每個符號、聲調的出現次數
    pub fn observe(&mut self, intended: &str) {
        if let Some(p) = parse(intended) {
            for s in p.0.iter().flatten().chain([&p.1]) {
                *self.seen.entry(s).or_default() += 1.0;
            }
            self.cache.borrow_mut().clear();
        }
    }

    /// 學過的改法打折：打錯次數 ÷ (想打的符號出現次數 + 20) 夠高才算習慣，隨機手滑不算
    fn learned_cost(&self, from: &'static str, to: &'static str, cost: f64) -> f64 {
        let Some(&n) = self.learned.get(&(from, to)).filter(|_| self.use_learned) else {
            return cost;
        };
        let seen = self.seen.get(to).copied().unwrap_or(0.0);
        if self.learn_rate > 0.0 && n / (seen + 20.0) < self.learn_rate {
            return cost;
        }
        (cost / (1.0 + n / self.learn_k)).max(self.o.nasal.min(cost))
    }

    /// 展開觀察音節：第一個永遠是原音節（代價 0），其後依代價遞增
    pub fn expand(&self, observed: &str) -> Vec<Hypothesis> {
        if let Some(h) = self.cache.borrow().get(observed) {
            return h.clone();
        }
        // 插入順序＋最低代價（JS Map：更新代價不改位置）；第三欄＝不受 max_alts 限制（漏按）
        let mut best: Vec<(String, f64, bool)> = vec![];
        let mut add = |p: &Parts, cost: f64, keep: bool| {
            let s = join(p);
            if s == observed || !self.legal.contains(&s) {
                return;
            }
            match best.iter_mut().find(|(x, _, _)| *x == s) {
                Some(e) => {
                    if cost < e.1 {
                        e.1 = cost;
                        e.2 = keep;
                    }
                }
                None => best.push((s, cost, keep)),
            }
        };
        let parsed = parse(observed);
        if let Some(p) = parsed {
            let o = &self.o;
            let pools: [&[&'static str]; 3] = [&INITIALS, &MEDIALS, &FINALS];
            for (slot, &pool) in pools.iter().enumerate() {
                let Some(c) = p.0[slot] else { continue };
                // 多按一鍵：意圖沒有這個符號
                let mut q = p;
                q.0[slot] = None;
                add(&q, o.extra, false);
                // 按到相鄰鍵
                for &s in self.sym_neighbors.get(c).map_or(&[][..], |v| v) {
                    let s_slot = slot_of(s).unwrap();
                    let mut q = p;
                    let sub = self.learned_cost(c, s, o.sub);
                    if s_slot == slot {
                        q.0[slot] = Some(s);
                        add(&q, sub, false);
                    } else if p.0[s_slot].is_none() {
                        q.0[slot] = None;
                        q.0[s_slot] = Some(s);
                        add(&q, sub, false);
                        // 跨槽覆蓋：鄰鍵 c 蓋掉了 slot 槽原本的符號 x（ㄒㄧㄠ 的 U 按成 Y → ㄗㄠ）
                        for &x in pool {
                            q.0[slot] = Some(x);
                            add(&q, o.sub, false);
                        }
                    }
                }
                let fz = if c == "ㄣ" || c == "ㄥ" {
                    o.nasal
                } else {
                    o.fuzzy
                };
                for &s in self.fuzzy.get(c).map_or(&[][..], |v| v) {
                    let mut q = p;
                    q.0[slot] = Some(s);
                    add(&q, self.learned_cost(c, s, fz), false);
                }
            }
            // 漏按一鍵：只補空槽。不受 max_alts 限制：同代價的漏按很多，依池順序截斷會砍掉 ㄨˇ→ㄨㄛˇ
            for (slot, &pool) in pools.iter().enumerate() {
                if p.0[slot].is_some() {
                    continue;
                }
                for &s in pool {
                    let mut q = p;
                    q.0[slot] = Some(s);
                    add(&q, o.miss, true);
                }
            }
            // 聲調：相鄰聲調鍵較便宜，其他聲調算記錯
            let adj = self.tone_neighbors.get(p.1).map_or(&[][..], |v| v);
            for m in MARKS {
                if m != p.1 {
                    let cost = if adj.contains(&m) { o.tone_adj } else { o.tone };
                    add(&(p.0, m), self.learned_cost(p.1, m, cost), false);
                }
            }
        }
        best.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        let mut out = vec![Hypothesis {
            syl: observed.to_string(),
            cost: 0.0,
        }];
        out.extend(
            best.into_iter()
                .enumerate()
                .filter(|(i, (_, _, keep))| *i < self.o.max_alts || *keep)
                .map(|(_, (syl, cost, _))| Hypothesis { syl, cost }),
        );
        // 解析不了的（英文、原樣 token）不快取：常駐時快取才不會跟著打過的英文一直長
        if parsed.is_some() {
            self.cache
                .borrow_mut()
                .insert(observed.to_string(), out.clone());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel(legal: &[&str], o: ChannelOptions) -> Channel {
        Channel::new(legal.iter().map(|s| s.to_string()).collect(), o)
    }

    fn cost(hs: &[Hypothesis], syl: &str) -> Option<f64> {
        hs.iter().find(|h| h.syl == syl).map(|h| h.cost)
    }

    #[test]
    fn observed_first_then_sorted_by_cost() {
        let c = channel(
            &["ㄇㄚˇ", "ㄇㄚˋ", "ㄇㄚˊ", "ㄋㄚˇ", "ㄇㄚ"],
            Default::default(),
        );
        let hs = c.expand("ㄇㄚˇ");
        assert_eq!(
            hs[0],
            Hypothesis {
                syl: "ㄇㄚˇ".into(),
                cost: 0.0
            }
        );
        assert!(hs.windows(2).skip(1).all(|w| w[0].cost <= w[1].cost));
        // 只出合法音節、不重複原音節
        assert_eq!(hs.len(), 5);
    }

    #[test]
    fn edit_costs() {
        let o = ChannelOptions::default();
        let c = channel(
            &[
                "ㄧㄥ",
                "ㄗㄚ",
                "ㄋㄚ",
                "ㄇㄚ",
                "ㄏㄨㄠ",
                "ㄇㄚˋ",
                "ㄇㄚˊ",
                "ㄧㄢ",
                "ㄨㄛˇ",
            ],
            o,
        );
        // ㄣ／ㄥ 有自己的低代價；其他模糊音
        assert_eq!(cost(&c.expand("ㄧㄣ"), "ㄧㄥ"), Some(o.nasal));
        assert_eq!(o.nasal, 3.5);
        assert_eq!(cost(&c.expand("ㄓㄚ"), "ㄗㄚ"), Some(o.fuzzy));
        // 鄰鍵（A 與 S）、多按、漏按
        assert_eq!(cost(&c.expand("ㄇㄚ"), "ㄋㄚ"), Some(o.sub));
        assert_eq!(cost(&c.expand("ㄇㄨㄚ"), "ㄇㄚ"), Some(o.extra));
        assert_eq!(cost(&c.expand("ㄏㄠ"), "ㄏㄨㄠ"), Some(o.miss));
        // 同一個意圖音節有好幾種改法時取最便宜的：ㄨˇ→ㄨㄛˇ 是漏按，也是 J→I 鄰鍵跨槽
        assert_eq!(cost(&c.expand("ㄨˇ"), "ㄨㄛˇ"), Some(o.sub));
        // 鄰鍵 P→0：ㄣ→ㄢ
        assert_eq!(cost(&c.expand("ㄧㄣ"), "ㄧㄢ"), Some(o.sub));
        // 聲調：3 與 4 相鄰較便宜，其他算記錯
        let hs = c.expand("ㄇㄚˇ");
        assert_eq!(cost(&hs, "ㄇㄚˋ"), Some(o.tone_adj));
        assert_eq!(cost(&hs, "ㄇㄚˊ"), Some(o.tone));
        assert_eq!(cost(&hs, "ㄇㄚ"), Some(o.tone));
    }

    #[test]
    fn one_edit_per_syllable() {
        // ㄓㄣ→ㄗㄥ 要兩次模糊音
        let c = channel(&["ㄗㄥ", "ㄗㄣ", "ㄓㄥ"], Default::default());
        let hs = c.expand("ㄓㄣ");
        assert_eq!(cost(&hs, "ㄗㄥ"), None);
        assert!(cost(&hs, "ㄗㄣ").is_some() && cost(&hs, "ㄓㄥ").is_some());
    }

    #[test]
    fn max_alts_cuts_all_but_missed_keys() {
        let o = ChannelOptions {
            max_alts: 1,
            ..Default::default()
        };
        let c = channel(&["ㄇㄚˋ", "ㄇㄚˊ", "ㄇㄨㄚˇ", "ㄇㄩㄚˇ", "ㄇㄧㄚˇ"], o);
        let hs: Vec<_> = c.expand("ㄇㄚˇ").into_iter().map(|h| h.syl).collect();
        // 最便宜的一個（相鄰聲調）＋不受限的漏按。
        // ㄇㄧㄚˇ 也是漏按，但 8→U 鄰鍵跨槽更便宜，記成鄰鍵後就受 max_alts 限制、被截掉（現況）
        assert_eq!(hs, ["ㄇㄚˇ", "ㄇㄚˋ", "ㄇㄨㄚˇ", "ㄇㄩㄚˇ"]);
    }

    #[test]
    fn learned_pairs_get_cheaper() {
        let mut c = channel(&["ㄇㄛˊ", "ㄇㄟˊ", "ㄇㄚˋ"], Default::default());
        c.learn_rate = 0.0;
        assert_eq!(cost(&c.expand("ㄇㄛˊ"), "ㄇㄟˊ"), Some(18.0));
        assert!(c.learn("ㄇㄛˊ", "ㄇㄟˊ"));
        // 快取跟著清掉；學 1 次 ÷ (1 + 1/3)
        assert_eq!(cost(&c.expand("ㄇㄛˊ"), "ㄇㄟˊ"), Some(13.5));
        for _ in 0..100 {
            c.learn("ㄇㄛˊ", "ㄇㄟˊ");
        }
        assert_eq!(cost(&c.expand("ㄇㄛˊ"), "ㄇㄟˊ"), Some(3.5));
        // 反方向、聲調、差兩處
        assert_eq!(cost(&c.expand("ㄇㄟˊ"), "ㄇㄛˊ"), Some(18.0));
        assert!(c.learn("ㄇㄚˇ", "ㄇㄚˋ"));
        assert!(!c.learn("ㄇㄛˊ", "ㄇㄚˋ"));
        // 看比例：ㄟ 出現 2000 次、打錯 101 次 → 101 / 2020 = 5% 剛好算；再多就不算
        c.learn_rate = 0.05;
        for _ in 0..2000 {
            c.observe("ㄇㄟˊ");
        }
        assert_eq!(cost(&c.expand("ㄇㄛˊ"), "ㄇㄟˊ"), Some(3.5));
        c.observe("ㄇㄟˊ");
        assert_eq!(cost(&c.expand("ㄇㄛˊ"), "ㄇㄟˊ"), Some(18.0));
        assert_eq!(
            c.learned_list()[0],
            ("ㄛ".into(), "ㄟ".into(), 101.0, false)
        );
        // 存檔再讀回來一樣；use_learned 關掉就照原本的代價
        let mut d = channel(&["ㄇㄛˊ", "ㄇㄟˊ", "ㄇㄚˋ"], Default::default());
        d.load_learned(&c.learned_json());
        assert_eq!(d.learned_list(), c.learned_list());
        c.learn_rate = 0.0;
        c.cache.borrow_mut().clear();
        assert_eq!(cost(&c.expand("ㄇㄛˊ"), "ㄇㄟˊ"), Some(3.5));
        c.set_use_learned(false);
        assert_eq!(cost(&c.expand("ㄇㄛˊ"), "ㄇㄟˊ"), Some(18.0));
    }

    #[test]
    fn unparsable_tokens_are_not_cached() {
        let c = channel(&["ㄇㄚ"], Default::default());
        assert_eq!(
            c.expand("abc"),
            [Hypothesis {
                syl: "abc".into(),
                cost: 0.0
            }]
        );
        c.expand("ㄇㄚˇ");
        assert_eq!(c.cache.borrow().len(), 1);
        assert!(c.cache.borrow().contains_key("ㄇㄚˇ"));
    }
}
