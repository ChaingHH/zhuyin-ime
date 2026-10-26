//! 單元測試用的極小資料：手造 lexicon.bin（ZYLEX002）與平坦的 lm.bo.bin（所有查詢都查不到、回 unseen），
//! 不需要 data/ 裡的大模型。平坦 LM 下每個詞分數相同，所以詞數少（長詞）的路徑贏。
use crate::decode::Decoder;
use crate::engine::ImeEngine;
use crate::keymap::Layout;
use crate::lexicon::Lexicon;
use crate::lm::BackoffLm;
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};

fn temp_file(ext: &str) -> std::path::PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join("zhuyin-native-test");
    std::fs::create_dir_all(&dir).unwrap();
    // 映射中的檔刪不掉（Windows），留在暫存目錄；檔名帶 pid 免得兩次執行互相蓋
    let n = N.fetch_add(1, Ordering::Relaxed);
    dir.join(format!("{}-{n}.{ext}", std::process::id()))
}

/// 魔術字＋u32 標頭長度＋JSON 標頭，資料區從 align 的倍數開始
fn pack(magic: &[u8], header: &str, align: usize, data: &[u8]) -> Vec<u8> {
    let mut out = magic.to_vec();
    out.extend((header.len() as u32).to_le_bytes());
    out.extend(header.as_bytes());
    out.resize(out.len().div_ceil(align) * align, 0);
    out.extend(data);
    out
}

/// entries：(讀音（音節以空白相接）, 詞)，同讀音依出現順序＝高頻在前；poly：(破音單字, 主讀音)
pub fn lexicon(entries: &[(&str, &str)], poly: &[(&str, &str)]) -> Lexicon {
    let mut syls: Vec<&str> = vec![];
    let mut words: Vec<&str> = vec![];
    let mut keys: Vec<(&str, Vec<u32>)> = vec![];
    for &(rd, w) in entries {
        for s in rd.split(' ') {
            if !syls.contains(&s) {
                syls.push(s);
            }
        }
        let wi = words.iter().position(|x| *x == w).unwrap_or_else(|| {
            words.push(w);
            words.len() - 1
        }) as u32;
        match keys.iter_mut().find(|k| k.0 == rd) {
            Some(k) => k.1.push(wi),
            None => keys.push((rd, vec![wi])),
        }
    }
    let (mut rd, mut rd_off, mut wl, mut w_off) =
        (vec![], vec![0u32], Vec::<u32>::new(), vec![0u32]);
    for (r, ws) in &keys {
        rd.extend(
            r.split(' ')
                .map(|s| syls.iter().position(|x| x == &s).unwrap() as u16),
        );
        rd_off.push(rd.len() as u32);
        wl.extend(ws);
        w_off.push(wl.len() as u32);
    }
    let poly: Vec<String> = poly.iter().map(|(w, r)| format!("{w}\t{r}")).collect();
    let segs: Vec<(&str, Vec<u8>)> = vec![
        ("syllables", syls.join("\n").into_bytes()),
        ("poly", poly.join("\n").into_bytes()),
        ("words", words.join("\n").into_bytes()),
        ("rd", rd.iter().flat_map(|x| x.to_le_bytes()).collect()),
        (
            "rdOff",
            rd_off.iter().flat_map(|x| x.to_le_bytes()).collect(),
        ),
        ("wl", wl.iter().flat_map(|x| x.to_le_bytes()).collect()),
        ("wOff", w_off.iter().flat_map(|x| x.to_le_bytes()).collect()),
    ];
    let (mut data, mut layout) = (vec![], serde_json::Map::new());
    for (name, bytes) in segs {
        layout.insert(name.into(), serde_json::json!([data.len(), bytes.len()]));
        data.extend(bytes);
    }
    let header = serde_json::Value::Object(layout).to_string();
    let f = temp_file("lexicon.bin");
    std::fs::write(&f, pack(b"ZYLEX002", &header, 4, &data)).unwrap();
    Lexicon::load(f.to_str().unwrap()).unwrap()
}

/// 每張表都只有一格、指紋 0（永遠不中），所以每個詞、每個字都是 unseen
pub fn flat_lm(unseen: f64) -> BackoffLm {
    let t = r#"{"seed":0,"bits":8,"fpBits":16,"arrays":[[0,8],[0,8],[0,8],[0,8]],"luts":[[0,8],[0,8]]}"#;
    let ex = format!(r#"{{"uni":{t},"bi":{t},"tri":{t},"unseen":{unseen}}}"#);
    let header = format!(r#"{{"word":{ex},"char":{ex}}}"#);
    let f = temp_file("lm.bo.bin");
    std::fs::write(&f, pack(b"ZYLMBO01", &header, 8, &[0; 8])).unwrap();
    BackoffLm::load(f.to_str().unwrap()).unwrap()
}

pub fn decoder(entries: &[(&str, &str)]) -> Decoder {
    Decoder::new(flat_lm(-10.0), lexicon(entries, &[]), 1.0, 0.5)
}

/// 合法音節＝詞典裡出現的音節加上 extra
pub fn legal(entries: &[(&str, &str)], extra: &[&str]) -> HashSet<String> {
    entries
        .iter()
        .flat_map(|(r, _)| r.split(' '))
        .chain(extra.iter().copied())
        .map(String::from)
        .collect()
}

/// 測試用引擎：有學習（固定時鐘），沒有 L3
pub fn engine(entries: &[(&str, &str)]) -> ImeEngine {
    let mut e = ImeEngine::new(
        decoder(entries),
        legal(entries, &[]),
        Some(crate::x2::UserAdapter::new()),
    );
    e.clock = Some(1.7e12);
    e
}

/// 照大千打一串音節（空白分隔）
pub fn type_syllables(e: &mut ImeEngine, syls: &str) {
    for s in syls.split(' ') {
        for code in Layout::Dachen.syllable_to_key_codes(s) {
            e.on_key(&code, None, false);
        }
    }
}
