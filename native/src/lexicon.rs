//! 讀音 → 詞 索引 lexicon.bin 的唯讀移植（packages/core/src/lexicon.ts LexiconIndex.fromBytes）。
//! 執行中新增詞的疊加層（使用者造詞、挖詞）還沒移植。
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub struct Lexicon {
    syl_id: HashMap<String, u16>,
    /// 所有詞串在一起；第 i 個詞是 text[woff[i]..woff[i+1]]
    text: String,
    woff: Vec<u32>,
    rd: Vec<u16>,
    rd_off: Vec<u32>,
    wl: Vec<u32>,
    w_off: Vec<u32>,
    slots: Vec<i32>,
    /// 第 i 個詞是不是破音單字（有多個讀音的單字）
    pub poly: Vec<bool>,
    pub poly_set: HashSet<String>,
}

fn hash_ids(ids: &[u16]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &i in ids {
        h = (h ^ i as u32).wrapping_mul(0x0100_0193);
    }
    h ^ (h >> 15)
}

impl Lexicon {
    pub fn load(path: &str) -> Result<Lexicon, String> {
        let buf = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
        if &buf[..8] != b"ZYLEX001" {
            return Err(format!("{path} 不是詞典索引格式"));
        }
        let hlen = u32::from_le_bytes(buf[8..12].try_into().unwrap()) as usize;
        let layout: Value =
            serde_json::from_slice(&buf[12..12 + hlen]).map_err(|e| e.to_string())?;
        let base = (12 + hlen).div_ceil(4) * 4;
        let seg = |name: &str| -> &[u8] {
            let o = layout[name][0].as_u64().unwrap() as usize;
            let n = layout[name][1].as_u64().unwrap() as usize;
            &buf[base + o..base + o + n]
        };
        let lines = |name: &str| -> Vec<&str> {
            let s = std::str::from_utf8(seg(name)).unwrap();
            if s.is_empty() {
                vec![]
            } else {
                s.split('\n').collect()
            }
        };
        let u16s = |name: &str| {
            seg(name)
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect()
        };
        let u32s = |name: &str| {
            seg(name)
                .chunks_exact(4)
                .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
                .collect()
        };

        let syl_id = lines("syllables")
            .iter()
            .enumerate()
            .map(|(i, s)| (s.to_string(), i as u16))
            .collect();
        let poly_set: HashSet<String> = lines("poly").iter().map(|s| s.to_string()).collect();
        let mut text = String::new();
        let mut woff = vec![0u32];
        let mut poly = vec![];
        for w in lines("words") {
            text.push_str(w);
            woff.push(text.len() as u32);
            poly.push(w.chars().count() == 1 && poly_set.contains(w));
        }
        let rd: Vec<u16> = u16s("rd");
        let rd_off: Vec<u32> = u32s("rdOff");
        // 與 TS 相同的開放定址表（cap ≥ n/0.6 的 2 的冪）
        let n = rd_off.len() - 1;
        let mut cap = 16usize;
        while (cap as f64) < n as f64 / 0.6 {
            cap *= 2;
        }
        let mut slots = vec![-1i32; cap];
        for k in 0..n {
            let mut i =
                hash_ids(&rd[rd_off[k] as usize..rd_off[k + 1] as usize]) as usize & (cap - 1);
            while slots[i] != -1 {
                i = (i + 1) & (cap - 1);
            }
            slots[i] = k as i32;
        }
        Ok(Lexicon {
            syl_id,
            text,
            woff,
            rd,
            rd_off,
            wl: u32s("wl"),
            w_off: u32s("wOff"),
            slots,
            poly,
            poly_set,
        })
    }

    pub fn word_count(&self) -> usize {
        self.woff.len() - 1
    }

    pub fn word(&self, i: u32) -> &str {
        &self.text[self.woff[i as usize] as usize..self.woff[i as usize + 1] as usize]
    }

    /// 最長讀音的音節數
    pub fn max_span(&self) -> usize {
        self.rd_off
            .windows(2)
            .map(|w| (w[1] - w[0]) as usize)
            .max()
            .unwrap_or(1)
            .max(1)
    }

    /// 讀音的前 cap 個詞編號（高頻在前）
    pub fn each(&self, reading: &[String], cap: usize, mut f: impl FnMut(u32)) {
        let mut ids = Vec::with_capacity(reading.len());
        for s in reading {
            match self.syl_id.get(s) {
                Some(&i) => ids.push(i),
                None => return,
            }
        }
        let mask = self.slots.len() - 1;
        let mut i = hash_ids(&ids) as usize & mask;
        loop {
            let k = self.slots[i];
            if k == -1 {
                return;
            }
            let k = k as usize;
            if self.rd[self.rd_off[k] as usize..self.rd_off[k + 1] as usize] == ids[..] {
                let lo = self.w_off[k] as usize;
                let hi = (self.w_off[k + 1] as usize).min(lo + cap);
                for &w in &self.wl[lo..hi] {
                    f(w);
                }
                return;
            }
            i = (i + 1) & mask;
        }
    }
}
