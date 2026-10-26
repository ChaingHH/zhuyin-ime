//! 讀音 → 詞 索引 lexicon.bin 的唯讀移植（packages/core/src/lexicon.ts LexiconIndex.fromBytes）。
//! 執行中新增的詞（使用者造詞、挖詞）放在疊加層，語意同 LexiconIndex.add：接在該讀音清單最後。
use serde_json::Value;
use std::collections::HashMap;

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
    /// 破音單字 → 主讀音（詞典的第一個讀音）
    pub poly_set: HashMap<String, String>,
    /// 疊加層：基本詞典沒有的詞（編號接在基本詞後面）
    added: Vec<String>,
    /// 加詞時查詞編號用：基本詞依字串排序的編號（第一次加詞才建，約 1MB）、疊加層的詞 → 編號
    by_text: Vec<u32>,
    added_id: HashMap<String, u32>,
    /// 已有讀音的新詞（鍵編號 → 詞編號）、全新讀音（音節編號 → 詞編號）
    extra_by_key: HashMap<usize, Vec<u32>>,
    extra_new: HashMap<Vec<u16>, Vec<u32>>,
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
        if &buf[..8] != b"ZYLEX002" {
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
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .collect()
        };
        let u32s = |name: &str| {
            seg(name)
                .as_chunks::<4>()
                .0
                .iter()
                .map(|c| u32::from_le_bytes(*c))
                .collect()
        };

        let syl_id = lines("syllables")
            .iter()
            .enumerate()
            .map(|(i, s)| (s.to_string(), i as u16))
            .collect();
        let poly_set: HashMap<String, String> = lines("poly")
            .iter()
            .filter_map(|l| l.split_once('\t'))
            .map(|(w, r)| (w.to_string(), r.to_string()))
            .collect();
        let mut text = String::new();
        let mut woff = vec![0u32];
        let mut poly = vec![];
        for w in lines("words") {
            text.push_str(w);
            woff.push(text.len() as u32);
            poly.push(w.chars().count() == 1 && poly_set.contains_key(w));
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
            added: vec![],
            by_text: vec![],
            added_id: HashMap::new(),
            extra_by_key: HashMap::new(),
            extra_new: HashMap::new(),
        })
    }

    fn base_count(&self) -> usize {
        self.woff.len() - 1
    }

    /// 詞數（含疊加層新增的）
    pub fn word_count(&self) -> usize {
        self.base_count() + self.added.len()
    }

    pub fn word(&self, i: u32) -> &str {
        let i = i as usize;
        if i < self.base_count() {
            &self.text[self.woff[i] as usize..self.woff[i + 1] as usize]
        } else {
            &self.added[i - self.base_count()]
        }
    }

    /// 破音單字（有多個讀音的單字）
    pub fn is_poly(&self, i: u32) -> bool {
        match self.poly.get(i as usize) {
            Some(&p) => p,
            None => {
                let w = self.word(i);
                w.chars().count() == 1 && self.poly_set.contains_key(w)
            }
        }
    }

    /// 最長讀音的音節數
    pub fn max_span(&self) -> usize {
        self.rd_off
            .windows(2)
            .map(|w| (w[1] - w[0]) as usize)
            .chain(self.extra_new.keys().map(Vec::len))
            .max()
            .unwrap_or(1)
            .max(1)
    }

    fn to_ids(&self, reading: &[String]) -> Option<Vec<u16>> {
        reading
            .iter()
            .map(|s| self.syl_id.get(s).copied())
            .collect()
    }

    fn find_key(&self, ids: &[u16]) -> Option<usize> {
        let mask = self.slots.len() - 1;
        let mut i = hash_ids(ids) as usize & mask;
        loop {
            let k = self.slots[i];
            if k == -1 {
                return None;
            }
            let k = k as usize;
            if self.rd[self.rd_off[k] as usize..self.rd_off[k + 1] as usize] == *ids {
                return Some(k);
            }
            i = (i + 1) & mask;
        }
    }

    /// 讀音的前 cap 個詞編號（高頻在前；疊加層的接在後面）
    pub fn each(&self, reading: &[String], cap: usize, mut f: impl FnMut(u32)) {
        let Some(ids) = self.to_ids(reading) else {
            return;
        };
        let extra = match self.find_key(&ids) {
            Some(k) => {
                let lo = self.w_off[k] as usize;
                let hi = (self.w_off[k + 1] as usize).min(lo.saturating_add(cap));
                for &w in &self.wl[lo..hi] {
                    f(w);
                }
                self.extra_by_key.get(&k).map(|x| (x, cap - (hi - lo)))
            }
            None => self.extra_new.get(&ids).map(|x| (x, cap)),
        };
        if let Some((x, left)) = extra {
            for &w in x.iter().take(left) {
                f(w);
            }
        }
    }

    pub fn has(&self, reading: &[String], word: &str) -> bool {
        let mut found = false;
        self.each(reading, usize::MAX, |w| found |= self.word(w) == word);
        found
    }

    /// 詞字串的編號（基本詞典或疊加層）。線性掃描每次約 1ms，載入幾千個使用者詞要好幾秒，所以建排序索引
    fn find_word(&mut self, word: &str) -> Option<u32> {
        if self.by_text.is_empty() {
            let mut ids: Vec<u32> = (0..self.base_count() as u32).collect();
            ids.sort_unstable_by(|&a, &b| self.word(a).cmp(self.word(b)));
            self.by_text = ids;
        }
        match self.by_text.binary_search_by(|&i| self.word(i).cmp(word)) {
            Ok(k) => Some(self.by_text[k]),
            Err(_) => self.added_id.get(word).copied(),
        }
    }

    /// 執行中新增一個詞（接在該讀音清單最後）。已存在就不動
    pub fn add(&mut self, reading: &[String], word: &str) {
        if self.has(reading, word) {
            return;
        }
        for s in reading {
            if !self.syl_id.contains_key(s) {
                let id = self.syl_id.len() as u16;
                self.syl_id.insert(s.clone(), id);
            }
        }
        let w = self.find_word(word).unwrap_or_else(|| {
            self.added.push(word.to_string());
            let id = self.word_count() as u32 - 1;
            self.added_id.insert(word.to_string(), id);
            id
        });
        let ids = self.to_ids(reading).unwrap();
        match self.find_key(&ids) {
            Some(k) => self.extra_by_key.entry(k).or_default().push(w),
            None => self.extra_new.entry(ids).or_default().push(w),
        }
    }

    /// 拿掉執行中加的詞（學習資料頁的刪除）。基本詞典的詞拿不掉；詞字串留在疊加層，之後再加回來沿用同一個編號
    pub fn remove(&mut self, reading: &[String], word: &str) {
        let (Some(ids), Some(w)) = (self.to_ids(reading), self.find_word(word)) else {
            return;
        };
        let list = match self.find_key(&ids) {
            Some(k) => self.extra_by_key.get_mut(&k),
            None => self.extra_new.get_mut(&ids),
        };
        if let Some(l) = list {
            l.retain(|&x| x != w);
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::lexicon;

    fn rd(s: &str) -> Vec<String> {
        s.split(' ').map(String::from).collect()
    }

    fn words(l: &super::Lexicon, r: &str) -> Vec<String> {
        let mut out = vec![];
        l.each(&rd(r), usize::MAX, |w| out.push(l.word(w).to_string()));
        out
    }

    #[test]
    fn lookup_keeps_order_and_overlay() {
        let mut l = lexicon(
            &[
                ("ㄋㄧˇ", "你"),
                ("ㄋㄧˇ", "擬"),
                ("ㄋㄧˇ ㄏㄠˇ", "你好"),
                ("ㄏㄠˇ", "好"),
            ],
            &[("好", "ㄏㄠˇ")],
        );
        assert_eq!(words(&l, "ㄋㄧˇ"), ["你", "擬"]);
        assert!(words(&l, "ㄇㄚ").is_empty());
        assert_eq!(l.max_span(), 2);
        assert_eq!(l.word_count(), 4);
        let mut first = vec![];
        l.each(&rd("ㄋㄧˇ"), 1, |w| first.push(w));
        assert_eq!(first.len(), 1);
        // 破音單字
        let id = |l: &super::Lexicon, w: &str| {
            (0..l.word_count() as u32)
                .find(|&i| l.word(i) == w)
                .unwrap()
        };
        assert!(l.is_poly(id(&l, "好")) && !l.is_poly(id(&l, "你")));
        // 疊加層：接在該讀音最後；已有的詞沿用編號；全新讀音、全新音節也行
        l.add(&rd("ㄋㄧˇ"), "妳");
        l.add(&rd("ㄋㄧˇ"), "你");
        l.add(&rd("ㄏㄠˇ"), "你");
        l.add(&rd("ㄓㄨㄤˋ ㄊㄞˋ ㄌㄢˊ"), "狀態欄");
        assert_eq!(words(&l, "ㄋㄧˇ"), ["你", "擬", "妳"]);
        assert_eq!(words(&l, "ㄏㄠˇ"), ["好", "你"]);
        assert!(l.has(&rd("ㄓㄨㄤˋ ㄊㄞˋ ㄌㄢˊ"), "狀態欄"));
        assert_eq!(l.max_span(), 3);
        assert_eq!(l.word_count(), 6);
        // 基本詞典的詞拿不掉，疊加層的可以
        l.remove(&rd("ㄋㄧˇ"), "你");
        l.remove(&rd("ㄋㄧˇ"), "妳");
        assert_eq!(words(&l, "ㄋㄧˇ"), ["你", "擬"]);
        l.add(&rd("ㄋㄧˇ"), "妳");
        assert_eq!(l.word_count(), 6);
    }
}
