//! L1 鍵盤映射（大千、倚天、許氏、IBM、倚天 26 鍵，見 Layout）與注音符號分類（core/src/index.ts）。

pub const INITIALS: [&str; 21] = [
    "ㄅ", "ㄆ", "ㄇ", "ㄈ", "ㄉ", "ㄊ", "ㄋ", "ㄌ", "ㄍ", "ㄎ", "ㄏ", "ㄐ", "ㄑ", "ㄒ", "ㄓ", "ㄔ",
    "ㄕ", "ㄖ", "ㄗ", "ㄘ", "ㄙ",
];
pub const MEDIALS: [&str; 3] = ["ㄧ", "ㄨ", "ㄩ"];
pub const FINALS: [&str; 13] = [
    "ㄚ", "ㄛ", "ㄜ", "ㄝ", "ㄞ", "ㄟ", "ㄠ", "ㄡ", "ㄢ", "ㄣ", "ㄤ", "ㄥ", "ㄦ",
];
/// 聲調 1–5 的標記（一聲沒有標記）
pub const MARKS: [&str; 5] = ["", "ˊ", "ˇ", "ˋ", "˙"];

/// 槽位：0 聲母、1 介音、2 韻母
pub fn slot_of(s: &str) -> Option<usize> {
    if INITIALS.contains(&s) {
        Some(0)
    } else if MEDIALS.contains(&s) {
        Some(1)
    } else if FINALS.contains(&s) {
        Some(2)
    } else {
        None
    }
}

/// 鍵盤排列。鍵位照 libchewing v0.5.1 `src/common/key2pho.c` 的 `key_str`
/// （41 個字元，依序對應 ㄅ…ㄙ、ㄧㄨㄩ、ㄚ…ㄦ、˙ˊˇˋ；空白一律是一聲）。
/// 許氏、倚天 26 鍵一鍵多音，同一音節內依已打的槽位判斷，規則照 libchewing `src/bopomofo.c`
/// 的 HsuPhoInput／ET26PhoInput（見 `pick`、`on_symbol`、`on_end`）
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Layout {
    #[default]
    Dachen,
    Eten,
    Hsu,
    Ibm,
    Eten26,
}

/// （排列、config.json 的 layout 值、選單名稱）
pub const LAYOUTS: [(Layout, &str, &str); 5] = [
    (Layout::Dachen, "dachen", "大千"),
    (Layout::Eten, "eten", "倚天"),
    (Layout::Hsu, "hsu", "許氏"),
    (Layout::Ibm, "ibm", "IBM"),
    (Layout::Eten26, "eten26", "倚天 26 鍵"),
];

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mapped {
    Symbol(&'static str),
    Tone(u8),
    Unmapped,
}

/// key_str 第 i 個位置的符號
fn ph(i: usize) -> Mapped {
    match i {
        0..=20 => Mapped::Symbol(INITIALS[i]),
        21..=23 => Mapped::Symbol(MEDIALS[i - 21]),
        24..=36 => Mapped::Symbol(FINALS[i - 24]),
        _ => Mapped::Tone([5, 2, 3, 4][i - 37]),
    }
}

/// key_str 的字元 → event.code（美式鍵盤）
fn char_code(c: char) -> String {
    match c {
        'a'..='z' => format!("Key{}", c.to_ascii_uppercase()),
        '0'..='9' => format!("Digit{c}"),
        '-' => "Minus".into(),
        '=' => "Equal".into(),
        ';' => "Semicolon".into(),
        '\'' => "Quote".into(),
        ',' => "Comma".into(),
        '.' => "Period".into(),
        '/' => "Slash".into(),
        _ => unreachable!("{c}"),
    }
}

fn initial_shift3(p: &mut [Option<&'static str>; 3], from: &[&str]) {
    if let Some(i) = p[0].filter(|c| from.contains(c)) {
        let k = INITIALS.iter().position(|x| *x == i).unwrap();
        p[0] = Some(INITIALS[k + 3]);
    }
}

impl Layout {
    pub fn from_name(s: &str) -> Option<Layout> {
        LAYOUTS.iter().find(|(_, n, _)| *n == s).map(|(l, _, _)| *l)
    }

    pub fn name(self) -> &'static str {
        LAYOUTS.iter().find(|(l, _, _)| *l == self).unwrap().1
    }

    fn key_str(self) -> &'static str {
        match self {
            Layout::Dachen => "1qaz2wsxedcrfv5tgbyhnujm8ik,9ol.0p;/-7634",
            Layout::Hsu => "bpmfdtnlgkhjvcjvcrzasexuyhgeiawomnkllsdfj",
            Layout::Ibm => "1234567890-qwertyuiopasdfghjkl;zxcvbn/m,.",
            Layout::Eten => "bpmfdtnlvkhg7c,./j;'sexuaorwiqzy890-=1234",
            Layout::Eten26 => "bpmfdtnlvkhgvcgycjqwsexuaorwiqzpmntlhdfjk",
        }
    }

    /// 這個鍵的所有意義（key_str 順序）；空白＝一聲
    pub fn meanings(self, code: &str) -> Vec<Mapped> {
        if code == "Space" {
            return vec![Mapped::Tone(1)];
        }
        self.key_str()
            .chars()
            .enumerate()
            .filter(|(_, c)| char_code(*c) == code)
            .map(|(i, _)| ph(i))
            .collect()
    }

    /// 打出符號或聲調要按的鍵
    pub fn code_of(self, m: Mapped) -> Option<String> {
        if m == Mapped::Tone(1) {
            return Some("Space".into());
        }
        let i = (0..41).find(|&i| ph(i) == m)?;
        Some(char_code(self.key_str().chars().nth(i)?))
    }

    /// 組字區的槽位為 p 時按下 code 的意義
    pub fn map_key(self, code: &str, p: &[Option<&'static str>; 3]) -> Mapped {
        let m = self.meanings(code);
        if !matches!(self, Layout::Hsu | Layout::Eten26) || m.len() < 2 {
            return m.first().copied().unwrap_or(Mapped::Unmapped);
        }
        // 已有符號時，兼聲調的鍵是聲調鍵（IsHsuPhoEndKey）
        let started = p.iter().any(Option::is_some);
        if started {
            if let Some(t) = m.iter().find(|x| matches!(x, Mapped::Tone(_))) {
                return *t;
            }
        }
        // 已有聲母或介音時，兼韻母的聲母鍵當韻母；許氏的 E 已有介音時是 ㄝ
        let second = match (self, m[0]) {
            (Layout::Hsu, Mapped::Symbol("ㄧ")) => p[1].is_some(),
            (Layout::Hsu, Mapped::Symbol(s)) => {
                ["ㄇ", "ㄋ", "ㄌ", "ㄍ", "ㄎ", "ㄏ", "ㄘ"].contains(&s)
                    && (p[0].is_some() || p[1].is_some())
            }
            (_, Mapped::Symbol(s)) => {
                ["ㄆ", "ㄇ", "ㄊ", "ㄋ", "ㄌ", "ㄏ", "ㄗ", "ㄘ"].contains(&s)
                    && (p[0].is_some() || p[1].is_some())
            }
            _ => false,
        };
        // libchewing 取第二個意義時只看介音、韻母（ㄐ/ㄓ 這種兩個都是聲母的不會走到這裡）
        if second {
            if let Some(s) = m[1..]
                .iter()
                .find(|x| matches!(x, Mapped::Symbol(s) if slot_of(s) != Some(0)))
            {
                return *s;
            }
        }
        m[0]
    }

    /// 放入符號 s 之前調整已有的槽位
    pub fn on_symbol(self, p: &mut [Option<&'static str>; 3], s: &str) {
        let slot = slot_of(s);
        match self {
            Layout::Hsu => {
                if p[0] == Some("ㄍ") && matches!(p[1], Some("ㄧ" | "ㄩ")) {
                    p[0] = Some("ㄐ");
                }
                // ㄐㄑㄒ 後面只能接 ㄧㄩ，接 ㄨ 或直接接韻母就是 ㄓㄔㄕ
                if s == "ㄨ" || slot == Some(2) && p[1].is_none() {
                    initial_shift3(p, &["ㄐ", "ㄑ", "ㄒ"]);
                }
            }
            Layout::Eten26 => {
                if s == "ㄨ" || slot == Some(2) && p[1].is_none() {
                    initial_shift3(p, &["ㄐ", "ㄒ"]);
                } else if slot == Some(1) && p[0] == Some("ㄍ") {
                    p[0] = Some("ㄑ");
                }
            }
            _ => {}
        }
    }

    /// 按聲調鍵之前調整槽位：只有聲母時換成同鍵的韻母或 ㄓㄔㄕ
    pub fn on_end(self, p: &mut [Option<&'static str>; 3]) {
        let (shift, to_final): (&[&str], &[(&str, &str)]) = match self {
            Layout::Hsu => (
                &["ㄐ", "ㄑ", "ㄒ"],
                &[
                    ("ㄏ", "ㄛ"),
                    ("ㄍ", "ㄜ"),
                    ("ㄇ", "ㄢ"),
                    ("ㄋ", "ㄣ"),
                    ("ㄎ", "ㄤ"),
                    ("ㄌ", "ㄦ"),
                ],
            ),
            Layout::Eten26 => (
                &["ㄐ", "ㄒ"],
                &[
                    ("ㄆ", "ㄡ"),
                    ("ㄇ", "ㄢ"),
                    ("ㄋ", "ㄣ"),
                    ("ㄊ", "ㄤ"),
                    ("ㄌ", "ㄥ"),
                    ("ㄏ", "ㄦ"),
                ],
            ),
            _ => return,
        };
        if p[1].is_none() && p[2].is_none() {
            if let Some(&(_, f)) = to_final.iter().find(|(c, _)| p[0] == Some(*c)) {
                *p = [None, None, Some(f)];
            } else {
                initial_shift3(p, shift);
            }
        }
        if self == Layout::Hsu && p[0] == Some("ㄍ") && matches!(p[1], Some("ㄧ" | "ㄩ")) {
            p[0] = Some("ㄐ");
        }
    }

    /// 正規形音節 → 鍵碼序列（C-M-F 後按聲調鍵）
    pub fn syllable_to_key_codes(self, syl: &str) -> Vec<String> {
        let mut chars: Vec<char> = syl.chars().collect();
        let mut tone = 1;
        if let Some(last) = chars.last() {
            if let Some(i) = MARKS[1..].iter().position(|m| m.starts_with(*last)) {
                tone = i as u8 + 2;
                chars.pop();
            }
        }
        let mut out: Vec<String> = chars
            .iter()
            .filter_map(|ch| {
                let s = ch.to_string();
                let s = INITIALS
                    .iter()
                    .chain(&MEDIALS)
                    .chain(&FINALS)
                    .find(|x| **x == s)?;
                self.code_of(Mapped::Symbol(s))
            })
            .collect();
        out.push(self.code_of(Mapped::Tone(tone)).unwrap());
        out
    }
}

/// 實體鍵盤幾何（l3.ts ROWS）：鍵中心距離 ≤1.3 視為相鄰
fn key_pos(code: &str) -> Option<(f64, f64)> {
    for (y, (off, codes)) in key_rows().iter().enumerate() {
        if let Some(i) = codes.iter().position(|c| c == code) {
            return Some((i as f64 + off, y as f64));
        }
    }
    None
}

fn key_rows() -> [(f64, Vec<String>); 4] {
    let keys = |s: &str| s.chars().map(|c| format!("Key{c}")).collect::<Vec<_>>();
    let mut r0: Vec<String> = "1234567890".chars().map(|d| format!("Digit{d}")).collect();
    r0.extend(["Minus".into(), "Equal".into()]);
    let mut r1 = keys("QWERTYUIOP");
    r1.push("BracketLeft".into());
    let mut r2 = keys("ASDFGHJKL");
    r2.extend(["Semicolon".into(), "Quote".into()]);
    let mut r3 = keys("ZXCVBNM");
    r3.extend(["Comma".into(), "Period".into(), "Slash".into()]);
    [(0.0, r0), (0.5, r1), (0.75, r2), (1.25, r3)]
}

/// 實體相鄰鍵（不含自己），依 ROWS 順序
pub fn key_neighbors(code: &str) -> Vec<String> {
    let Some(p) = key_pos(code) else {
        return vec![];
    };
    let mut out = vec![];
    for (y, (off, codes)) in key_rows().iter().enumerate() {
        for (i, c) in codes.iter().enumerate() {
            let q = (i as f64 + off, y as f64);
            if c != code && (p.0 - q.0).hypot(p.1 - q.1) <= 1.3 {
                out.push(c.clone());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slots::CompositionBuffer;
    use std::collections::HashSet;

    const EMPTY: [Option<&'static str>; 3] = [None, None, None];

    #[test]
    fn dachen_covers_every_symbol_once() {
        let mut codes = vec![];
        for s in INITIALS.iter().chain(&MEDIALS).chain(&FINALS) {
            let code = Layout::Dachen.code_of(Mapped::Symbol(s)).expect(s);
            assert_eq!(
                Layout::Dachen.map_key(&code, &EMPTY),
                Mapped::Symbol(s),
                "{code}"
            );
            codes.push(code);
        }
        codes.sort();
        codes.dedup();
        assert_eq!(codes.len(), INITIALS.len() + MEDIALS.len() + FINALS.len());
    }

    #[test]
    fn map_key_tones_and_unmapped() {
        let k = |c| Layout::Dachen.map_key(c, &EMPTY);
        assert_eq!(k("Space"), Mapped::Tone(1));
        assert_eq!(k("Digit6"), Mapped::Tone(2));
        assert_eq!(k("Digit3"), Mapped::Tone(3));
        assert_eq!(k("Digit4"), Mapped::Tone(4));
        assert_eq!(k("Digit7"), Mapped::Tone(5));
        assert_eq!(k("KeyU"), Mapped::Symbol("ㄧ"));
        assert_eq!(k("Equal"), Mapped::Unmapped);
        assert_eq!(k("Enter"), Mapped::Unmapped);
    }

    #[test]
    fn slot_of_parts() {
        assert_eq!(slot_of("ㄅ"), Some(0));
        assert_eq!(slot_of("ㄩ"), Some(1));
        assert_eq!(slot_of("ㄦ"), Some(2));
        assert_eq!(slot_of("ˇ"), None);
        assert_eq!(slot_of("a"), None);
    }

    #[test]
    fn syllable_to_key_codes_appends_tone_key() {
        let k = |s| Layout::Dachen.syllable_to_key_codes(s);
        assert_eq!(k("ㄋㄧˇ"), ["KeyS", "KeyU", "Digit3"]);
        assert_eq!(k("ㄇㄚ"), ["KeyA", "Digit8", "Space"]);
        assert_eq!(k("ㄓˊ"), ["Digit5", "Digit6"]);
        assert_eq!(k("ㄉㄜ˙"), ["Digit2", "KeyK", "Digit7"]);
        assert_eq!(k("ㄒㄩㄝˋ"), ["KeyV", "KeyM", "Comma", "Digit4"]);
    }

    #[test]
    fn key_neighbors_by_geometry() {
        let n = key_neighbors("KeyG");
        for k in ["KeyF", "KeyH", "KeyT", "KeyY", "KeyV", "KeyB"] {
            assert!(n.iter().any(|x| x == k), "{k} 應與 G 相鄰：{n:?}");
        }
        assert!(!n.iter().any(|x| x == "KeyG" || x == "KeyR" || x == "KeyN"));
        // 數字列：3 與 4 相鄰（L3 的相鄰聲調鍵靠這個）
        assert!(key_neighbors("Digit3").iter().any(|x| x == "Digit4"));
        assert!(key_neighbors("Space").is_empty());
    }

    /// 照按鍵（key_str 的字元，空白＝一聲）打一個音節
    fn typed(layout: Layout, keys: &str) -> String {
        let mut buf = CompositionBuffer::new(HashSet::new());
        buf.layout = layout;
        for c in keys.chars() {
            buf.on_key(&if c == ' ' {
                "Space".into()
            } else {
                char_code(c)
            });
        }
        buf.sequence().join(" ")
    }

    #[test]
    fn layouts_type_syllables() {
        let cases: [(Layout, &[(&str, &str)]); 5] = [
            (
                Layout::Dachen,
                &[("ji3", "ㄨㄛˇ"), ("5j/ ", "ㄓㄨㄥ"), ("xu06", "ㄌㄧㄢˊ")],
            ),
            (
                Layout::Eten,
                &[
                    ("xo3", "ㄨㄛˇ"),
                    (",x- ", "ㄓㄨㄥ"),
                    ("le82", "ㄌㄧㄢˊ"),
                    ("=2", "ㄦˊ"),
                ],
            ),
            (
                Layout::Ibm,
                &[
                    ("sg,", "ㄨㄛˇ"),
                    ("rsb ", "ㄓㄨㄥ"),
                    ("8axm", "ㄌㄧㄢˊ"),
                    ("n/", "ㄦ˙"),
                ],
            ),
            (
                Layout::Hsu,
                &[
                    ("xhf", "ㄨㄛˇ"),
                    ("jxl ", "ㄓㄨㄥ"),
                    ("lemd", "ㄌㄧㄢˊ"),
                    ("jj", "ㄓˋ"),
                    ("ld", "ㄦˊ"),
                    ("gef", "ㄐㄧˇ"),
                    ("bad", "ㄅㄟˊ"),
                    ("ees", "ㄧㄝ˙"),
                    ("jy ", "ㄓㄚ"),
                ],
            ),
            (
                Layout::Eten26,
                &[
                    ("xoj", "ㄨㄛˇ"),
                    ("gxl ", "ㄓㄨㄥ"),
                    ("lemf", "ㄌㄧㄢˊ"),
                    ("hf", "ㄦˊ"),
                    ("ve ", "ㄑㄧ"),
                    ("ca ", "ㄕㄚ"),
                    ("bqk", "ㄅㄟˋ"),
                ],
            ),
        ];
        for (layout, cs) in cases {
            for (keys, want) in cs {
                assert_eq!(typed(layout, keys), *want, "{layout:?} {keys}");
            }
        }
    }

    /// 每個合法音節照 syllable_to_key_codes 打回來要一樣（排列打得出所有音節，句準就跟大千相同）。
    /// 要 syllables.json：ZHUYIN_DATA（預設 ../data），沒有就跳過
    #[test]
    fn layouts_round_trip_legal_syllables() {
        let data = std::env::var("ZHUYIN_DATA").unwrap_or("../data".into());
        if !std::path::Path::new(&format!("{data}/processed/syllables.json")).exists() {
            eprintln!("沒有 {data}/processed/syllables.json，跳過");
            return;
        }
        let legal = crate::load_legal(&data);
        for (layout, _, _) in LAYOUTS {
            let mut bad = vec![];
            for syl in &legal {
                let mut buf = CompositionBuffer::new(legal.clone());
                buf.layout = layout;
                for code in layout.syllable_to_key_codes(syl) {
                    buf.on_key(&code);
                }
                if buf.sequence() != [syl.clone()] {
                    bad.push(format!("{syl}→{}", buf.sequence().join(" ")));
                }
            }
            bad.sort();
            eprintln!("{layout:?}: {}/{} 打不回來 {bad:?}", bad.len(), legal.len());
            // 一鍵多音的排列有幾個單韻母音節打不出來，libchewing 也一樣（只有聲母時不會換成 ㄟ／ㄝ／ㄥ）
            let known: &[&str] = match layout {
                Layout::Hsu => &["ㄝˋ→ㄧˋ", "ㄟˋ→ㄘˋ", "ㄟ→ㄘ", "ㄥ→ㄦ"],
                Layout::Eten26 => &["ㄝˋ→ㄘˋ", "ㄟˋ→ㄗˋ", "ㄟ→ㄗ"],
                _ => &[],
            };
            assert_eq!(bad, known, "{layout:?}");
        }
    }
}
