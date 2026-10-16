//! 注音解碼核心的 Rust 原型（docs/MEMORY.md「Rust 原型」）。
//!   zhuyin-native eval                 評測句準（eval/colloquial.jsonl、eval/written.jsonl）
//!   zhuyin-native dump <out> [nBest]   同 debug-decode-dump.ts 的格式：`詞|詞\t分數`
//! 資料目錄：ZHUYIN_DATA（預設 data），要有 models/lm.bo.bin 與 processed/lexicon.bin。
mod decode;
mod lexicon;
mod lm;

use std::time::Instant;

#[repr(C)]
#[derive(Default)]
struct MemCounters {
    cb: u32,
    page_faults: u32,
    peak_working_set: usize,
    working_set: usize,
    quota: [usize; 4],
    pagefile: usize,
    peak_pagefile: usize,
    private: usize,
}

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> isize;
    fn K32GetProcessMemoryInfo(p: isize, c: *mut MemCounters, cb: u32) -> i32;
}

fn mem(label: &str) {
    let mut c = MemCounters {
        cb: std::mem::size_of::<MemCounters>() as u32,
        ..Default::default()
    };
    unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
    let mb = |b: usize| b as f64 / 1048576.0;
    eprintln!(
        "[mem] {label}: 工作集 {:.1}MB（峰值 {:.1}）私有 {:.1}MB（峰值 {:.1}）",
        mb(c.working_set),
        mb(c.peak_working_set),
        mb(c.private),
        mb(c.peak_pagefile)
    );
}

struct Sample {
    text: String,
    syllables: Vec<String>,
}

fn load_samples(file: &str) -> Vec<Sample> {
    let s = std::fs::read_to_string(file).unwrap_or_else(|e| panic!("{file}: {e}"));
    // 第一行是中繼資料
    s.lines()
        .filter(|l| !l.is_empty())
        .skip(1)
        .map(|l| {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            Sample {
                text: v["text"].as_str().unwrap().to_string(),
                syllables: v["syllables"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_str().unwrap().to_string())
                    .collect(),
            }
        })
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let data = std::env::var("ZHUYIN_DATA").unwrap_or_else(|_| "data".into());
    let t0 = Instant::now();
    let lm = lm::BackoffLm::load(&format!("{data}/models/lm.bo.bin")).unwrap();
    let lex = lexicon::Lexicon::load(&format!("{data}/processed/lexicon.bin")).unwrap();
    let dec = decode::Decoder::new(&lm, &lex, 1.0, 0.5);
    eprintln!("載入 {:?}", t0.elapsed());
    mem("載入後");

    let files = ["eval/colloquial.jsonl", "eval/written.jsonl"];
    let t1 = Instant::now();
    let mut decoded = 0;
    match args.get(1).map(String::as_str) {
        Some("eval") => {
            for f in files {
                let samples = load_samples(f);
                let ok = samples
                    .iter()
                    .filter(|s| {
                        dec.decode(&s.syllables, 4)
                            .first()
                            .is_some_and(|(w, _)| w.concat() == s.text)
                    })
                    .count();
                decoded += samples.len();
                println!(
                    "{f}: 句準 {:.2}%（{ok}/{}）",
                    100.0 * ok as f64 / samples.len() as f64,
                    samples.len()
                );
            }
        }
        Some("dump") => {
            let out = args.get(2).expect("dump <out> [nBest]");
            let n_best = args.get(3).map_or(4, |s| s.parse().unwrap());
            let mut lines = vec![];
            for f in files {
                for s in load_samples(f) {
                    for (w, score) in dec.decode(&s.syllables, n_best) {
                        lines.push(format!("{}\t{}", w.join("|"), score));
                    }
                    decoded += 1;
                }
            }
            std::fs::write(out, lines.join("\n")).unwrap();
            eprintln!("{} 行 -> {out}", lines.len());
        }
        _ => {
            eprintln!("用法：zhuyin-native eval | dump <out> [nBest]");
            std::process::exit(2);
        }
    }
    eprintln!(
        "解碼 {decoded} 句 {:?}（每句 {:.1}ms）",
        t1.elapsed(),
        t1.elapsed().as_secs_f64() * 1000.0 / decoded as f64
    );
    mem("解碼後");
}
