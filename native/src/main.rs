//! 注音輸入法引擎的 Rust 移植（docs/MEMORY.md「Rust 引擎」）。
//!   zhuyin-native eval                      評測句準（eval/colloquial.jsonl、eval/written.jsonl）
//!   zhuyin-native dump <out> [nBest] [l3]   同 debug-decode-dump.ts 的格式：`詞|詞\t分數[\t讀音]`
//!   zhuyin-native keys <out>                L1/L2：評測句的大千按鍵 → 音節序列
//!   zhuyin-native l3 <in> <out> <s>         L3：解碼 debug-native-parity.ts 倒出的有錯輸入
//!   zhuyin-native replay <events> <out> [adapter-out]
//!                                           引擎：重播按鍵（ZHUYIN_CLOCK、ZHUYIN_ADAPTER、ZHUYIN_L3）
//!   zhuyin-native pime                      PIME 後端（stdin/stdout，見 pime.rs）。資料預設在執行檔旁的 data\；
//!                                           學習存 %APPDATA%\PIME\zhuyin\adapter.json（ZHUYIN_ADAPTER＝路徑或 off）；
//!                                           L3 預設開（ZHUYIN_L3=0 關）
//! 對拍腳本：debug-native-parity.ts。ZHUYIN_A＝詞級權重（預設 1）。
//! 資料目錄：ZHUYIN_DATA（預設 data），要有 models/lm.bo.bin、processed/lexicon.bin、processed/syllables.json。
mod decode;
mod engine;
mod keymap;
mod l3;
mod lexicon;
mod lm;
mod pime;
mod slots;
mod x2;

use std::collections::HashSet;
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

fn eval_samples() -> Vec<Sample> {
    ["eval/colloquial.jsonl", "eval/written.jsonl"]
        .iter()
        .flat_map(|f| load_samples(f))
        .collect()
}

fn load_legal(data: &str) -> HashSet<String> {
    let s = std::fs::read_to_string(format!("{data}/processed/syllables.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&s).unwrap();
    v["syllables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_string())
        .collect()
}

/// debug-l3.ts 的代價：初始值 × s（ㄣ/ㄥ 用預設）
fn scaled(s: f64) -> l3::ChannelOptions {
    l3::ChannelOptions {
        sub: 6.0 * s,
        extra: 7.0 * s,
        miss: 8.0 * s,
        tone_adj: 5.0 * s,
        tone: 7.0 * s,
        fuzzy: 5.0 * s,
        ..Default::default()
    }
}

/// 重播事件檔：`k\t<code>\t<key>`（按鍵）、`c\t<k>`（送出第 k 候選）、`m`（切換模式）。
/// 每個事件輸出一行，格式同 debug-native-parity.ts
fn replay(eng: &mut engine::ImeEngine, events: &str) -> Vec<String> {
    let mut out = vec![];
    for line in events.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        match f[0] {
            "k" => {
                let key = f.get(2).filter(|k| !k.is_empty()).copied();
                let st = eng.on_key(f[1], key);
                let menu = st.menu.map_or(String::new(), |m| {
                    format!("{}@{}/{}", m.items.join("|"), m.page, m.pages)
                });
                out.push(format!(
                    "{}\t{}\t{}\t{}\t{}\t{}",
                    st.composition,
                    st.last_legal,
                    st.cursor,
                    st.pending.unwrap_or_default(),
                    menu,
                    st.text.unwrap_or_default()
                ));
            }
            "c" => out.push(format!("C\t{}", eng.commit(f[1].parse().unwrap()))),
            "m" => out.push(format!("M\t{}", eng.toggle_mode())),
            _ => panic!("事件格式錯誤：{line}"),
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let is_pime = args.get(1).map(String::as_str) == Some("pime");
    // PIME 從自己的目錄啟動後端，資料放執行檔旁
    let exe_dir = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let data = std::env::var("ZHUYIN_DATA").unwrap_or_else(|_| {
        if is_pime {
            exe_dir.join("data").to_string_lossy().into_owned()
        } else {
            "data".into()
        }
    });
    let a: f64 = std::env::var("ZHUYIN_A").map_or(1.0, |s| s.parse().unwrap());
    let t0 = Instant::now();
    let lm = lm::BackoffLm::load(&format!("{data}/models/lm.bo.bin")).unwrap();
    let lex = lexicon::Lexicon::load(&format!("{data}/processed/lexicon.bin")).unwrap();
    let mut dec = decode::Decoder::new(lm, lex, a, 0.5);
    let legal = load_legal(&data);
    eprintln!("載入 {:?}", t0.elapsed());
    mem("載入後");

    let t1 = Instant::now();
    let mut done = 0;
    let plain = |n_best| decode::DecodeOptions {
        n_best,
        ..Default::default()
    };
    match args.get(1).map(String::as_str) {
        Some("eval") => {
            for f in ["eval/colloquial.jsonl", "eval/written.jsonl"] {
                let samples = load_samples(f);
                let ok = samples
                    .iter()
                    .filter(|s| {
                        dec.decode(&s.syllables, &plain(4))
                            .first()
                            .is_some_and(|p| p.text() == s.text)
                    })
                    .count();
                done += samples.len();
                println!(
                    "{f}: 句準 {:.2}%（{ok}/{}）",
                    100.0 * ok as f64 / samples.len() as f64,
                    samples.len()
                );
            }
        }
        Some("dump") => {
            let out = args.get(2).expect("dump <out> [nBest] [l3]");
            let n_best = args.get(3).map_or(4, |s| s.parse().unwrap());
            let ch = (args.get(4).map(String::as_str) == Some("l3"))
                .then(|| l3::Channel::new(legal.clone(), Default::default()));
            let mut lines = vec![];
            for s in eval_samples() {
                let alts: Option<Vec<_>> = ch
                    .as_ref()
                    .map(|c| s.syllables.iter().map(|x| c.expand(x)).collect());
                let o = decode::DecodeOptions {
                    n_best,
                    alternatives: alts.as_deref(),
                    ..Default::default()
                };
                for p in dec.decode(&s.syllables, &o) {
                    let mut l = format!("{}\t{}", p.words().join("|"), p.score);
                    if ch.is_some() {
                        let r: Vec<String> =
                            p.breakdown.iter().map(|b| b.reading.join(" ")).collect();
                        l += &format!("\t{}", r.join("|"));
                    }
                    lines.push(l);
                }
                done += 1;
            }
            std::fs::write(out, lines.join("\n")).unwrap();
            eprintln!("{} 行 -> {out}", lines.len());
        }
        Some("keys") => {
            let mut lines = vec![];
            for s in eval_samples() {
                let mut buf = slots::CompositionBuffer::new(legal.clone());
                for syl in &s.syllables {
                    for code in keymap::syllable_to_key_codes(syl) {
                        buf.on_key(code);
                    }
                }
                lines.push(buf.sequence().join(" "));
                done += 1;
            }
            std::fs::write(&args[2], lines.join("\n")).unwrap();
        }
        Some("l3") => {
            // 每行一句有錯輸入（音節以空白分隔）→ 每行 top-1 的詞序與分數
            let input = std::fs::read_to_string(&args[2]).unwrap();
            let ch = l3::Channel::new(legal.clone(), scaled(args[4].parse().unwrap()));
            let mut lines = vec![];
            for l in input.lines() {
                let obs: Vec<String> = l.split(' ').map(String::from).collect();
                let alts: Vec<_> = obs.iter().map(|x| ch.expand(x)).collect();
                let o = decode::DecodeOptions {
                    n_best: 4,
                    alternatives: Some(&alts),
                    ..Default::default()
                };
                let p = dec.decode(&obs, &o);
                lines.push(p.first().map_or(String::new(), |p| {
                    format!("{}\t{}", p.words().join("|"), p.score)
                }));
                done += 1;
            }
            std::fs::write(&args[3], lines.join("\n")).unwrap();
        }
        Some("replay") => {
            let mut adapter = match std::env::var("ZHUYIN_ADAPTER") {
                Ok(f) => x2::UserAdapter::from_json(&std::fs::read_to_string(&f).unwrap()).unwrap(),
                Err(_) => x2::UserAdapter::new(),
            };
            // 使用者詞條（手動造詞＋歷史挖詞）注入解碼格，同 runtime.ts
            for e in adapter.drain_pending() {
                dec.add_entry(&e.word, &e.readings);
            }
            let mut eng = engine::ImeEngine::new(dec, legal.clone(), Some(adapter));
            if std::env::var("ZHUYIN_L3").is_ok() {
                eng.channel = Some(l3::Channel::new(legal.clone(), Default::default()));
            }
            eng.clock = std::env::var("ZHUYIN_CLOCK")
                .ok()
                .map(|s| s.parse().unwrap());
            let events = std::fs::read_to_string(&args[2]).unwrap();
            let lines = replay(&mut eng, &events);
            done = lines.len();
            std::fs::write(&args[3], lines.join("\n")).unwrap();
            if let Some(f) = args.get(4) {
                std::fs::write(f, eng.adapter.as_ref().unwrap().to_json()).unwrap();
            }
        }
        Some("pime") => {
            let adapter_file = match std::env::var("ZHUYIN_ADAPTER") {
                Ok(f) if f == "off" => None,
                Ok(f) => Some(std::path::PathBuf::from(f)),
                Err(_) => std::env::var("APPDATA")
                    .ok()
                    .map(|d| std::path::Path::new(&d).join("PIME/zhuyin/adapter.json")),
            };
            let mut adapter = adapter_file
                .as_ref()
                .map(|f| match std::fs::read_to_string(f) {
                    Err(_) => x2::UserAdapter::new(),
                    Ok(s) => x2::UserAdapter::from_json(&s).unwrap_or_else(|e| {
                        eprintln!("[pime] {} 讀不懂（{e}），這次不學習，原檔不動", f.display());
                        let mut a = x2::UserAdapter::new();
                        a.enabled = false;
                        a
                    }),
                });
            // 讀檔失敗時不存檔，免得蓋掉使用者的學習資料
            let adapter_file = adapter_file.filter(|_| adapter.as_ref().is_some_and(|a| a.enabled));
            for e in adapter.iter_mut().flat_map(|a| a.drain_pending()) {
                dec.add_entry(&e.word, &e.readings);
            }
            let mut eng = engine::ImeEngine::new(dec, legal.clone(), adapter);
            if std::env::var("ZHUYIN_L3").map_or(true, |v| v != "0") {
                eng.channel = Some(l3::Channel::new(legal.clone(), Default::default()));
            }
            let icons = exe_dir.join("input_methods").join("zhuyin");
            pime::serve(pime::Backend::new(eng, adapter_file, icons));
            return;
        }
        _ => {
            eprintln!("用法：zhuyin-native eval | dump | keys | l3 | replay | pime（見檔頭）");
            std::process::exit(2);
        }
    }
    eprintln!(
        "處理 {done} 項 {:?}（每項 {:.1}ms）",
        t1.elapsed(),
        t1.elapsed().as_secs_f64() * 1000.0 / done.max(1) as f64
    );
    mem("結束");
}
