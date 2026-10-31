//! 實驗指令（2026-10-30，有錯音節的單字更正）：
//!   zhuyin-native menu    選字視窗裡 L3 更正字的排法（engine.rs MenuRank）：輸出錯的位置，正解字排第幾
//!   zhuyin-native habit   模擬有固定打錯習慣的使用者：dev 句的更正讓 L3 學（Channel::learn），量 test 句
use crate::decode::{DecodeOptions, Decoder};
use crate::engine::{menu_order, MenuRank};
use crate::l3::Channel;
use crate::noise;
use std::collections::HashSet;

/// 排名統計：第一頁（前 9）、前 3、找不到、名次中位數
#[derive(Default)]
struct Ranks(Vec<Option<usize>>);

impl Ranks {
    fn line(&self) -> String {
        let n = self.0.len().max(1) as f64;
        let pct = |f: &dyn Fn(usize) -> bool| {
            100.0 * self.0.iter().filter(|r| r.is_some_and(f)).count() as f64 / n
        };
        let mut found: Vec<usize> = self.0.iter().flatten().copied().collect();
        found.sort();
        format!(
            "n={} 前3 {:.1}% 第一頁 {:.1}% 找不到 {:.1}% 中位數 {}",
            self.0.len(),
            pct(&|r| r < 3),
            pct(&|r| r < 9),
            100.0 * self.0.iter().filter(|r| r.is_none()).count() as f64 / n,
            found.get(found.len() / 2).map_or(-1, |&r| r as i64 + 1),
        )
    }
}

pub fn menu(dec: &Decoder, legal: &HashSet<String>, samples: &[crate::Sample]) {
    let ch = Channel::new(legal.clone(), Default::default());
    let ranks = [
        MenuRank::Cost,
        MenuRank::Unigram,
        MenuRank::Context,
        MenuRank::Promote,
    ];
    // [有錯輸入的打錯位置, 沒錯輸入的選錯位置] × 排法
    let mut st: [Vec<Ranks>; 2] = Default::default();
    for v in &mut st {
        v.resize_with(ranks.len(), Ranks::default);
    }
    for (i, s) in samples.iter().enumerate() {
        let truth: Vec<char> = s.text.chars().collect();
        if truth.len() != s.syllables.len() {
            continue;
        }
        for (k, noisy) in [true, false].into_iter().enumerate() {
            let obs = if noisy {
                noise::inject_noise(
                    &s.syllables,
                    legal,
                    &noise::NoiseOptions {
                        key: 0.03,
                        cognitive: 0.03,
                    },
                    &mut noise::Rng::new(1000 + i as u32),
                )
            } else {
                s.syllables.clone()
            };
            if obs.len() != truth.len() {
                continue;
            }
            let alts: Vec<_> = obs.iter().map(|x| ch.expand(x)).collect();
            let o = DecodeOptions {
                n_best: 4,
                alternatives: Some(&alts),
                ..Default::default()
            };
            let paths = dec.decode(&obs, &o);
            let Some(top) = paths.first() else { continue };
            let out: Vec<char> = top.text().chars().collect();
            for pos in 0..obs.len() {
                // 使用者要開選字視窗的地方：輸出的字錯了（有錯輸入只看打錯的音節）
                if out.get(pos) == Some(&truth[pos]) || (noisy && obs[pos] == s.syllables[pos]) {
                    continue;
                }
                let want = truth[pos].to_string();
                for (r, &rank) in ranks.iter().enumerate() {
                    let items = menu_order(dec, &obs, pos, Some(&alts), Some(top), rank);
                    st[k][r]
                        .0
                        .push(items.iter().position(|f| f.len == 1 && f.word == want));
                }
            }
        }
    }
    for (k, title) in ["有錯輸入、打錯的音節", "沒錯輸入、選錯的字"]
        .iter()
        .enumerate()
    {
        println!("{title}");
        for (r, rank) in ranks.iter().enumerate() {
            println!("  {:<8} {}", format!("{rank:?}"), st[k][r].line());
        }
    }
}

/// 想打的 → 打成的。p＝每個符合的音節打錯的機率
const HABITS: [(&str, &str); 3] = [("ㄟ", "ㄛ"), ("ㄓ", "ㄗ"), ("ˇ", "ˋ")];

fn with_habit(
    syls: &[String],
    legal: &HashSet<String>,
    p: f64,
    rng: &mut noise::Rng,
) -> Vec<String> {
    syls.iter()
        .map(|s| {
            for (a, b) in HABITS {
                let t = s.replacen(a, b, 1);
                if t != *s && legal.contains(&t) && rng.next() < p {
                    return t;
                }
            }
            s.clone()
        })
        .collect()
}

pub fn habit(dec: &Decoder, legal: &HashSet<String>, samples: &[crate::Sample]) {
    let p: f64 = std::env::var("HABIT_P").map_or(0.5, |v| v.parse().unwrap());
    let k: f64 = std::env::var("HABIT_K").map_or(3.0, |v| v.parse().unwrap());
    let samples: Vec<_> = samples
        .iter()
        .filter(|s| s.text.chars().count() == s.syllables.len())
        .collect();
    // 隨機打錯可能多一個、少一個音節：那種句子只算進「沒打錯」
    let typed: Vec<Vec<String>> = samples
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let rng = &mut noise::Rng::new(2000 + i as u32);
            // HABIT_RANDOM=1：沒有固定習慣，打錯照 noise.rs 隨機（學到的改法分散，量學習的副作用）
            if std::env::var("HABIT_RANDOM").is_ok() {
                let o = noise::NoiseOptions {
                    key: 0.03,
                    cognitive: 0.03,
                };
                noise::inject_noise(&s.syllables, legal, &o, rng)
            } else {
                with_habit(&s.syllables, legal, p, rng)
            }
        })
        .collect();
    let dev: Vec<usize> = (0..samples.len()).step_by(2).collect();
    let test: Vec<usize> = (1..samples.len()).step_by(2).collect();
    let acc = |ch: &Channel, input: &dyn Fn(usize) -> Vec<String>| {
        let ok = test
            .iter()
            .filter(|&&i| {
                let obs = input(i);
                let alts: Vec<_> = obs.iter().map(|x| ch.expand(x)).collect();
                let o = DecodeOptions {
                    n_best: 4,
                    alternatives: Some(&alts),
                    ..Default::default()
                };
                dec.decode(&obs, &o).first().map(|p| p.text()) == Some(samples[i].text.clone())
            })
            .count();
        100.0 * ok as f64 / test.len() as f64
    };
    let errs = test
        .iter()
        .filter(|&&i| typed[i] != samples[i].syllables)
        .count();
    let label = if std::env::var("HABIT_RANDOM").is_ok() {
        "隨機".to_string()
    } else {
        format!("{HABITS:?} p={p}")
    };
    println!(
        "習慣 {label} k={k}；test {} 句、其中 {errs} 句有打錯",
        test.len()
    );
    for n in [0, 10, 50, 200, dev.len()] {
        let mut ch = Channel::new(legal.clone(), Default::default());
        ch.learn_k = k;
        if let Ok(v) = std::env::var("HABIT_RATE") {
            ch.learn_rate = v.parse().unwrap();
        }
        let mut learned = 0;
        // 使用者把 dev 前 n 句的打錯都改回來：每個打錯的音節記一次
        for &i in dev[..n.min(dev.len())]
            .iter()
            .filter(|&&i| typed[i].len() == samples[i].syllables.len())
        {
            for t in &samples[i].syllables {
                ch.observe(t);
            }
            for (o, t) in typed[i].iter().zip(&samples[i].syllables) {
                if o != t && ch.learn(o, t) {
                    learned += 1;
                }
            }
        }
        println!(
            "學 {n:>4} 句（{learned:>4} 次）：有習慣 {:.1}%  沒打錯 {:.1}%",
            acc(&ch, &|i| typed[i].clone()),
            acc(&ch, &|i| samples[i].syllables.clone()),
        );
    }
}
