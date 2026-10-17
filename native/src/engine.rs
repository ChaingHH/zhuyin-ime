//! 輸入法引擎：packages/cli/src/engine.ts ImeEngine 的移植（注音／英文模式、選字視窗、
//! 游標、標點與原樣 token、Esc、送出學習）。時鐘由呼叫端給（X2 的 at），對拍時固定。
use crate::decode::{is_literal, DecodeOptions, DecodePath, Decoder, FixedSpan};
use crate::l3::{Channel, Hypothesis};
use crate::slots::CompositionBuffer;
use crate::x2::UserAdapter;
use std::collections::{HashMap, HashSet};

const UNK: &str = "\u{25A1}";
const MENU_PAGE: usize = 9;

/// 注音模式的全形標點，鍵為 KeyboardEvent.key（美式鍵盤）
const PUNCT: [(&str, &str); 14] = [
    ("<", "，"),
    (">", "。"),
    ("?", "？"),
    (":", "："),
    ("\"", "；"),
    ("!", "！"),
    ("[", "「"),
    ("]", "」"),
    ("{", "『"),
    ("}", "』"),
    ("(", "（"),
    (")", "）"),
    ("\\", "、"),
    ("~", "～"),
];

pub struct MenuView {
    pub items: Vec<String>,
    pub page: usize,
    pub pages: usize,
    /// 反白的候選在本頁的位置（Enter 選它）
    pub cursor: usize,
}

pub struct EngineState {
    pub composition: String,
    pub last_legal: bool,
    /// 這次按鍵直接輸出的文字（英文模式、組字區空時的標點）
    pub text: Option<String>,
    pub cursor: usize,
    pub pending: Option<String>,
    pub menu: Option<MenuView>,
}

#[derive(PartialEq, Clone, Copy)]
pub enum Mode {
    Zhuyin,
    English,
}

struct Menu {
    items: Vec<FixedSpan>,
    page: usize,
    /// 反白的候選（整份清單的索引）
    sel: usize,
}

/// 序列從 a 改成 b：前後相同的部分不動。回傳 a 的詞段在 b 的起點；碰到被換掉的範圍回 None
fn remapper(a: &[String], b: &[String]) -> impl Fn(usize, usize) -> Option<usize> {
    let mut p = 0;
    while p < a.len() && p < b.len() && a[p] == b[p] {
        p += 1;
    }
    let mut s = 0;
    while s < a.len() - p && s < b.len() - p && a[a.len() - 1 - s] == b[b.len() - 1 - s] {
        s += 1;
    }
    let (al, bl) = (a.len(), b.len());
    move |pos, len| {
        if pos + len <= p {
            Some(pos)
        } else if pos >= al - s {
            Some(pos + bl - al)
        } else {
            None
        }
    }
}

pub struct ImeEngine {
    comp: CompositionBuffer,
    pub decoder: Decoder,
    pub adapter: Option<UserAdapter>,
    pub channel: Option<Channel>,
    pub mode: Mode,
    /// X2 的時鐘（毫秒）；None＝系統時間
    pub clock: Option<f64>,
    last: Vec<DecodePath>,
    last_seq: Vec<String>,
    fixed: Vec<FixedSpan>,
    menu: Option<Menu>,
}

impl ImeEngine {
    pub fn new(decoder: Decoder, legal: HashSet<String>, adapter: Option<UserAdapter>) -> Self {
        ImeEngine {
            comp: CompositionBuffer::new(legal),
            decoder,
            adapter,
            channel: None,
            mode: Mode::Zhuyin,
            clock: None,
            last: vec![],
            last_seq: vec![],
            fixed: vec![],
            menu: None,
        }
    }

    fn now(&self) -> f64 {
        self.clock.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as f64
        })
    }

    fn alternatives(&self, seq: &[String]) -> Option<Vec<Vec<Hypothesis>>> {
        self.channel
            .as_ref()
            .map(|c| seq.iter().map(|s| c.expand(s)).collect())
    }

    fn decode_with_adapter(&self) -> Vec<DecodePath> {
        let seq = self.comp.sequence();
        let alts = self.alternatives(seq);
        let key = seq.join(" ");
        let at = self.now();
        let adapt = self.adapter.as_ref().filter(|a| a.enabled);
        // U(w) 每次解碼同一個詞只算一次（TS 每組都重算，值相同）
        let cache = std::cell::RefCell::new(HashMap::<String, f64>::new());
        let modifier = |w: &str, _: usize, _: usize| -> f64 {
            let a = adapt.unwrap();
            if let Some(&u) = cache.borrow().get(w) {
                return u;
            }
            let u = a.modifier_for(&key, w, at);
            cache.borrow_mut().insert(w.to_string(), u);
            u
        };
        let paths = self.decoder.decode(
            seq,
            &DecodeOptions {
                n_best: 4,
                modifier: adapt.map(|_| &modifier as &dyn Fn(&str, usize, usize) -> f64),
                alternatives: alts.as_deref(),
                fixed: &self.fixed,
            },
        );
        // 同樣的字、不同斷詞只留分數最高的那條
        let mut seen = HashSet::new();
        paths
            .into_iter()
            .filter(|p| seen.insert(p.text()))
            .collect()
    }

    /// 組字區有東西（含打到一半的注音）或選字視窗開著
    pub fn is_composing(&self) -> bool {
        !self.comp.is_empty() || self.menu.is_some()
    }

    fn cursor(&self) -> usize {
        self.comp.cursor()
    }

    fn menu_items(&self) -> Vec<FixedSpan> {
        let seq = self.comp.sequence();
        let start = self.cursor().min(seq.len() - 1);
        let alts = self.alternatives(seq);
        let mut exact = vec![];
        let mut corrected: Vec<(FixedSpan, f64)> = vec![];
        for len in (1..=seq.len() - start).rev() {
            for c in self.decoder.span_cands(seq, start, len, alts.as_deref()) {
                let f = FixedSpan {
                    pos: start,
                    len,
                    word: c.word,
                };
                if c.cost == 0.0 {
                    exact.push(f);
                } else {
                    corrected.push((f, c.cost));
                }
            }
        }
        // 照打讀音的詞先列（長詞在前、同長度依詞頻）；L3 更正讀音的詞依代價排在最後
        corrected.sort_by(|x, y| x.1.partial_cmp(&y.1).unwrap());
        exact.extend(corrected.into_iter().map(|(f, _)| f));
        exact
    }

    fn select(&mut self, f: FixedSpan) {
        self.fixed
            .retain(|x| x.pos + x.len <= f.pos || f.pos + f.len <= x.pos);
        self.fixed.push(f);
        self.menu = None;
        self.redecode();
    }

    fn redecode(&mut self) {
        self.last = if self.comp.sequence().is_empty() {
            vec![]
        } else {
            self.decode_with_adapter()
        };
    }

    /// 選字視窗開著時的按鍵（微軟注音）：↓↑ 移反白（跨頁、頭尾循環）、空白／PageDown 下一頁、
    /// PageUp 上一頁（反白移到該頁第一個）、Enter 選反白、數字選本頁第 n 個、Esc／Backspace 關閉
    fn on_menu_key(&mut self, code: &str) -> EngineState {
        let m = self.menu.as_mut().unwrap();
        let n = m.items.len();
        let pages = n.div_ceil(MENU_PAGE);
        let lo = m.page * MENU_PAGE;
        let page_items = &m.items[lo..(lo + MENU_PAGE).min(m.items.len())];
        let digit = code
            .strip_prefix("Digit")
            .and_then(|d| d.parse::<usize>().ok())
            .filter(|d| (1..=9).contains(d));
        if let Some(f) = digit.and_then(|d| page_items.get(d - 1)) {
            let f = f.clone();
            self.select(f);
        } else if code == "Enter" {
            let f = m.items[m.sel].clone();
            self.select(f);
        } else if code == "ArrowDown" || code == "ArrowUp" {
            m.sel = (m.sel + if code == "ArrowDown" { 1 } else { n - 1 }) % n;
            m.page = m.sel / MENU_PAGE;
        } else if code == "Space" || code == "PageDown" || code == "PageUp" {
            m.page = if code == "PageUp" {
                (m.page + pages - 1) % pages
            } else {
                (m.page + 1) % pages
            };
            m.sel = m.page * MENU_PAGE;
        } else if code == "Escape" || code == "Backspace" {
            self.menu = None;
        }
        self.state(true)
    }

    fn on_nav_key(&mut self, code: &str) -> Option<EngineState> {
        let n = self.comp.sequence().len();
        if n == 0 || !self.comp.pending_display().is_empty() {
            return None;
        }
        match code {
            "ArrowLeft" => self.comp.set_cursor(self.cursor().saturating_sub(1)),
            "ArrowRight" => self.comp.set_cursor(self.cursor() + 1),
            "Home" => self.comp.set_cursor(0),
            "End" => self.comp.set_cursor(n),
            "ArrowDown" => {
                let items = self.menu_items();
                if !items.is_empty() {
                    self.menu = Some(Menu {
                        items,
                        page: 0,
                        sel: 0,
                    });
                }
            }
            _ => return None,
        }
        Some(self.state(true))
    }

    pub fn state(&self, last_legal: bool) -> EngineState {
        let pending = self.comp.pending_display();
        EngineState {
            composition: self.with_pending(self.last.first()),
            last_legal,
            text: None,
            cursor: self.cursor(),
            pending: (!pending.is_empty()).then_some(pending),
            menu: self.menu.as_ref().map(|m| MenuView {
                items: m
                    .items
                    .iter()
                    .skip(m.page * MENU_PAGE)
                    .take(MENU_PAGE)
                    .map(|f| f.word.clone())
                    .collect(),
                page: m.page,
                pages: m.items.len().div_ceil(MENU_PAGE),
                cursor: m.sel - m.page * MENU_PAGE,
            }),
        }
    }

    /// 首選文字，打到一半的注音插在游標處（字的索引＝音節索引）
    fn with_pending(&self, path: Option<&DecodePath>) -> String {
        let mut chars: Vec<String> = path
            .map_or(String::new(), |p| p.text())
            .chars()
            .map(String::from)
            .collect();
        chars.insert(self.cursor().min(chars.len()), self.comp.pending_display());
        chars.concat()
    }

    /// 切換注音／英文；組字區未送出的內容先送出
    pub fn toggle_mode(&mut self) -> String {
        let text = self.commit(0);
        self.mode = if self.mode == Mode::Zhuyin {
            Mode::English
        } else {
            Mode::Zhuyin
        };
        text
    }

    fn direct(text: Option<String>) -> EngineState {
        EngineState {
            composition: String::new(),
            last_legal: true,
            text,
            cursor: 0,
            pending: None,
            menu: None,
        }
    }

    /// 一次按鍵。code＝KeyboardEvent.code，key＝KeyboardEvent.key（標點、英文模式用）
    pub fn on_key(&mut self, code: &str, key: Option<&str>) -> EngineState {
        if self.mode == Mode::English {
            return Self::direct(key.filter(|k| k.chars().count() == 1).map(String::from));
        }
        if self.menu.is_some() {
            return self.on_menu_key(code);
        }
        if code == "Escape" {
            self.clear();
            return self.state(true);
        }
        let punct = key.and_then(|k| PUNCT.iter().find(|(p, _)| *p == k).map(|(_, v)| *v));
        let literal = punct.or((code == "Space").then_some(" "));
        let mut inserted = false;
        match literal {
            Some(lit) if self.comp.pending_display().is_empty() => {
                if self.comp.is_empty() {
                    return Self::direct(Some(lit.to_string()));
                }
                inserted = self.comp.push_literal(lit);
            }
            _ if punct.is_some() => return self.state(true),
            _ => {}
        }
        if let Some(st) = self.on_nav_key(code) {
            return st;
        }
        let legal = if inserted {
            true
        } else {
            self.comp.on_key(code)
        };
        let seq = self.comp.sequence().to_vec();
        if seq != self.last_seq {
            // 選字跟著平移；落在被改動範圍內的作廢
            let map = remapper(&self.last_seq, &seq);
            self.fixed = std::mem::take(&mut self.fixed)
                .into_iter()
                .filter_map(|f| map(f.pos, f.len).map(|pos| FixedSpan { pos, ..f }))
                .collect();
            self.last_seq = seq;
            self.redecode();
        }
        self.state(legal)
    }

    /// 送出：解碼（帶 U(w)）→ 學習 → 回傳文字並清空。k>0 改用第 k 候選
    pub fn commit(&mut self, k: usize) -> String {
        if self.comp.sequence().is_empty() {
            return String::new();
        }
        let candidates = self.decode_with_adapter();
        let chosen = candidates.get(k.min(candidates.len().saturating_sub(1)));
        let text = self.with_pending(chosen);
        let at = self.now();
        if let (Some(adapter), Some(chosen)) = (self.adapter.as_mut().filter(|a| a.enabled), chosen)
        {
            // 1) 選字覆寫學習
            for b in &chosen.breakdown {
                if b.word != UNK && !is_literal(&b.reading[0]) {
                    adapter.record_selection(&b.reading, &b.word, at);
                }
            }
            // 2) 造詞挖掘：連續 ≥2 個單字詞 → 新詞；3) 這串字裡有選過的字、或選過的多字詞 → 使用者詞
            // ponytail: 長度取「連續單字」整串（同 TS）；要精確長度再加手動造詞鍵
            let picked: HashSet<(usize, &str)> = self
                .fixed
                .iter()
                .map(|f| (f.pos, f.word.as_str()))
                .collect();
            let mut ops: Vec<(bool, String, Vec<String>)> = vec![]; // (使用者詞?, 詞, 讀音)
            let (mut chars, mut rd, mut any) = (String::new(), vec![], false);
            let flush =
                |ops: &mut Vec<_>, chars: &mut String, rd: &mut Vec<String>, any: &mut bool| {
                    if chars.chars().count() >= 2 {
                        ops.push((*any, std::mem::take(chars), std::mem::take(rd)));
                    }
                    chars.clear();
                    rd.clear();
                    *any = false;
                };
            let mut at_pos = 0;
            for b in &chosen.breakdown {
                let is_picked = picked.contains(&(at_pos, b.word.as_str()));
                // 空格等原樣字元是詞界：不併進造詞
                if b.word == UNK || b.word.chars().count() != 1 || is_literal(&b.reading[0]) {
                    flush(&mut ops, &mut chars, &mut rd, &mut any);
                    if is_picked && b.word.chars().count() > 1 {
                        ops.push((true, b.word.clone(), b.reading.clone()));
                    }
                } else {
                    chars.push_str(&b.word);
                    rd.extend(b.reading.iter().cloned());
                    any |= is_picked;
                }
                at_pos += b.reading.len();
            }
            flush(&mut ops, &mut chars, &mut rd, &mut any);
            let decoder = &mut self.decoder;
            for (user, word, reading) in ops {
                if user {
                    adapter.set_user_phrase(&word, &reading);
                    if !decoder.has_entry(&reading, &word) {
                        decoder.add_entry(&word, &[reading]);
                    }
                } else if !decoder.has_entry(&reading, &word) {
                    adapter.mine_word(&word, &reading);
                    for e in adapter.drain_pending() {
                        decoder.add_entry(&e.word, &e.readings);
                    }
                }
            }
        }
        self.clear();
        text.replace(UNK, "")
    }

    /// 清空組字區，不送出、不學習
    pub fn clear(&mut self) {
        self.comp.reset();
        self.last.clear();
        self.last_seq.clear();
        self.fixed.clear();
        self.menu = None;
    }
}
