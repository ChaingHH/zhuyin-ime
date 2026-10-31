//! 退回式語言模型 lm.bo.bin 的唯讀移植：packages/lm/src/backoff.ts（BackoffLM）
//! 與 hashtable.ts（雜湊、PerfectTable）。雜湊逐 UTF-16 碼元餵入（JS charCodeAt），結果與 TS 逐位元相同。
use serde_json::Value;
use std::os::windows::io::AsRawHandle;

#[link(name = "kernel32")]
extern "system" {
    fn CreateFileMappingW(f: isize, sa: usize, prot: u32, hi: u32, lo: u32, name: usize) -> isize;
    fn MapViewOfFile(m: isize, access: u32, hi: u32, lo: u32, n: usize) -> *const u8;
    fn UnmapViewOfFile(p: *const u8) -> i32;
    fn CloseHandle(h: isize) -> i32;
}

/// 唯讀映射整個檔案：頁面算檔案映射（可共用、閒置時 Windows 可以修剪），不算私有記憶體。
/// drop 時解除映射
struct Mapping(*const u8);

impl Mapping {
    fn open(path: &str) -> Result<(Mapping, usize), String> {
        let f = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
        let len = f.metadata().map_err(|e| e.to_string())?.len() as usize;
        const PAGE_READONLY: u32 = 2;
        const FILE_MAP_READ: u32 = 4;
        unsafe {
            let m = CreateFileMappingW(f.as_raw_handle() as isize, 0, PAGE_READONLY, 0, 0, 0);
            if m == 0 {
                return Err(format!("{path}: CreateFileMapping 失敗"));
            }
            let p = MapViewOfFile(m, FILE_MAP_READ, 0, 0, 0);
            CloseHandle(m); // 映射本身由 view 撐著
            if p.is_null() {
                return Err(format!("{path}: MapViewOfFile 失敗"));
            }
            Ok((Mapping(p), len))
        }
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        unsafe { UnmapViewOfFile(self.0) };
    }
}

fn fmix(mut h: u32) -> u32 {
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^ (h >> 16)
}

/// hashtable.ts 的 feed／feedCode／finish
#[derive(Clone, Copy)]
pub struct Hasher {
    a: u32,
    b: u32,
    len: u32,
}

impl Hasher {
    fn new() -> Self {
        Hasher {
            a: 0x811c_9dc5,
            b: 0,
            len: 0,
        }
    }
    fn code(&mut self, c: u32) {
        self.a = (self.a ^ c).wrapping_mul(0x0100_0193);
        self.b = self.b.wrapping_mul(31).wrapping_add(c);
        self.len += 1;
    }
    fn finish(self) -> (u32, u32) {
        let h1 = fmix(self.a);
        (if h1 == 0 { 1 } else { h1 }, fmix(self.b ^ self.len))
    }
}

/// 可餵進雜湊的鍵片段：詞（&str）或單字（char）
pub trait Feed {
    fn feed(&self, h: &mut Hasher);
}
impl Feed for str {
    fn feed(&self, h: &mut Hasher) {
        for c in self.encode_utf16() {
            h.code(c as u32);
        }
    }
}
impl Feed for char {
    fn feed(&self, h: &mut Hasher) {
        let mut b = [0u16; 2];
        for c in self.encode_utf16(&mut b) {
            h.code(*c as u32);
        }
    }
}

fn hash1<T: Feed + ?Sized>(x: &T) -> (u32, u32) {
    let mut h = Hasher::new();
    x.feed(&mut h);
    h.finish()
}
/// `${x} ${y}`
fn hash2<T: Feed + ?Sized>(x: &T, y: &T) -> (u32, u32) {
    let mut h = Hasher::new();
    x.feed(&mut h);
    h.code(32);
    y.feed(&mut h);
    h.finish()
}
/// `${x} ${y}\t${z}`
fn hash3<T: Feed + ?Sized>(x: &T, y: &T, z: &T) -> (u32, u32) {
    let mut h = Hasher::new();
    x.feed(&mut h);
    h.code(32);
    y.feed(&mut h);
    h.code(9);
    z.feed(&mut h);
    h.finish()
}

/// JS 的 Math.floor((h * n) / 2^32)：用 f64 算（h·n 可能超過 2^53，整數算法在進位邊界會差一）
fn pick(h: u32, n: usize) -> usize {
    ((h as f64) * (n as f64) / 4294967296.0).floor() as usize
}

enum Fp {
    U16(&'static [u16]),
    U32(&'static [u32]),
}
enum Col {
    U8(&'static [u8]),
    U16(&'static [u16]),
}

/// 最小完美雜湊表（hashtable.ts PerfectTable），陣列直接指進模型檔的映射。
/// 'static 是假的：只在擁有映射的 BackoffLm 活著時有效，不能拿出 BackoffLm 外
struct Table {
    seed: u32,
    pilots: &'static [u16],
    fp: Fp,
    cols: Vec<Col>,
    luts: Vec<&'static [f64]>,
}

impl Table {
    fn found(&self, (h1, h2): (u32, u32), col: usize) -> f64 {
        let b = pick(fmix(h2 ^ self.seed), self.pilots.len());
        let p = self.pilots[b] as u32;
        let ns = match self.fp {
            Fp::U16(f) => f.len(),
            Fp::U32(f) => f.len(),
        };
        let s = pick(fmix(h1 ^ (p + 1).wrapping_mul(0x9e37_79b1) ^ self.seed), ns);
        let hit = match self.fp {
            Fp::U16(f) => f[s] as u32 == ((h2 >> 16).max(1)),
            Fp::U32(f) => f[s] == h2.max(1),
        };
        if !hit {
            return 0.0;
        }
        let code = match self.cols[col] {
            Col::U8(c) => c[s] as usize,
            Col::U16(c) => c[s] as usize,
        };
        self.luts[col][code]
    }
}

struct Expert {
    uni: Table,
    bi: Table,
    tri: Table,
    unseen: f64,
}

impl Expert {
    /// BackoffLM.logProb：表裡的機率都是負的，查不到回 0；退回權重查不到也是 0（α=1）
    fn log_prob<T: Feed + ?Sized>(&self, w: &T, c1: &T, c2: &T) -> f64 {
        // 有存的三元，其上下文二元一定有存：上下文沒有就不查三元表（擋掉指紋誤中，TS 同）
        let mut a = 0.0;
        let ctx = hash2(c1, c2);
        if self.bi.found(ctx, 0) != 0.0 {
            let p3 = self.tri.found(hash3(c1, c2, w), 0);
            if p3 != 0.0 {
                return p3;
            }
            a = self.bi.found(ctx, 1);
        }
        let p2 = self.bi.found(hash2(c2, w), 0);
        if p2 != 0.0 {
            return a + p2;
        }
        a += self.uni.found(hash1(c2), 1);
        let p1 = self.uni.found(hash1(w), 0);
        a + if p1 != 0.0 { p1 } else { self.unseen }
    }
}

pub struct BackoffLm {
    word: Expert,
    char: Expert,
    /// 欄位依宣告順序 drop：表先、映射最後
    _map: Mapping,
}

impl BackoffLm {
    pub fn word_log_prob(&self, w: &str, w1: &str, w2: &str) -> f64 {
        self.word.log_prob(w, w1, w2)
    }

    /// 詞的一元 log 機率（不看上下文）；沒存回 unseen
    pub fn word_unigram(&self, w: &str) -> f64 {
        let p = self.word.uni.found(hash1(w), 0);
        if p != 0.0 {
            p
        } else {
            self.word.unseen
        }
    }

    /// 詞一元表裡有這個詞（TS BackoffLM.knowsWord）
    pub fn knows_word(&self, w: &str) -> bool {
        self.word.uni.found(hash1(w), 0) != 0.0
    }

    pub fn char_sequence_log_prob(&self, word: &str, (mut c1, mut c2): (char, char)) -> f64 {
        let mut sum = 0.0;
        for ch in word.chars() {
            sum += self.char.log_prob(&ch, &c1, &c2);
            c1 = c2;
            c2 = ch;
        }
        sum
    }

    /// BackoffLM.save 的格式：magic、u32 標頭長度、JSON 標頭，之後是 8 位元組對齊的陣列。
    pub fn load(path: &str) -> Result<BackoffLm, String> {
        let (map, len) = Mapping::open(path)?;
        // 映射起點按頁對齊，檔內陣列 8 位元組對齊，typed view 可以直接指進去
        let buf: &'static [u8] = unsafe { std::slice::from_raw_parts(map.0, len) };
        if &buf[..8] != b"ZYLMBO01" {
            return Err(format!("{path} 不是退回式模型"));
        }
        let hlen = u32::from_le_bytes(buf[8..12].try_into().unwrap()) as usize;
        let h: Value = serde_json::from_slice(&buf[12..12 + hlen]).map_err(|e| e.to_string())?;
        let base = (12 + hlen).div_ceil(8) * 8;
        let view = |b: &Value| -> (*const u8, usize) {
            let off = b[0].as_u64().unwrap() as usize;
            let n = b[1].as_u64().unwrap() as usize;
            (buf[base + off..base + off + n].as_ptr(), n)
        };
        fn cast<T>((p, n): (*const u8, usize)) -> &'static [T] {
            assert_eq!(p as usize % std::mem::align_of::<T>(), 0);
            unsafe { std::slice::from_raw_parts(p as *const T, n / std::mem::size_of::<T>()) }
        }
        let table = |t: &Value| -> Table {
            let arrays = t["arrays"].as_array().unwrap();
            let bits = t["bits"].as_u64().unwrap();
            Table {
                seed: t["seed"].as_u64().unwrap() as u32,
                pilots: cast(view(&arrays[0])),
                fp: if t["fpBits"].as_u64() == Some(32) {
                    Fp::U32(cast(view(&arrays[1])))
                } else {
                    Fp::U16(cast(view(&arrays[1])))
                },
                cols: arrays[2..]
                    .iter()
                    .map(|a| {
                        if bits == 16 {
                            Col::U16(cast(view(a)))
                        } else {
                            Col::U8(cast(view(a)))
                        }
                    })
                    .collect(),
                luts: t["luts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| cast(view(a)))
                    .collect(),
            }
        };
        let expert = |x: &Value| Expert {
            uni: table(&x["uni"]),
            bi: table(&x["bi"]),
            tri: table(&x["tri"]),
            unseen: x["unseen"].as_f64().unwrap(),
        };
        Ok(BackoffLm {
            word: expert(&h["word"]),
            char: expert(&h["char"]),
            _map: map,
        })
    }
}
