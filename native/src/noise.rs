//! X3 錯誤注入（原 packages/cli/src/noise.ts）：在按鍵層級模擬打錯，再走真正的 L2 組字，
//! 得到「打錯後的音節序列」，用於評估 L3。相鄰鍵與模糊音表和 L3 共用，結果偏樂觀（缺真人打字紀錄）。
//! 亂數與抽樣順序照 TS，同種子得到同一組錯誤。
use crate::keymap::{key_neighbors, Layout, Mapped, MARKS};
use crate::l3::FUZZY_PAIRS;
use crate::slots::CompositionBuffer;
use std::collections::HashSet;

/// 可重現的亂數（mulberry32，同 TS）
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(seed)
    }
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[(self.next() * xs.len() as f64) as usize]
    }
}

/// key：每個符號鍵出錯的機率（按到相鄰鍵 60%／漏按 20%／多按相鄰鍵 20%）
/// cognitive：每個音節的認知錯誤機率（模糊音 70%／記錯聲調 30%）
pub struct NoiseOptions {
    pub key: f64,
    pub cognitive: f64,
}

fn fuzzy_of(c: &str) -> Vec<&'static str> {
    let mut out = vec![];
    for (a, b) in FUZZY_PAIRS {
        if a == c {
            out.push(b);
        }
        if b == c {
            out.push(a);
        }
    }
    out
}

/// 認知錯誤：模糊音替換或改聲調（回傳可能不合法的音節，交給 L2 照打）
fn cognitive(syl: &str, r: &mut Rng) -> String {
    let mut chars: Vec<String> = syl.chars().map(String::from).collect();
    let fuzzy_idx: Vec<usize> = (0..chars.len())
        .filter(|&i| !fuzzy_of(&chars[i]).is_empty())
        .collect();
    if !fuzzy_idx.is_empty() && r.next() < 0.7 {
        let i = *r.pick(&fuzzy_idx);
        chars[i] = r.pick(&fuzzy_of(&chars[i])).to_string();
        return chars.concat();
    }
    let last = chars.last().unwrap().as_str();
    let has_mark = !last.is_empty() && MARKS.contains(&last);
    let (base, cur) = if has_mark {
        (chars[..chars.len() - 1].concat(), last)
    } else {
        (syl.to_string(), "")
    };
    let others: Vec<&str> = MARKS.iter().copied().filter(|&m| m != cur).collect();
    base + r.pick(&others)
}

/// 意圖音節序列 → 打錯後經 L2 組成的觀察音節序列
pub fn inject_noise(
    syllables: &[String],
    legal: &HashSet<String>,
    o: &NoiseOptions,
    r: &mut Rng,
) -> Vec<String> {
    // 評測只模擬大千
    let kb = Layout::Dachen;
    let is_tone = |c: &str| matches!(kb.meanings(c)[..], [Mapped::Tone(_)]);
    let is_symbol = |c: &str| matches!(kb.meanings(c)[..], [Mapped::Symbol(_)]);
    let mut buf = CompositionBuffer::new(legal.clone());
    for intended in syllables {
        let syl = if r.next() < o.cognitive {
            cognitive(intended, r)
        } else {
            intended.clone()
        };
        for code in kb.syllable_to_key_codes(&syl) {
            let code = code.as_str();
            if is_tone(code) {
                // 聲調鍵：只會按到相鄰的聲調鍵（不破壞音節邊界）
                let adj: Vec<String> = key_neighbors(code)
                    .into_iter()
                    .filter(|c| is_tone(c))
                    .collect();
                if !adj.is_empty() && r.next() < o.key {
                    let c = r.pick(&adj).clone();
                    buf.on_key(&c);
                } else {
                    buf.on_key(code);
                }
                continue;
            }
            if r.next() >= o.key {
                buf.on_key(code);
                continue;
            }
            let nb: Vec<String> = key_neighbors(code)
                .into_iter()
                .filter(|c| is_symbol(c))
                .collect();
            let kind = r.next();
            if kind < 0.6 {
                let c = r.pick(&nb).clone();
                buf.on_key(&c);
            } else if kind < 0.8 {
                // 漏按
            } else {
                buf.on_key(code);
                let c = r.pick(&nb).clone();
                buf.on_key(&c); // 多按相鄰鍵
            }
        }
    }
    buf.sequence().to_vec()
}
