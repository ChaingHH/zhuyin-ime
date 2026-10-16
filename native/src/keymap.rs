//! L1 鍵盤映射（packages/core/src/keymap.ts，只有大千）與注音符號分類（core/src/index.ts）。

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

/// 大千的聲調鍵（順序同 TS 的 TONE_CODES）
pub const TONE_CODES: [(&str, u8); 5] = [
    ("Space", 1),
    ("Digit6", 2),
    ("Digit3", 3),
    ("Digit4", 4),
    ("Digit7", 5),
];

/// 大千排列（event.code → 符號），順序同 TS 的 DACHEN_ROWS
pub const DACHEN: [(&str, &str); 37] = [
    ("Digit1", "ㄅ"),
    ("Digit2", "ㄉ"),
    ("Digit5", "ㄓ"),
    ("Digit8", "ㄚ"),
    ("Digit9", "ㄞ"),
    ("Digit0", "ㄢ"),
    ("Minus", "ㄦ"),
    ("KeyQ", "ㄆ"),
    ("KeyW", "ㄊ"),
    ("KeyE", "ㄍ"),
    ("KeyR", "ㄐ"),
    ("KeyT", "ㄔ"),
    ("KeyY", "ㄗ"),
    ("KeyU", "ㄧ"),
    ("KeyI", "ㄛ"),
    ("KeyO", "ㄟ"),
    ("KeyP", "ㄣ"),
    ("KeyA", "ㄇ"),
    ("KeyS", "ㄋ"),
    ("KeyD", "ㄎ"),
    ("KeyF", "ㄑ"),
    ("KeyG", "ㄕ"),
    ("KeyH", "ㄘ"),
    ("KeyJ", "ㄨ"),
    ("KeyK", "ㄜ"),
    ("KeyL", "ㄠ"),
    ("Semicolon", "ㄤ"),
    ("KeyZ", "ㄈ"),
    ("KeyX", "ㄌ"),
    ("KeyC", "ㄏ"),
    ("KeyV", "ㄒ"),
    ("KeyB", "ㄖ"),
    ("KeyN", "ㄙ"),
    ("KeyM", "ㄩ"),
    ("Comma", "ㄝ"),
    ("Period", "ㄡ"),
    ("Slash", "ㄥ"),
];

pub enum Mapped {
    Symbol(&'static str),
    Tone(u8),
    Unmapped,
}

pub fn map_key(code: &str) -> Mapped {
    if let Some(&(_, t)) = TONE_CODES.iter().find(|(c, _)| *c == code) {
        return Mapped::Tone(t);
    }
    match DACHEN.iter().find(|(c, _)| *c == code) {
        Some(&(_, s)) => Mapped::Symbol(s),
        None => Mapped::Unmapped,
    }
}

/// 正規形音節 → 鍵碼序列（C-M-F 後按聲調鍵）
pub fn syllable_to_key_codes(syl: &str) -> Vec<&'static str> {
    let mut chars: Vec<char> = syl.chars().collect();
    let mut tone = 1;
    if let Some(last) = chars.last() {
        if let Some(i) = MARKS[1..].iter().position(|m| m.starts_with(*last)) {
            tone = i + 2;
            chars.pop();
        }
    }
    let mut out: Vec<&'static str> = chars
        .iter()
        .filter_map(|ch| {
            let s = ch.to_string();
            DACHEN.iter().find(|(_, x)| *x == s).map(|(c, _)| *c)
        })
        .collect();
    out.push(
        TONE_CODES
            .iter()
            .find(|(_, t)| *t as usize == tone)
            .unwrap()
            .0,
    );
    out
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
