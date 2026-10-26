//! 輸入法引擎：packages/cli/src/engine.ts ImeEngine 的移植（注音／英文模式、選字視窗、
//! 游標、標點與原樣 token、Esc、送出學習）。時鐘由呼叫端給（X2 的 at），對拍時固定。
use crate::decode::{is_literal, DecodeOptions, DecodePath, Decoder, FixedSpan, Lattice};
use crate::keymap::Layout;
use crate::l3::{Channel, Hypothesis};
use crate::slots::CompositionBuffer;
use crate::x2::UserAdapter;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};

const UNK: &str = "\u{25A1}";
const MENU_PAGE: usize = 9;
/// 選了也不併進相鄰詞的單字（commit 規則 4；同 engine.ts STANDALONE）
const STANDALONE: &str = "他她它牠祂你妳您我的地得在再那哪這是了著過也都就";
/// 送出時自動存的使用者詞最多幾個字（規則 3、4；同 engine.ts USER_PHRASE_MAX）
const USER_PHRASE_MAX: usize = 6;
/// 送出時自動學的詞，頭尾不能是這些字（規則 2–4；同 engine.ts PARTICLE_EDGE）：STANDALONE 加上語尾助詞
const PARTICLE_EDGE: &str = "他她它牠祂你妳您我的地得在再那哪這是了著過也都就嗎呢吧啊呀喔哦";
/// 自動挖詞（規則 2）最多幾個字（同 engine.ts MINED_MAX）
const MINED_MAX: usize = 4;

/// 頭尾都不是 PARTICLE_EDGE 的字（同 engine.ts edgeOk）
fn edge_ok(w: &str) -> bool {
    let bad = |c: Option<char>| c.is_some_and(|c| PARTICLE_EDGE.contains(c));
    !bad(w.chars().next()) && !bad(w.chars().last())
}

/// 注音模式的全形標點：Ctrl＋原按鍵（KeyboardEvent.code，美式鍵盤）。不加 Ctrl 打出半形（SHIFTED 或交給應用程式）。
/// 『』沒有不加 Shift 的鍵，用 Ctrl+Shift+[ ]
const CTRL_PUNCT: [(&str, &str); 12] = [
    ("Comma", "，"),
    ("Period", "。"),
    ("Slash", "？"),
    ("Semicolon", "："),
    ("Quote", "；"),
    ("Digit1", "！"),
    ("BracketLeft", "「"),
    ("BracketRight", "」"),
    ("Digit9", "（"),
    ("Digit0", "）"),
    ("Backslash", "、"),
    ("Backquote", "～"),
];
/// 美式鍵盤要按 Shift 才打得出的符號：注音模式原樣（半形）輸出，不必切英文
const SHIFTED: &str = "!@#$%^&*()_+{}|:\"<>?~";

/// Ctrl（+Shift）＋code 對應的全形標點
pub fn ctrl_punct(code: &str, shift: bool) -> Option<&'static str> {
    match (code, shift) {
        ("BracketLeft", true) => Some("『"),
        ("BracketRight", true) => Some("』"),
        (_, true) => None,
        _ => CTRL_PUNCT.iter().find(|(c, _)| *c == code).map(|(_, v)| *v),
    }
}

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

/// 數字鍵盤的運算符號（KeyboardEvent.code 去掉 "Numpad"）：和數字一樣原樣輸出（同 engine.ts NUMPAD_OP）
fn numpad_op(name: &str) -> Option<&'static str> {
    match name {
        "Add" => Some("+"),
        "Subtract" => Some("-"),
        "Multiply" => Some("*"),
        "Divide" => Some("/"),
        "Decimal" => Some("."),
        _ => None,
    }
}

/// 選字視窗按 code 之後的（反白, 頁）：↓↑ 移反白（跨頁、頭尾循環）、空白／PageDown 下一頁、
/// PageUp 上一頁（反白移到該頁第一個）、表格裡 ← → 換欄；其他鍵不動
fn menu_move(m: &Menu, code: &str, size: usize) -> (usize, usize) {
    let n = m.items.len();
    let pages = n.div_ceil(size);
    match code {
        "ArrowDown" | "ArrowUp" => {
            let sel = (m.sel + if code == "ArrowDown" { 1 } else { n - 1 }) % n;
            (sel, sel / size)
        }
        "Space" | "PageDown" | "PageUp" => {
            let page = if code == "PageUp" {
                (m.page + pages - 1) % pages
            } else {
                (m.page + 1) % pages
            };
            (page * size, page)
        }
        // 表格（一頁好幾欄，每欄 MENU_PAGE 個）：← → 移到左右那一欄的同一列，那欄比較短就到它最後一個。
        // 本頁最右欄再 → 到下一頁最左欄（最後一頁回到第一頁）；最左欄再 ← 到上一頁最右欄。
        // 第一頁最左欄的 ← 由 PIME 拿去收回表格，不會進到這裡
        "ArrowLeft" | "ArrowRight" if size > MENU_PAGE => {
            let lo = m.page * size;
            let (col, row) = ((m.sel - lo) / MENU_PAGE, (m.sel - lo) % MENU_PAGE);
            let page_end = |p: usize| n.min((p + 1) * size);
            // 第 p 頁第 c 欄同一列（欄短就到最後一個）；那欄不存在回 None
            let at = |p: usize, c: usize| {
                let top = p * size + c * MENU_PAGE;
                (c * MENU_PAGE < size && top < page_end(p))
                    .then(|| (top + row).min(page_end(p) - 1))
            };
            if code == "ArrowRight" {
                at(m.page, col + 1).map(|s| (s, m.page)).unwrap_or_else(|| {
                    let p = (m.page + 1) % pages;
                    (at(p, 0).unwrap(), p)
                })
            } else if col > 0 {
                (at(m.page, col - 1).unwrap(), m.page)
            } else if m.page > 0 {
                // 上一頁是滿的
                (at(m.page - 1, size / MENU_PAGE - 1).unwrap(), m.page - 1)
            } else {
                (m.sel, m.page)
            }
        }
        _ => (m.sel, m.page),
    }
}

/// 序列從 a 改成 b：前後相同的部分不動。回傳 a 的詞段在 b 的起點；碰到被換掉的範圍回 None。
/// edit_at：編輯位置（編輯前後游標的較小者），相同前綴不超過它——疊字旁刪字時只看內容分不出刪哪個（同 TS）
fn remapper(a: &[String], b: &[String], edit_at: usize) -> impl Fn(usize, usize) -> Option<usize> {
    let mut p = 0;
    while p < edit_at && p < a.len() && p < b.len() && a[p] == b[p] {
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
    /// 選字視窗一頁幾個（預設 MENU_PAGE；PIME 表格展開時是好幾行）
    page_size: usize,
    /// 使用紀錄：開著時每次送出往 usage_lines 加一行 JSON（寫檔由宿主做，見 usage_record）
    pub usage: bool,
    pub usage_lines: Vec<String>,
    /// 這次組字按了幾個鍵、幾次退格（使用紀錄用）
    keys: usize,
    backspaces: usize,
    /// 增量解碼的格（每打一個音節只補新的部分）；組字清空、學習開關時作廢
    lattice: RefCell<Lattice>,
    /// 這次組字的 X2 時間：整段固定，增量解碼重用的前綴才和全量相同（半衰期 14 天，差異可忽略）
    decode_at: Cell<Option<f64>>,
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
            page_size: MENU_PAGE,
            usage: false,
            usage_lines: vec![],
            keys: 0,
            backspaces: 0,
            lattice: Default::default(),
            decode_at: Cell::new(None),
        }
    }

    /// 換鍵盤排列：打到一半的注音丟掉（照舊排列打的），L3 鄰鍵照新排列重建
    pub fn set_layout(&mut self, layout: Layout) {
        if self.comp.layout == layout {
            return;
        }
        self.comp.clear_pending();
        self.comp.layout = layout;
        self.channel = self.channel.take().map(|c| c.relayout(layout));
    }

    /// 改一頁的候選數（MENU_PAGE 的倍數）；視窗開著就換到反白所在的那一頁
    pub fn set_page_size(&mut self, n: usize) {
        self.page_size = n;
        if let Some(m) = self.menu.as_mut() {
            m.page = m.sel / n;
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
        self.decode_fixed(&self.fixed, Some(&mut self.lattice.borrow_mut()))
    }

    /// lat：增量解碼用的格；None＝全量（另一組選字，不動格）
    fn decode_fixed(&self, fixed: &[FixedSpan], lat: Option<&mut Lattice>) -> Vec<DecodePath> {
        let seq = self.comp.sequence();
        let alts = self.alternatives(seq);
        let at = self.decode_at.get().unwrap_or_else(|| self.now());
        self.decode_at.set(Some(at));
        let adapt = self.adapter.as_ref().filter(|a| a.enabled);
        // U(w) 每次解碼同一個（詞, 起點, 長度）只算一次（TS 每組都重算，值相同）。
        // 選字紀錄以「該詞的讀音」為鍵（record_selection 存的是詞自己的音節），不是整句
        let cache = std::cell::RefCell::new(HashMap::<(String, usize, usize), f64>::new());
        let modifier = |w: &str, pos: usize, len: usize| -> f64 {
            let a = adapt.unwrap();
            let k = (w.to_string(), pos, len);
            if let Some(&u) = cache.borrow().get(&k) {
                return u;
            }
            let u = a.modifier_for(&seq[pos..pos + len].join(" "), w, at);
            cache.borrow_mut().insert(k, u);
            u
        };
        let o = DecodeOptions {
            n_best: 4,
            modifier: adapt.map(|_| &modifier as &dyn Fn(&str, usize, usize) -> f64),
            alternatives: alts.as_deref(),
            fixed,
        };
        let paths = match lat {
            Some(lat) => self.decoder.decode_in(lat, seq, &o),
            None => self.decoder.decode(seq, &o),
        };
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

    /// 從游標開始的所有候選詞。with_reading：清單最後加上游標後那個音節的注音本身（微軟注音，同 TS）
    fn menu_items(&self, with_reading: bool) -> Vec<FixedSpan> {
        let seq = self.comp.sequence();
        let start = self.cursor().min(seq.len() - 1);
        // 原樣 token（英文、標點、空格）沒有別的字可換
        if is_literal(&seq[start]) {
            return vec![];
        }
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
        let syl = &seq[start];
        if with_reading && !is_literal(syl) {
            exact.push(FixedSpan {
                pos: start,
                len: 1,
                word: syl.clone(),
            });
        }
        exact
    }

    /// 選定候選並重解碼；move_caret：游標移到這段後面（下一個字或詞的開頭，同微軟注音）
    fn select(&mut self, f: FixedSpan, move_caret: bool) {
        self.fixed
            .retain(|x| x.pos + x.len <= f.pos || f.pos + f.len <= x.pos);
        let end = f.pos + f.len;
        self.fixed.push(f);
        self.menu = None;
        self.redecode();
        if move_caret {
            self.comp.set_cursor(end);
        }
    }

    /// 視窗外按 ↑：不開視窗，把從游標開始的那個詞換成清單裡的下一個候選；游標不動、注音本身不參加（同 TS）
    fn cycle_candidate(&mut self) {
        let items = self.menu_items(false);
        if items.is_empty() {
            return;
        }
        let start = self.cursor().min(self.comp.sequence().len() - 1);
        let mut cur = None;
        let mut at = 0;
        for b in self.last.first().map_or(&[][..], |p| &p.breakdown[..]) {
            if at == start {
                cur = Some((at, b.reading.len(), b.word.as_str()));
                break;
            }
            at += b.reading.len();
        }
        let next = if let Some((p, l, w)) = cur {
            let i = items
                .iter()
                .position(|x| x.pos == p && x.len == l && x.word == w);
            i.map_or(0, |i| (i + 1) % items.len())
        } else {
            // 游標在詞中間：換成第一個跟畫面上不同的候選（同 TS）
            let shown = self.shown_chars(self.last.first());
            items
                .iter()
                .position(|x| x.word != shown[x.pos..x.pos + x.len].concat())
                .unwrap_or(0)
        };
        let next = items[next].clone();
        self.select(next, false);
    }

    /// 學習開關：關掉時不學新的、已學到的也不用（加分歸零，使用者詞與挖詞從解碼器拿掉）；打開就放回去
    pub fn set_learning(&mut self, on: bool) {
        let Some(a) = self.adapter.as_mut().filter(|a| a.enabled != on) else {
            return;
        };
        a.enabled = on;
        if on {
            for e in a.drain_pending() {
                self.decoder.add_entry(&e.word, &e.readings);
            }
        } else {
            for e in a.take_entries() {
                self.decoder.remove_entry(&e.word, &e.readings);
            }
        }
        self.reset_lattice();
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
        let size = self.page_size;
        let m = self.menu.as_mut().unwrap();
        let lo = m.page * size;
        let page_items = &m.items[lo..(lo + size).min(m.items.len())];
        // 一頁可能有好幾欄（PIME 表格每欄由上往下 MENU_PAGE 個）：數字選反白那一欄的第 n 個
        let row = (m.sel - lo) / MENU_PAGE * MENU_PAGE;
        let digit = code
            .strip_prefix("Digit")
            .or_else(|| code.strip_prefix("Numpad"))
            .and_then(|d| d.parse::<usize>().ok())
            .filter(|d| (1..=9).contains(d));
        if let Some(f) = digit.and_then(|d| page_items.get(row + d - 1)) {
            let f = f.clone();
            self.select(f, true);
        } else if code == "Enter" {
            let f = m.items[m.sel].clone();
            self.select(f, true);
        } else if matches!(
            code,
            "ArrowDown" | "ArrowUp" | "Space" | "PageDown" | "PageUp" | "ArrowLeft" | "ArrowRight"
        ) {
            (m.sel, m.page) = menu_move(m, code, size);
        } else if code == "Escape" || code == "Backspace" {
            self.menu = None;
        }
        self.state(true)
    }

    /// 選字視窗開著時按 code 之後，畫面那一頁有幾個候選；不改狀態（PIME 要在 filterKeyDown 先送欄數）
    pub fn menu_page_len_after(&self, code: &str) -> Option<usize> {
        let m = self.menu.as_ref()?;
        let (_, page) = menu_move(m, code, self.page_size);
        Some((m.items.len() - page * self.page_size).min(self.page_size))
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
            "ArrowUp" => self.cycle_candidate(),
            "ArrowDown" => {
                let items = self.menu_items(true);
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
            cursor: self.cursor_chars(),
            pending: (!pending.is_empty()).then_some(pending),
            menu: self.menu.as_ref().map(|m| MenuView {
                items: m
                    .items
                    .iter()
                    .skip(m.page * self.page_size)
                    .take(self.page_size)
                    .map(|f| f.word.clone())
                    .collect(),
                page: m.page,
                pages: m.items.len().div_ceil(self.page_size),
                cursor: m.sel - m.page * self.page_size,
            }),
        }
    }

    /// 每個音節在畫面上的字：一般詞一音節一字；字數和音節數不同的詞（原樣 token、選了注音本身）
    /// 整段算在第一個音節上（同 TS shownChars）
    fn shown_chars(&self, path: Option<&DecodePath>) -> Vec<String> {
        let seq = self.comp.sequence();
        let mut out = vec![];
        for b in path.map_or(&[][..], |p| &p.breakdown[..]) {
            if b.word.chars().count() == b.reading.len() {
                out.extend(b.word.chars().map(String::from));
            } else {
                out.push(b.word.clone());
                out.extend(std::iter::repeat_n(String::new(), b.reading.len() - 1));
            }
        }
        if out.len() == seq.len() {
            return out;
        }
        // 沒有解碼結果：音節一個字，原樣 token 照原字
        seq.iter()
            .map(|t| {
                if is_literal(t) {
                    t.clone()
                } else {
                    UNK.to_string()
                }
            })
            .collect()
    }

    /// 游標前的字數（照 path 畫面上的字算）
    fn cursor_chars_in(&self, path: Option<&DecodePath>) -> usize {
        self.shown_chars(path)[..self.cursor()]
            .iter()
            .map(|c| c.chars().count())
            .sum()
    }

    fn cursor_chars(&self) -> usize {
        self.cursor_chars_in(self.last.first())
    }

    /// 首選文字，打到一半的注音插在游標處
    fn with_pending(&self, path: Option<&DecodePath>) -> String {
        let mut chars: Vec<String> = path
            .map_or(String::new(), |p| p.text())
            .chars()
            .map(String::from)
            .collect();
        chars.insert(
            self.cursor_chars_in(path).min(chars.len()),
            self.comp.pending_display(),
        );
        chars.concat()
    }

    /// 切換注音／英文。組字區不送出：接著打的英文併進組字區（on_key），後打的字還能改前面的中文；
    /// 整段在 Enter、或英文模式下打空白／標點時送出
    pub fn toggle_mode(&mut self) {
        self.mode = if self.mode == Mode::Zhuyin {
            Mode::English
        } else {
            Mode::Zhuyin
        };
        // 打到一半的注音不成字：切到英文就丟掉，接著打的英文直接進來（同 TS）
        if self.mode == Mode::English {
            self.comp.clear_pending();
        }
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

    /// 一次按鍵。code＝KeyboardEvent.code，key＝KeyboardEvent.key（標點、英文模式用），shift＝Shift 按著
    pub fn on_key(&mut self, code: &str, key: Option<&str>, shift: bool) -> EngineState {
        self.keys += 1;
        self.backspaces += (code == "Backspace") as usize;
        if self.menu.is_some() {
            return self.on_menu_key(code);
        }
        let before = self.cursor();
        // 注音模式的 Shift＋字母：照英文模式打出字母（大小寫照 CapsLock）。只按 CapsLock 仍打注音
        if self.mode == Mode::English || shift && code.starts_with("Key") {
            let ch = key.filter(|k| k.chars().count() == 1);
            if self.comp.is_empty() {
                return Self::direct(ch.map(String::from));
            }
            // 組字中打英文：字母、數字併進組字區的英文 token（LM 當 EN_CLASS 看），
            // 前面的中文跟著重解碼；有打到一半的注音時不收
            match ch {
                Some(c) if c.chars().all(|x| x.is_ascii_alphanumeric()) => {
                    if !self.comp.append_english(c) {
                        return self.state(true);
                    }
                    return self.after_edit(true, before);
                }
                // 空白、標點等其他字元：整段送出，再輸出這個字元
                Some(c) => return Self::direct(Some(self.commit(0) + c)),
                // 其他鍵（退格、Delete、方向鍵、↓ 選字、Esc）照注音模式處理
                None => {}
            }
        }
        if code == "Escape" {
            self.clear();
            return self.state(true);
        }
        let punct = key.filter(|k| k.len() == 1 && SHIFTED.contains(*k));
        // 數字鍵盤的數字：和標點一樣當原樣字元（大千的數字鍵是注音，數字只能從這裡打）
        let numpad = code
            .strip_prefix("Numpad")
            .filter(|d| d.len() == 1 && d.as_bytes()[0].is_ascii_digit());
        let punct = punct
            .or(numpad)
            .or(code.strip_prefix("Numpad").and_then(numpad_op));
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
        self.after_edit(legal, before)
    }

    /// 直接打一個標點（Ctrl 組合的全形標點）：組字區空就輸出，否則插在游標處；
    /// 選字視窗開著或有打到一半的注音時不收（同 on_key 的標點）
    pub fn on_punct(&mut self, lit: &str) -> EngineState {
        self.keys += 1;
        if self.menu.is_some() || !self.comp.pending_display().is_empty() {
            return self.state(true);
        }
        if self.comp.is_empty() {
            return Self::direct(Some(lit.to_string()));
        }
        let before = self.cursor();
        let ok = self.comp.push_literal(lit);
        self.after_edit(ok, before)
    }

    /// 組字區改過之後：已完成音節序列有變就平移選字、重解碼。before：編輯前的游標
    fn after_edit(&mut self, legal: bool, before: usize) -> EngineState {
        let seq = self.comp.sequence().to_vec();
        if seq != self.last_seq {
            // 選字跟著平移；落在被改動範圍內的作廢
            let map = remapper(&self.last_seq, &seq, before.min(self.cursor()));
            self.fixed = std::mem::take(&mut self.fixed)
                .into_iter()
                .filter_map(|f| map(f.pos, f.len).map(|pos| FixedSpan { pos, ..f }))
                .collect();
            self.last_seq = seq;
            self.redecode();
        }
        self.state(legal)
    }

    /// 送出：解碼（帶 U(w)）→ 學習 → 回傳文字並清空。k>0 改用第 k 候選。
    /// 打到一半的注音不送出（還沒成字），跟著組字區一起丟掉（同 TS）
    pub fn commit(&mut self, k: usize) -> String {
        if self.comp.sequence().is_empty() {
            self.clear();
            return String::new();
        }
        let candidates = self.decode_with_adapter();
        let chosen = candidates.get(k.min(candidates.len().saturating_sub(1)));
        let text = chosen.map_or(String::new(), |p| p.text());
        let at = self.now();
        if self.usage {
            if let Some(chosen) = chosen {
                let line = self.usage_record(chosen, at);
                self.usage_lines.push(line);
            }
        }
        if let (Some(adapter), Some(chosen)) = (self.adapter.as_mut().filter(|a| a.enabled), chosen)
        {
            // 選了注音本身（清單最後一項）的段落：和原樣字元一樣不學，免得注音變成使用者詞（同 TS）
            let opaque = |b: &crate::decode::WordBreakdown| {
                b.word == UNK
                    || is_literal(&b.reading[0])
                    || (b.reading.len() == 1 && b.word == b.reading[0])
            };
            // 1) 選字覆寫學習
            for b in &chosen.breakdown {
                if !opaque(b) {
                    adapter.record_selection(&b.reading, &b.word, at);
                }
            }
            // 2) 造詞挖掘：連續 2–4 個單字詞、頭尾不是虛字 → 記一次，兩次送出都出現才入格；
            // 3) 這串字裡有選過的字（頭尾不是虛字）、或選過的多字詞 → 使用者詞
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
                    let n = chars.chars().count();
                    // 選過的字太長的一串不存、挖詞最多 MINED_MAX 字（多半是整句沒斷好）；頭尾是虛字的不存
                    let max = if *any { USER_PHRASE_MAX } else { MINED_MAX };
                    if n >= 2 && n <= max && edge_ok(chars) {
                        ops.push((*any, std::mem::take(chars), std::mem::take(rd)));
                    }
                    chars.clear();
                    rd.clear();
                    *any = false;
                };
            let mut at_pos = 0;
            let mut picked_at = vec![];
            for b in &chosen.breakdown {
                let is_picked = picked.contains(&(at_pos, b.word.as_str()));
                picked_at.push(is_picked);
                // 空格等原樣字元是詞界：不併進造詞
                if opaque(b) || b.word.chars().count() != 1 {
                    flush(&mut ops, &mut chars, &mut rd, &mut any);
                    if is_picked && b.word.chars().count() > 1 && !opaque(b) {
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

            // 4) 選過的單字左右都是多字詞（狀態|欄）：併進相鄰的詞存成使用者詞，
            //    左邊優先，合起來 ≤ USER_PHRASE_MAX 字，不跨原樣字元與 □（同 TS）
            let bd = &chosen.breakdown;
            let len = |i: usize| bd[i].word.chars().count();
            let real = |i: Option<usize>| i.filter(|&i| i < bd.len()).filter(|&i| !opaque(&bd[i]));
            let host =
                |i: Option<usize>| real(i).filter(|&i| len(i) >= 2 && len(i) < USER_PHRASE_MAX);
            for i in 0..bd.len() {
                if !picked_at[i]
                    || real(Some(i)).is_none()
                    || len(i) != 1
                    || STANDALONE.contains(bd[i].word.as_str())
                {
                    continue;
                }
                let single = |j: Option<usize>| real(j).is_some_and(|j| len(j) == 1);
                if single(i.checked_sub(1)) || single(Some(i + 1)) {
                    continue;
                }
                let (w, r) = (&bd[i].word, &bd[i].reading);
                // 合起來的詞頭尾是虛字就不存
                if let Some(h) = host(i.checked_sub(1)) {
                    let h = &bd[h];
                    let word = format!("{}{w}", h.word);
                    if edge_ok(&word) {
                        ops.push((true, word, [&h.reading[..], r].concat()));
                    }
                } else if let Some(h) = host(Some(i + 1)) {
                    let h = &bd[h];
                    let word = format!("{w}{}", h.word);
                    if edge_ok(&word) {
                        ops.push((true, word, [r, &h.reading[..]].concat()));
                    }
                }
            }
            let decoder = &mut self.decoder;
            // 同一次送出裡重複出現的挖詞只算一次（挖詞要兩次送出都出現才入格，x2.rs MINED_MIN_FREQ）
            let mut mined_now = HashSet::new();
            for (user, word, reading) in ops {
                if user {
                    adapter.set_user_phrase(&word, &reading);
                    if !decoder.has_entry(&reading, &word) {
                        decoder.add_entry(&word, &[reading]);
                    }
                } else if !decoder.has_entry(&reading, &word) && mined_now.insert(word.clone()) {
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

    /// 使用紀錄的一行（每次送出）：
    /// t 時間（毫秒）、syl 實際打出的音節（打錯照記）、top1 沒選字時的第一名、out 送出的字、
    /// picks 用 ↓ 改過的段落（pos／len 是音節位置，from 是 top1 在那段的字）、
    /// l3 被 L3 改掉讀音的音節 [觀察, 採用]、bs 退格次數、keys 按鍵數
    fn usage_record(&self, chosen: &DecodePath, at: f64) -> String {
        let seq = self.comp.sequence();
        // 有選字時另外解碼一次（不帶選字）才知道原本的第一名
        let top = (!self.fixed.is_empty())
            .then(|| self.decode_fixed(&[], None).into_iter().next())
            .flatten();
        let top = top.as_ref().unwrap_or(chosen);
        let span_text = |p: &DecodePath, pos: usize, len: usize| {
            let mut at = 0;
            let mut out = String::new();
            for b in &p.breakdown {
                let n = b.reading.len();
                if at < pos + len && at + n > pos {
                    out += &b.word;
                }
                at += n;
            }
            out
        };
        let picks: Vec<Value> = self
            .fixed
            .iter()
            .map(|f| json!({"pos": f.pos, "len": f.len, "from": span_text(top, f.pos, f.len), "to": f.word}))
            .collect();
        let mut l3 = vec![];
        let mut pos = 0;
        for b in &chosen.breakdown {
            for (j, r) in b.reading.iter().enumerate() {
                if seq.get(pos + j).is_some_and(|o| o != r) {
                    l3.push(json!([seq[pos + j], r]));
                }
            }
            pos += b.reading.len();
        }
        json!({
            "t": at as u64,
            "syl": seq.join(" "),
            "top1": top.text().replace(UNK, ""),
            "out": chosen.text().replace(UNK, ""),
            "picks": picks,
            "l3": l3,
            "bs": self.backspaces,
            "keys": self.keys,
        })
        .to_string()
    }

    /// 清空組字區，不送出、不學習
    pub fn clear(&mut self) {
        self.keys = 0;
        self.backspaces = 0;
        self.comp.reset();
        self.last.clear();
        self.last_seq.clear();
        self.fixed.clear();
        self.menu = None;
        self.reset_lattice();
    }

    /// U(w) 變了（學習開關、新的組字）：格與 X2 時間重來
    fn reset_lattice(&mut self) {
        *self.lattice.get_mut() = Lattice::default();
        self.decode_at.set(None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{engine, type_syllables};

    const LEX: &[(&str, &str)] = &[
        ("ㄋㄧˇ", "你"),
        ("ㄋㄧˇ", "擬"),
        ("ㄏㄠˇ", "好"),
        ("ㄏㄠˇ", "號"),
        ("ㄋㄧˇ ㄏㄠˇ", "你好"),
        ("ㄌㄢˊ", "欄"),
        ("ㄨㄟˋ", "位"),
        ("ㄨㄛˇ", "我"),
    ];

    fn rd(s: &str) -> Vec<String> {
        s.split(' ').map(String::from).collect()
    }

    #[test]
    fn ctrl_punct_table() {
        assert_eq!(ctrl_punct("Comma", false), Some("，"));
        assert_eq!(ctrl_punct("Digit1", false), Some("！"));
        assert_eq!(ctrl_punct("Backquote", false), Some("～"));
        assert_eq!(ctrl_punct("BracketLeft", true), Some("『"));
        assert_eq!(ctrl_punct("BracketRight", true), Some("』"));
        assert_eq!(ctrl_punct("Comma", true), None);
        assert_eq!(ctrl_punct("KeyA", false), None);
    }

    #[test]
    fn particle_edges() {
        assert!(edge_ok("狀態") && edge_ok("欄位") && edge_ok(""));
        assert!(!edge_ok("我們") && !edge_ok("好嗎") && !edge_ok("的話"));
        // 只看頭尾
        assert!(edge_ok("看的書"));
        for c in STANDALONE.chars() {
            assert!(PARTICLE_EDGE.contains(c), "{c}");
        }
    }

    #[test]
    fn remapper_shifts_spans_outside_the_edit() {
        // 中間插一個：前面不動、後面平移、跨過編輯點的作廢
        let m = remapper(&rd("a b c"), &rd("a x b c"), 1);
        assert_eq!((m(0, 1), m(1, 2), m(0, 2)), (Some(0), Some(2), None));
        // 疊字旁刪字：在 0 刪了一個 a，相同前綴不超過編輯位置，所以作廢的是第一個 a
        let m = remapper(&rd("a a b"), &rd("a b"), 0);
        assert_eq!((m(0, 1), m(1, 1), m(2, 1)), (None, Some(0), Some(1)));
    }

    #[test]
    fn menu_moves() {
        let items = |n: usize| {
            (0..n)
                .map(|i| FixedSpan {
                    pos: 0,
                    len: 1,
                    word: i.to_string(),
                })
                .collect()
        };
        let menu = |page, sel| Menu {
            items: items(20),
            page,
            sel,
        };
        let m = menu(0, 0);
        // ↑ 從頭循環到尾、跨頁
        assert_eq!(menu_move(&m, "ArrowUp", 9), (19, 2));
        assert_eq!(menu_move(&m, "ArrowDown", 9), (1, 0));
        assert_eq!(menu_move(&m, "Space", 9), (9, 1));
        assert_eq!(menu_move(&m, "PageUp", 9), (18, 2));
        // 單欄時 ← → 不動
        assert_eq!(menu_move(&m, "ArrowRight", 9), (0, 0));
        // 表格（一頁 2 欄＝18 個）：→ 到右欄同一列，最右欄再 → 到下一頁；那欄短就到它最後一個
        assert_eq!(menu_move(&menu(0, 3), "ArrowRight", 18), (12, 0));
        assert_eq!(menu_move(&menu(0, 12), "ArrowRight", 18), (19, 1));
        // 最左欄再 ← 到上一頁最右欄的同一列
        assert_eq!(menu_move(&menu(1, 19), "ArrowLeft", 18), (10, 0));
        assert_eq!(menu_move(&menu(1, 19), "Escape", 18), (19, 1));
    }

    #[test]
    fn type_and_commit() {
        let mut e = engine(LEX);
        type_syllables(&mut e, "ㄋㄧˇ ㄏㄠˇ");
        let st = e.state(true);
        assert_eq!((st.composition.as_str(), st.cursor), ("你好", 2));
        e.on_key("KeyC", None, false);
        let st = e.state(true);
        assert_eq!(
            (st.composition.as_str(), st.pending.as_deref()),
            ("你好ㄏ", Some("ㄏ"))
        );
        // 打到一半的注音不送出
        assert_eq!(e.commit(0), "你好");
        assert!(!e.is_composing());
        type_syllables(&mut e, "ㄋㄧˇ");
        e.on_key("Escape", None, false);
        assert!(!e.is_composing());
    }

    #[test]
    fn direct_output_when_empty() {
        let mut e = engine(LEX);
        let text = |st: EngineState| st.text;
        assert_eq!(
            text(e.on_key("Space", Some(" "), false)).as_deref(),
            Some(" ")
        );
        assert_eq!(
            text(e.on_key("Digit1", Some("!"), true)).as_deref(),
            Some("!")
        );
        assert_eq!(
            text(e.on_key("Numpad5", Some("5"), false)).as_deref(),
            Some("5")
        );
        assert_eq!(
            text(e.on_key("NumpadAdd", Some("+"), false)).as_deref(),
            Some("+")
        );
        assert_eq!(
            text(e.on_key("KeyA", Some("A"), true)).as_deref(),
            Some("A")
        );
        assert_eq!(text(e.on_punct("，")).as_deref(), Some("，"));
        assert!(!e.is_composing());
    }

    #[test]
    fn literals_inside_composition() {
        let mut e = engine(LEX);
        type_syllables(&mut e, "ㄋㄧˇ ㄏㄠˇ");
        e.on_key("Digit1", Some("!"), true);
        e.on_punct("，");
        e.on_key("Numpad7", Some("7"), false);
        assert_eq!(e.state(true).composition, "你好!，7");
        // 有打到一半的注音時標點不收
        e.on_key("KeyS", None, false);
        e.on_punct("。");
        assert_eq!(e.state(true).composition, "你好!，7ㄋ");
        e.on_key("Backspace", None, false);
        assert_eq!(e.commit(0), "你好!，7");
    }

    #[test]
    fn english_inside_composition() {
        let mut e = engine(LEX);
        type_syllables(&mut e, "ㄋㄧˇ");
        // 注音模式的 Shift＋字母
        e.on_key("KeyA", Some("A"), true);
        assert_eq!(e.state(true).composition, "你A");
        e.on_key("KeyS", None, false);
        e.toggle_mode();
        // 切到英文：打到一半的注音丟掉，字母、數字併進英文 token
        assert_eq!(e.state(true).pending, None);
        e.on_key("KeyB", Some("b"), false);
        e.on_key("Digit2", Some("2"), false);
        let st = e.state(true);
        assert_eq!((st.composition.as_str(), st.cursor), ("你Ab2", 4));
        e.on_key("Backspace", None, false);
        assert_eq!(e.state(true).composition, "你Ab");
        // 英文模式的空白：整段送出再接空白
        let st = e.on_key("Space", Some(" "), false);
        assert_eq!(st.text.as_deref(), Some("你Ab "));
        assert!(!e.is_composing());
        let st = e.on_key("KeyC", Some("c"), false);
        assert_eq!(st.text.as_deref(), Some("c"));
    }

    #[test]
    fn cursor_moves_and_insert_in_middle() {
        let mut e = engine(LEX);
        type_syllables(&mut e, "ㄋㄧˇ ㄏㄠˇ");
        e.on_key("Home", None, false);
        assert_eq!(e.state(true).cursor, 0);
        e.on_key("ArrowRight", None, false);
        type_syllables(&mut e, "ㄨㄛˇ");
        let st = e.state(true);
        assert_eq!((st.composition.as_str(), st.cursor), ("你我好", 2));
        e.on_key("End", None, false);
        assert_eq!(e.state(true).cursor, 3);
    }

    #[test]
    fn menu_pick_saves_user_phrase() {
        let mut e = engine(LEX);
        type_syllables(&mut e, "ㄋㄧˇ ㄏㄠˇ");
        // 游標在最後：清單從最後一個音節開始；最後一項是注音本身
        let st = e.on_key("ArrowDown", None, false);
        assert_eq!(st.menu.unwrap().items, ["好", "號", "ㄏㄠˇ"]);
        e.on_key("Escape", None, false);
        e.on_key("Home", None, false);
        let st = e.on_key("ArrowDown", None, false);
        assert_eq!(st.menu.unwrap().items, ["你好", "你", "擬", "ㄋㄧˇ"]);
        let st = e.on_key("Digit3", None, false);
        assert!(st.menu.is_none());
        assert_eq!((st.composition.as_str(), st.cursor), ("擬好", 1));
        assert_eq!(e.commit(0), "擬好");
        // 選過的字所在的單字串存成使用者詞，下次直接贏過 你好
        assert!(e.decoder.has_entry(&rd("ㄋㄧˇ ㄏㄠˇ"), "擬好"));
        assert_eq!(e.adapter.as_ref().unwrap().stats().2, 1);
        type_syllables(&mut e, "ㄋㄧˇ ㄏㄠˇ");
        assert_eq!(e.state(true).composition, "擬好");
        // 關掉學習：使用者詞拿掉、加分歸零；打開放回去
        e.set_learning(false);
        assert!(!e.decoder.has_entry(&rd("ㄋㄧˇ ㄏㄠˇ"), "擬好"));
        assert_eq!(e.state(true).composition, "你好");
        e.set_learning(true);
        assert_eq!(e.state(true).composition, "擬好");
    }

    #[test]
    fn arrow_up_cycles_candidates() {
        let mut e = engine(LEX);
        type_syllables(&mut e, "ㄋㄧˇ ㄏㄠˇ");
        e.on_key("Home", None, false);
        e.on_key("ArrowUp", None, false);
        e.on_key("ArrowUp", None, false);
        let st = e.state(true);
        assert!(st.menu.is_none());
        assert_eq!((st.composition.as_str(), st.cursor), ("擬好", 0));
    }

    #[test]
    fn mined_words_need_two_commits_and_clean_edges() {
        let mut e = engine(LEX);
        let r = rd("ㄌㄢˊ ㄨㄟˋ");
        for i in 0..2 {
            assert!(!e.decoder.has_entry(&r, "欄位"), "第 {i} 次送出前");
            type_syllables(&mut e, "ㄌㄢˊ ㄨㄟˋ");
            assert_eq!(e.commit(0), "欄位");
        }
        assert!(e.decoder.has_entry(&r, "欄位"));
        // 頭尾是虛字（我）的不挖
        for _ in 0..3 {
            type_syllables(&mut e, "ㄨㄛˇ ㄌㄢˊ");
            e.commit(0);
        }
        assert!(!e.decoder.has_entry(&rd("ㄨㄛˇ ㄌㄢˊ"), "我欄"));
        assert_eq!(e.adapter.as_ref().unwrap().stats().3, 1);
    }

    #[test]
    fn usage_log_line() {
        let mut e = engine(LEX);
        e.usage = true;
        type_syllables(&mut e, "ㄋㄧˇ ㄏㄠˇ");
        e.on_key("KeyC", None, false);
        e.on_key("Backspace", None, false);
        e.on_key("Home", None, false);
        e.on_key("ArrowDown", None, false);
        e.on_key("Digit3", None, false);
        e.commit(0);
        let v: Value = serde_json::from_str(&e.usage_lines[0]).unwrap();
        assert_eq!(v["syl"], "ㄋㄧˇ ㄏㄠˇ");
        assert_eq!(v["top1"], "你好");
        assert_eq!(v["out"], "擬好");
        assert_eq!(
            v["picks"],
            json!([{"pos": 0, "len": 1, "from": "你好", "to": "擬"}])
        );
        assert_eq!((v["bs"].as_u64(), v["keys"].as_u64()), (Some(1), Some(11)));
        assert_eq!(v["t"], 1_700_000_000_000u64);
    }
}
