//! L3 假設展開（通道模型）：packages/core/src/l3.ts Channel 的移植。
//! 展開順序、同代價的排序都照 TS（Map 插入順序＋穩定排序），結果逐項相同。
use crate::keymap::{key_neighbors, slot_of, DACHEN, FINALS, INITIALS, MARKS, MEDIALS, TONE_CODES};
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
        let sym = |code: &str| DACHEN.iter().find(|(c, _)| *c == code).map(|(_, s)| *s);
        let mark = |code: &str| {
            TONE_CODES
                .iter()
                .find(|(c, _)| *c == code)
                .map(|(_, t)| MARKS[*t as usize - 1])
        };
        let sym_neighbors = DACHEN
            .iter()
            .map(|(code, s)| {
                (
                    *s,
                    key_neighbors(code).iter().filter_map(|n| sym(n)).collect(),
                )
            })
            .collect();
        let tone_neighbors = TONE_CODES
            .iter()
            .map(|(code, _)| {
                (
                    mark(code).unwrap(),
                    key_neighbors(code).iter().filter_map(|n| mark(n)).collect(),
                )
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

    /// 展開觀察音節：第一個永遠是原音節（代價 0），其後依代價遞增
    pub fn expand(&self, observed: &str) -> Vec<Hypothesis> {
        if let Some(h) = self.cache.borrow().get(observed) {
            return h.clone();
        }
        // 插入順序＋最低代價（JS Map：更新代價不改位置）
        let mut best: Vec<(String, f64)> = vec![];
        let mut add = |p: &Parts, cost: f64| {
            let s = join(p);
            if s == observed || !self.legal.contains(&s) {
                return;
            }
            match best.iter_mut().find(|(x, _)| *x == s) {
                Some(e) => {
                    if cost < e.1 {
                        e.1 = cost
                    }
                }
                None => best.push((s, cost)),
            }
        };
        if let Some(p) = parse(observed) {
            let o = &self.o;
            for slot in 0..3 {
                let Some(c) = p.0[slot] else { continue };
                // 多按一鍵：意圖沒有這個符號
                let mut q = p;
                q.0[slot] = None;
                add(&q, o.extra);
                // 按到相鄰鍵
                for &s in self.sym_neighbors.get(c).map_or(&[][..], |v| v) {
                    let s_slot = slot_of(s).unwrap();
                    let mut q = p;
                    if s_slot == slot {
                        q.0[slot] = Some(s);
                        add(&q, o.sub);
                    } else if p.0[s_slot].is_none() {
                        q.0[slot] = None;
                        q.0[s_slot] = Some(s);
                        add(&q, o.sub);
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
                    add(&q, fz);
                }
            }
            // 漏按一鍵：只補空槽
            let pools: [&[&'static str]; 3] = [&INITIALS, &MEDIALS, &FINALS];
            for slot in 0..3 {
                if p.0[slot].is_some() {
                    continue;
                }
                for &s in pools[slot] {
                    let mut q = p;
                    q.0[slot] = Some(s);
                    add(&q, o.miss);
                }
            }
            // 聲調：相鄰聲調鍵較便宜，其他聲調算記錯
            let adj = self.tone_neighbors.get(p.1).map_or(&[][..], |v| v);
            for m in MARKS {
                if m != p.1 {
                    let cost = if adj.contains(&m) { o.tone_adj } else { o.tone };
                    add(&(p.0, m), cost);
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
                .take(self.o.max_alts)
                .map(|(syl, cost)| Hypothesis { syl, cost }),
        );
        self.cache
            .borrow_mut()
            .insert(observed.to_string(), out.clone());
        out
    }
}
