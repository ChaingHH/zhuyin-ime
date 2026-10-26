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
        }
    }

    pub fn relayout(self, layout: Layout) -> Self {
        Self::with_layout(self.legal, self.o, layout)
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
                    if s_slot == slot {
                        q.0[slot] = Some(s);
                        add(&q, o.sub, false);
                    } else if p.0[s_slot].is_none() {
                        q.0[slot] = None;
                        q.0[s_slot] = Some(s);
                        add(&q, o.sub, false);
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
                    add(&q, fz, false);
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
                    add(&(p.0, m), cost, false);
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
