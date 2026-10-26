//! 注音輸入法引擎的 Rust 移植（docs/MEMORY.md「Rust 引擎」）。
//!   zhuyin-native eval [fails-out]          評測（eval/colloquial、written、mixed）：句準（dev＝偶數句／test＝奇數句）、
//!                                           字準、N-best oracle、延遲；fails-out 寫出答錯的句子。
//!                                           一設定一行程，用環境變數換設定：ZHUYIN_GAMMA、ZHUYIN_POLY、ZHUYIN_POLY_MINOR、
//!                                           ZHUYIN_BEAM、ZHUYIN_NBEST（預設 4）；ZHUYIN_LM＝模型檔（預設 data/models/lm.bo.bin）；
//!                                           ZHUYIN_NOISE＝key,cog 注入錯誤（noise.rs，例 0.03,0.03）；
//!                                           ZHUYIN_EVAL＝評測檔（逗號分隔，取代預設三個）；
//!                                           ZHUYIN_L3=1 開 L3，或 ZHUYIN_L3_SCALE＝s（代價 × s，可加 ZHUYIN_L3_NASAL、ZHUYIN_L3_MAXALTS）；
//!                                           ZHUYIN_INCR=1 逐音節比對增量解碼與全量解碼（不同就 panic），印每步延遲
//!   zhuyin-native dump <out> [nBest] [l3]   同 debug-decode-dump.ts 的格式：`詞|詞\t分數[\t讀音]`
//!   zhuyin-native keys <out>                L1/L2：評測句的大千按鍵 → 音節序列
//!   zhuyin-native l3 <in> <out> <s>         L3：解碼 debug-native-parity.ts 倒出的有錯輸入
//!   zhuyin-native replay <events> <out> [adapter-out]
//!                                           引擎：重播按鍵（ZHUYIN_CLOCK、ZHUYIN_ADAPTER、ZHUYIN_L3）
//!   zhuyin-native usage <usage.jsonl> [eval-out]
//!                                           看使用紀錄（PIME 右鍵選單「記錄使用情形」）：錯誤率、最常改的字、L3 更正；
//!                                           eval-out 寫成評測集格式（音節照實際打的），ZHUYIN_EVAL=<檔> eval 可以跑
//!   zhuyin-native pime                      PIME 後端（stdin/stdout，見 pime.rs）。資料預設在執行檔旁的 data\；
//!                                           學習存 %APPDATA%\PIME\zhuyin\adapter.json（ZHUYIN_ADAPTER＝路徑或 off）；
//!                                           設定檔 %APPDATA%\PIME\zhuyin\config.json（ZHUYIN_CONFIG＝路徑或 off，見 pime.rs）；
//!                                           L3 預設開（ZHUYIN_L3=0 關）；閒置 ZHUYIN_IDLE_SECS 秒（預設 300）卸載模型；
//!                                           stderr 寫到 %APPDATA%\PIME\zhuyin\backend.log（ZHUYIN_LOG＝路徑或 off）
//! 對拍腳本：debug-native-parity.ts。ZHUYIN_A＝詞級權重（預設 1）。
//! 資料目錄：ZHUYIN_DATA（預設 data），要有 models/lm.bo.bin、processed/lexicon.bin、processed/syllables.json。
mod decode;
mod engine;
mod keymap;
mod l3;
mod learned_web;
mod lexicon;
mod lm;
mod noise;
mod pime;
mod usage;
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

/// 增量解碼 == 全量解碼：逐音節打、刪掉中間一個再補回、中途選字後接著打；steps＝[全量, 增量] 每步毫秒
fn incr_check(
    dec: &decode::Decoder,
    obs: &[String],
    alts: Option<&[Vec<l3::Hypothesis>]>,
    n_best: usize,
    steps: &mut [Vec<f64>; 2],
) {
    let sig = |ps: &[decode::DecodePath]| -> Vec<(u64, Vec<(String, Vec<String>)>)> {
        ps.iter()
            .map(|p| {
                let b = p.breakdown.iter().map(|b| (b.word.clone(), b.reading.clone()));
                (p.score.to_bits(), b.collect())
            })
            .collect()
    };
    let mut lat = decode::Lattice::default();
    let mut run = |seq: &[String], alts: Option<&[Vec<l3::Hypothesis>]>, fixed: &[decode::FixedSpan]| {
        let o = decode::DecodeOptions {
            n_best,
            alternatives: alts,
            fixed,
            ..Default::default()
        };
        let t = Instant::now();
        let full = dec.decode(seq, &o);
        steps[0].push(t.elapsed().as_secs_f64() * 1000.0);
        let t = Instant::now();
        let inc = dec.decode_in(&mut lat, seq, &o);
        steps[1].push(t.elapsed().as_secs_f64() * 1000.0);
        assert!(sig(&full) == sig(&inc), "增量≠全量：{}", seq.join(" "));
        full
    };
    let n = obs.len();
    let mut mid = vec![];
    for k in 1..=n {
        let r = run(&obs[..k], alts.map(|a| &a[..k]), &[]);
        if k == n.div_ceil(2) {
            mid = r;
        }
    }
    if n > 2 {
        let m = n / 2;
        let cut_alts = alts.map(|v| [&v[..m], &v[m + 1..]].concat());
        run(&[&obs[..m], &obs[m + 1..]].concat(), cut_alts.as_deref(), &[]);
        run(obs, alts, &[]);
    }
    // 前半句第二名的第一個詞當選字，接著打完
    if let Some(b) = mid.get(1).and_then(|p| p.breakdown.first()) {
        let f = [decode::FixedSpan {
            pos: 0,
            len: b.reading.len(),
            word: b.word.clone(),
        }];
        for k in n.div_ceil(2)..=n {
            run(&obs[..k], alts.map(|a| &a[..k]), &f);
        }
    }
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

pub(crate) fn load_legal(data: &str) -> HashSet<String> {
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

/// 重播事件檔：`k\t<code>\t<key>`（按鍵）、`c\t<k>`（送出第 k 候選）、`m`（切換模式）、
/// `t\t<ms>`（時鐘）、`s`（量學習檔：大小與項目數；耗時印到 stderr。debug-x2-growth.ts 產生）。
/// 每個事件輸出一行，格式同 debug-native-parity.ts
fn replay(eng: &mut engine::ImeEngine, events: &str) -> Vec<String> {
    let mut out = vec![];
    // `s` 事件之間的每鍵與送出耗時（ms）
    let (mut keys, mut commits): (Vec<f64>, Vec<f64>) = (vec![], vec![]);
    let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.0;
    let quiet = std::env::var("ZHUYIN_QUIET").is_ok();
    for line in events.lines().filter(|l| !l.is_empty()) {
        let f: Vec<&str> = line.split('\t').collect();
        match f[0] {
            "k" => {
                let key = f.get(2).filter(|k| !k.is_empty()).copied();
                let t = Instant::now();
                let st = eng.on_key(f[1], key, false);
                keys.push(ms(t));
                // ZHUYIN_QUIET：不留每鍵的輸出（長時間模擬量記憶體時，輸出本身會佔上百 MB）
                if quiet {
                    continue;
                }
                let menu = st.menu.map_or(String::new(), |m| {
                    format!("{}@{}/{}#{}", m.items.join("|"), m.page, m.pages, m.cursor)
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
            "c" => {
                let t = Instant::now();
                let text = eng.commit(f[1].parse().unwrap());
                commits.push(ms(t));
                out.push(format!("C\t{text}"));
            }
            // 時鐘（毫秒）
            "t" => eng.clock = Some(f[1].parse().unwrap()),
            // 量學習檔：大小與項目數進輸出（對拍），耗時、記憶體印到 stderr
            "s" => {
                let a = eng.adapter.as_ref().unwrap();
                let t = Instant::now();
                let json = a.to_json();
                let ser = ms(t);
                // 同 pime.rs save_adapter：寫暫存檔再改名
                let tmp = std::env::temp_dir().join("zhuyin-x2-growth.tmp");
                let t = Instant::now();
                std::fs::write(&tmp, &json).unwrap();
                std::fs::rename(&tmp, tmp.with_extension("json")).unwrap();
                let write = ms(t);
                let (seq, global, manual, mined) = a.stats();
                out.push(format!(
                    "S\t{}\t{seq}\t{global}\t{manual}\t{mined}",
                    json.len()
                ));
                keys.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let pct = |p: f64| keys[((keys.len() as f64 * p) as usize).min(keys.len() - 1)];
                let avg = commits.iter().sum::<f64>() / commits.len().max(1) as f64;
                eprintln!(
                    "[x2] {}KB bySeq {seq} global {global} 使用者詞 {manual} 挖詞 {mined} | 序列化 {ser:.1}ms 寫檔 {write:.1}ms | 每鍵 p50 {:.2} p95 {:.2} max {:.1}ms | 送出平均 {avg:.1}ms",
                    json.len() / 1024,
                    pct(0.5),
                    pct(0.95),
                    keys.last().unwrap()
                );
                mem("checkpoint");
                keys.clear();
                commits.clear();
            }
            "m" => {
                eng.toggle_mode();
                let m = if eng.mode == engine::Mode::English {
                    "english"
                } else {
                    "zhuyin"
                };
                out.push(format!("M\t{m}"));
            }
            _ => panic!("事件格式錯誤：{line}"),
        }
    }
    out
}

/// `usage` 指令：印出使用紀錄的統計（usage.rs），eval_out 寫成評測集格式
fn usage_report(file: &str, eval_out: Option<&str>) {
    let text = std::fs::read_to_string(file).unwrap_or_else(|e| panic!("{file}: {e}"));
    let s = usage::summary(&text);
    let n = |k: &str| s[k].as_f64().unwrap_or(0.0);
    let pct = |a: f64, b: f64| 100.0 * a / b.max(1.0);
    println!(
        "{} 次送出、{} 字、{} 鍵\n不用改就對 {:.1}%\n選字修正 {} 次（每 100 字 {:.2} 次）\n退格每 100 鍵 {:.1} 次\nL3 更正 {} 個音節",
        s["commits"],
        s["chars"],
        s["keys"],
        pct(n("right"), n("commits")),
        s["picks"],
        pct(n("picks"), n("chars")),
        pct(n("backspaces"), n("keys")),
        s["l3"],
    );
    for (key, title) in [("topFixes", "最常改的字（原本 → 改成）"), ("topL3", "L3 更正（打的 → 採用）")] {
        println!("\n{title}");
        for p in s[key].as_array().into_iter().flatten() {
            println!("  {}\t{}", p[1], p[0].as_str().unwrap_or(""));
        }
    }
    if let Some(out) = eval_out {
        let ev = usage::to_eval(&text, file);
        std::fs::write(out, &ev).unwrap();
        eprintln!("{} 句 -> {out}", ev.lines().count() - 1);
    }
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
    if is_pime {
        let adapter_file = match std::env::var("ZHUYIN_ADAPTER") {
            Ok(f) if f == "off" => None,
            Ok(f) => Some(std::path::PathBuf::from(f)),
            Err(_) => std::env::var("APPDATA")
                .ok()
                .map(|d| std::path::Path::new(&d).join("PIME/zhuyin/adapter.json")),
        };
        let idle: f64 = std::env::var("ZHUYIN_IDLE_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(300.0);
        // PIMELauncher 丟掉後端的 stderr：改寫到記錄檔，後端死掉（panic、結束）才查得到原因
        match std::env::var("ZHUYIN_LOG") {
            Ok(f) if f == "off" => {}
            Ok(f) => pime::log_to_file(std::path::Path::new(&f)),
            Err(_) => {
                if let Ok(d) = std::env::var("APPDATA") {
                    pime::log_to_file(&std::path::Path::new(&d).join("PIME/zhuyin/backend.log"));
                }
            }
        }
        pime::serve(pime::Backend::new(pime::Config {
            data,
            adapter_file,
            l3: std::env::var("ZHUYIN_L3").map_or(true, |v| v != "0"),
            icon_dir: exe_dir.join("input_methods").join("zhuyin"),
            idle: pime::secs(idle, 300.0),
            settings_file: match std::env::var("ZHUYIN_CONFIG") {
                Ok(f) if f == "off" => None,
                Ok(f) => Some(std::path::PathBuf::from(f)),
                Err(_) => std::env::var("APPDATA")
                    .ok()
                    .map(|d| std::path::Path::new(&d).join("PIME/zhuyin/config.json")),
            },
        }));
        return;
    }
    if args.get(1).map(String::as_str) == Some("usage") {
        usage_report(&args[2], args.get(3).map(String::as_str));
        return;
    }
    let a: f64 = std::env::var("ZHUYIN_A").map_or(1.0, |s| s.parse().unwrap());
    let t0 = Instant::now();
    let lm_file = std::env::var("ZHUYIN_LM").unwrap_or_else(|_| format!("{data}/models/lm.bo.bin"));
    let lm = lm::BackoffLm::load(&lm_file).unwrap();
    let lex = lexicon::Lexicon::load(&format!("{data}/processed/lexicon.bin")).unwrap();
    let mut dec = decode::Decoder::new(lm, lex, a, 0.5);
    let legal = load_legal(&data);
    eprintln!("載入 {:?}", t0.elapsed());
    mem("載入後");

    let t1 = Instant::now();
    let mut done = 0;
    match args.get(1).map(String::as_str) {
        Some("eval") => {
            let env = |k: &str| std::env::var(k).ok().map(|v| v.parse::<f64>().unwrap());
            if let Some(v) = env("ZHUYIN_GAMMA") {
                dec.gamma = v;
            }
            if let Some(v) = env("ZHUYIN_POLY") {
                dec.poly_penalty = v;
            }
            if let Some(v) = env("ZHUYIN_POLY_MINOR") {
                dec.poly_minor_penalty = v;
            }
            if let Some(v) = env("ZHUYIN_BEAM") {
                dec.beam = v as usize;
            }
            let n_best = env("ZHUYIN_NBEST").map_or(4, |v| v as usize);
            // ZHUYIN_L3_SCALE＝s：開 L3、代價＝初始值 × s（同 l3 指令）；ZHUYIN_L3：開 L3、預設代價
            let ch = match env("ZHUYIN_L3_SCALE") {
                Some(s) => {
                    let mut o = scaled(s);
                    if let Some(v) = env("ZHUYIN_L3_NASAL") {
                        o.nasal = v;
                    }
                    if let Some(v) = env("ZHUYIN_L3_MAXALTS") {
                        o.max_alts = v as usize;
                    }
                    Some(l3::Channel::new(legal.clone(), o))
                }
                None => std::env::var("ZHUYIN_L3")
                    .is_ok_and(|v| v != "0")
                    .then(|| l3::Channel::new(legal.clone(), Default::default())),
            };
            // ZHUYIN_NOISE＝key,cog：注入錯誤；每句固定種子 1000+i，每個設定看到同一組錯誤
            let noise = std::env::var("ZHUYIN_NOISE").ok().map(|v| {
                let p: Vec<f64> = v.split(',').map(|x| x.parse().unwrap()).collect();
                noise::NoiseOptions {
                    key: p[0],
                    cognitive: p[1],
                }
            });
            let mut fails = vec![];
            // ZHUYIN_INCR=1：逐音節增量解碼，每步和全量解碼比對（不同就 panic），印每步延遲
            let incr = std::env::var("ZHUYIN_INCR").is_ok_and(|v| v != "0");
            let mut steps: [Vec<f64>; 2] = [vec![], vec![]];
            let files = std::env::var("ZHUYIN_EVAL").unwrap_or_else(|_| {
                "eval/colloquial.jsonl,eval/written.jsonl,eval/mixed.jsonl".into()
            });
            for f in files.split(',') {
                let samples = load_samples(f);
                let n = samples.len();
                // 句準分 dev（偶數句）／test（奇數句）
                let (mut ok, mut oracle, mut changed) = ([0usize; 2], 0, 0);
                let (mut char_ok, mut char_total) = (0, 0);
                let (mut err, mut hit) = (0, 0);
                let mut lat = vec![];
                for (i, s) in samples.iter().enumerate() {
                    let obs = match &noise {
                        Some(o) => noise::inject_noise(
                            &s.syllables,
                            &legal,
                            o,
                            &mut noise::Rng::new(1000 + i as u32),
                        ),
                        None => s.syllables.clone(),
                    };
                    if obs != s.syllables {
                        changed += 1;
                    }
                    let alts: Option<Vec<_>> =
                        ch.as_ref().map(|c| obs.iter().map(|x| c.expand(x)).collect());
                    // 涵蓋率：注入錯誤的音節裡，正確音節出現在展開裡的比例（L3 的上限）
                    if let (Some(alts), true) = (&alts, obs.len() == s.syllables.len()) {
                        for (j, o) in obs.iter().enumerate() {
                            if *o != s.syllables[j] {
                                err += 1;
                                hit += alts[j].iter().any(|h| h.syl == s.syllables[j]) as usize;
                            }
                        }
                    }
                    let o = decode::DecodeOptions {
                        n_best,
                        alternatives: alts.as_deref(),
                        ..Default::default()
                    };
                    if incr {
                        incr_check(&dec, &obs, alts.as_deref(), n_best, &mut steps);
                    }
                    let t = Instant::now();
                    let paths = dec.decode(&obs, &o);
                    lat.push(t.elapsed().as_secs_f64() * 1000.0);
                    let out = paths.first().map_or(String::new(), |p| p.text());
                    // 逐字比較用 code point；沒有結果也算進分母
                    let r: Vec<char> = s.text.chars().collect();
                    char_ok += out.chars().zip(&r).filter(|(a, b)| a == *b).count();
                    char_total += r.len();
                    if out == s.text {
                        ok[i % 2] += 1;
                    } else {
                        fails.push(format!("{f}\t{}\n\t{out}", s.text));
                    }
                    oracle += paths.iter().any(|p| p.text() == s.text) as usize;
                }
                done += n;
                lat.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let pct = |a: usize, b: usize| 100.0 * a as f64 / b.max(1) as f64;
                let mut line = format!(
                    "{f}: n={n} 句準 {:.2}%（dev {:.1} test {:.1}）字準 {:.2}% oracle@{n_best} {:.1}% p50 {:.1}ms p95 {:.1}ms",
                    pct(ok[0] + ok[1], n),
                    pct(ok[0], n.div_ceil(2)),
                    pct(ok[1], n / 2),
                    pct(char_ok, char_total),
                    pct(oracle, n),
                    lat[lat.len() / 2],
                    lat[(lat.len() as f64 * 0.95) as usize],
                );
                if noise.is_some() {
                    line += &format!(" | 有錯的句子 {:.1}%", pct(changed, n));
                }
                if ch.is_some() && err > 0 {
                    line += &format!(" | 涵蓋 {hit}/{err} {:.1}%", pct(hit, err));
                }
                println!("{line}");
            }
            if incr {
                for (name, v) in ["全量", "增量"].iter().zip(&mut steps) {
                    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    let q = |p: f64| v[((v.len() as f64 * p) as usize).min(v.len() - 1)];
                    println!(
                        "每步{name}（{} 步，相同）p50 {:.2} p95 {:.2} p99 {:.2} max {:.2} ms 合計 {:.0}ms",
                        v.len(),
                        q(0.5),
                        q(0.95),
                        q(0.99),
                        v[v.len() - 1],
                        v.iter().sum::<f64>()
                    );
                }
            }
            if let Some(out) = args.get(2) {
                std::fs::write(out, fails.join("\n")).unwrap();
                eprintln!("{} 句錯 -> {out}", fails.len());
            }
        }
        Some("dump") => {
            let out = args.get(2).expect("dump <out> [nBest] [l3]");
            let n_best = args.get(3).map_or(4, |s| s.parse().unwrap());
            let ch = (args.get(4).map(String::as_str) == Some("l3"))
                .then(|| l3::Channel::new(legal.clone(), Default::default()));
            let mut lines = vec![];
            // 加上中英評測集：原樣英文 token 也要對拍
            for s in eval_samples()
                .into_iter()
                .chain(load_samples("eval/mixed.jsonl"))
            {
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
            let clock: Option<f64> = std::env::var("ZHUYIN_CLOCK")
                .ok()
                .map(|s| s.parse().unwrap());
            let mut adapter = match std::env::var("ZHUYIN_ADAPTER") {
                Ok(f) => {
                    let s = std::fs::read_to_string(&f).unwrap();
                    match clock {
                        Some(at) => x2::UserAdapter::from_json_at(&s, at),
                        None => x2::UserAdapter::from_json(&s),
                    }
                    .unwrap()
                }
                Err(_) => x2::UserAdapter::new(),
            };
            // 使用者詞條（手動造詞＋歷史挖詞）注入解碼格，同 runtime.ts
            for e in adapter.drain_pending() {
                dec.add_entry(&e.word, &e.readings);
            }
            mem("讀學習檔後");
            let mut eng = engine::ImeEngine::new(dec, legal.clone(), Some(adapter));
            if std::env::var("ZHUYIN_L3").is_ok() {
                eng.channel = Some(l3::Channel::new(legal.clone(), Default::default()));
            }
            eng.clock = clock;
            let events = std::fs::read_to_string(&args[2]).unwrap();
            let lines = replay(&mut eng, &events);
            done = lines.len();
            std::fs::write(&args[3], lines.join("\n")).unwrap();
            if let Some(f) = args.get(4) {
                std::fs::write(f, eng.adapter.as_ref().unwrap().to_json()).unwrap();
            }
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
