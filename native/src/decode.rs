//! L4 詞格 + L5 list-Viterbi 解碼：packages/core/src/decode.ts Decoder.decode 的移植。
//! 含 L3 更正讀音（alternatives）、X2 修飾（modifier）、固定段（fixed）、執行中加詞；沒有 IDF。
//! 迭代順序與同分處理都照 TS（狀態依插入順序、同分排後、全域 beam 同分依桶的迭代順序），
//! 結果逐位元相同。
use crate::l3::Hypothesis;
use crate::lexicon::Lexicon;
use crate::lm::BackoffLm;
use std::collections::HashMap;

const BOS: char = '\u{2}';
const EOS: &str = "\u{3}";
const UNK_WORD: &str = "\u{25A1}";
/// 英文類別符號（decode.ts EN_CLASS）：英文原樣 token 用它查 LM
const EN_CLASS: &str = "\u{E000}";
/// JS 的 Math.log(1e-7)：寫死，免得 libm 的末位與 V8 不同
/// X1 軟體／科技寫作的領域詞表（本專案自編），一律加 domain_bonus
const DOMAIN_TECH: &str = include_str!("domain/tech.txt");
const UNK_PENALTY: f64 = -16.11809565095832;
const NONE: u32 = u32::MAX;

/// 不含任何注音符號的 token（組字中按的空格等）：原樣輸出、自成一詞
pub fn is_literal(t: &str) -> bool {
    !t.chars().any(|c| ('ㄅ'..='ㄯ').contains(&c))
}

/// 含拉丁字母的原樣 token（英文）：LM 看到的是 EN_CLASS（decode.ts lmToken）
fn is_english(t: &str) -> bool {
    t.chars().any(|c| c.is_ascii_alphabetic()) && is_literal(t)
}

#[derive(Clone, Copy)]
struct Path {
    score: f64,
    parent: u32,
    word: u32,
    w1: u32,
    w2: u32,
    c1: char,
    c2: char,
    /// 詞邊所在的 span（span 快取索引）與其中第幾個候選；NONE＝未知詞邊
    ci: u32,
    cand: u32,
}

/// 依插入順序迭代的 狀態（前兩詞）→ 由高到低的路徑清單（JS Map 的語意）
#[derive(Default)]
struct Bucket {
    index: HashMap<u64, usize>,
    lists: Vec<(u64, Vec<u32>)>,
}

pub struct Decoder {
    pub lm: BackoffLm,
    pub lex: Lexicon,
    pub a: f64,
    pub gamma: f64,
    pub beam: usize,
    pub poly_penalty: f64,
    /// 破音單字用次要讀音時再加的罰分
    pub poly_minor_penalty: f64,
    pub entry_cap: usize,
    /// L3 更正讀音每個 key 取的最多候選詞數
    pub alt_entry_cap: usize,
    /// 單音節只在原讀音查無詞時才套用 L3 更正
    pub alt_single_only_if_empty: bool,
    /// 解碼後的單字局部修正（refine）的門檻；None＝關。預設 0（2026-10-30：沒打錯 ±0.1、
    /// 合成錯誤 +1.4／+1.4 句準）
    pub refine_margin: Option<f64>,
    /// refine 用的 L3 代價倍率（格裡的代價是為整格調的，單字修正可以另調）
    pub refine_cost_scale: f64,
    /// refine 扣掉的一元機率差權重（0＝不扣）
    pub refine_uni: f64,
    /// X1 領域先驗：domain 裡的詞（DOMAIN_TECH）詞級 log 機率加這麼多；0＝關
    pub domain_bonus: f64,
    domain: std::collections::HashSet<&'static str>,
    max_span: usize,
    /// 執行中加的詞（add_entry），詞級分數走 parts_log_prob
    runtime_words: std::collections::HashSet<String>,
    /// 詞典改過（add_entry／remove_entry）就加一，Lattice 跟著作廢
    gen: u64,
}

/// 增量解碼的格：位置 q 的桶只收 q 之前出發的邊、門檻只看到達 q 的路徑，與後面的音節無關。
/// 所以打下一個音節只補「到達新位置」的邊；改中間音節（退格、L3 展開不同）從共同前綴截斷再補。
/// 結果與全量 decode 逐位元相同（`eval` 的 ZHUYIN_INCR=1 逐步比對）。
/// 呼叫端負責：modifier 換了（X2 學習資料改動、時間）就換一個新的 Lattice。
/// ponytail: a、gamma、beam 等參數改了不會作廢；只有 eval 啟動時改
#[derive(Default)]
pub struct Lattice {
    seq: Vec<String>,
    alts: Option<Vec<Vec<Hypothesis>>>,
    fixed: Vec<FixedSpan>,
    n_best: usize,
    ms: usize,
    gen: u64,
    extra: Vec<String>,
    paths: Vec<Path>,
    buckets: Vec<Bucket>,
    // None＝還沒算；Some(None)＝被固定段擋住（不同於查無詞，不補未知詞）
    span_cache: Vec<Option<Option<Vec<Cand>>>>,
    floors: Vec<f64>,
    counts: Vec<usize>,
}

/// 使用者選定的詞段：從第 pos 個音節起、len 個音節固定為 word
#[derive(Clone, Debug, PartialEq)]
pub struct FixedSpan {
    pub pos: usize,
    pub len: usize,
    pub word: String,
}

/// 格中一條詞邊的候選；讀音＝觀察音節，fix 有值時第 i 個換成 L3 更正的音節
#[derive(Clone)]
struct Cand {
    word: u32,
    fix: Option<(usize, String)>,
    cost: f64,
}

/// 對外的候選（選字視窗用）
pub struct SpanCand {
    pub word: String,
    pub cost: f64,
    /// 採用的讀音（L3 更正後）
    pub reading: Vec<String>,
}

#[derive(Clone)]
pub struct WordBreakdown {
    pub word: String,
    /// 採用的讀音（L3 更正後的意圖音節）
    pub reading: Vec<String>,
}

pub struct DecodePath {
    pub score: f64,
    pub breakdown: Vec<WordBreakdown>,
}

impl DecodePath {
    pub fn words(&self) -> Vec<&str> {
        self.breakdown.iter().map(|b| b.word.as_str()).collect()
    }
    pub fn text(&self) -> String {
        self.words().concat()
    }
}

/// X2 修飾：詞、起點、長度 → log 加成
pub type Modifier<'m> = &'m dyn Fn(&str, usize, usize) -> f64;

#[derive(Default)]
pub struct DecodeOptions<'m> {
    pub n_best: usize,
    /// X2 修飾：詞、起點、長度 → log 加成
    pub modifier: Option<Modifier<'m>>,
    /// L3 假設：每個位置的候選意圖音節（第一個是觀察音節、代價 0）
    pub alternatives: Option<&'m [Vec<Hypothesis>]>,
    pub fixed: &'m [FixedSpan],
}

/// 詞編號：小於詞典詞數的是詞典詞，其餘是這個格的額外詞（空詞、□、原樣 token）
struct Words<'a> {
    lex: &'a Lexicon,
    extra: Vec<String>,
}
impl Words<'_> {
    fn name(&self, id: u32) -> &str {
        let n = self.lex.word_count() as u32;
        if id < n {
            self.lex.word(id)
        } else {
            &self.extra[(id - n) as usize]
        }
    }
    fn intern(&mut self, s: &str) -> u32 {
        let n = self.lex.word_count() as u32;
        match self.extra.iter().position(|x| x == s) {
            Some(i) => n + i as u32,
            None => {
                self.extra.push(s.to_string());
                n + self.extra.len() as u32 - 1
            }
        }
    }
    fn poly(&self, id: u32) -> bool {
        if id < self.lex.word_count() as u32 {
            self.lex.is_poly(id)
        } else {
            let s = self.name(id);
            s.chars().count() == 1 && self.lex.poly_set.contains_key(s)
        }
    }
}

fn shift(mut c1: char, mut c2: char, word: &str) -> (char, char) {
    for ch in word.chars() {
        c1 = c2;
        c2 = ch;
    }
    (c1, c2)
}

fn admits(list: &[u32], score: f64, paths: &[Path], n_best: usize) -> bool {
    list.len() < n_best || score > paths[*list.last().unwrap() as usize].score
}

/// 由高到低插入、同分排在既有路徑之後、超過 nBest 丟最後一條；回傳淨增的路徑數
fn insert(list: &mut Vec<u32>, np: u32, paths: &[Path], n_best: usize) -> u32 {
    let s = paths[np as usize].score;
    let mut i = list.len();
    list.push(np);
    while i > 0 && paths[list[i - 1] as usize].score < s {
        list[i] = list[i - 1];
        i -= 1;
    }
    list[i] = np;
    if list.len() <= n_best {
        1
    } else {
        list.pop();
        0
    }
}

/// 全域 beam：只留前 beam 名，回傳門檻。同分依桶的迭代順序保留前面的
fn prune_beam(bucket: &mut Bucket, beam: usize, paths: &[Path]) -> f64 {
    let mut scores: Vec<f64> = bucket
        .lists
        .iter()
        .flat_map(|(_, l)| l.iter().map(|&p| paths[p as usize].score))
        .collect();
    scores.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let total = scores.len();
    let t = scores[total - beam];
    let mut ties = beam as i64 - scores[total - beam..].iter().filter(|&&s| s > t).count() as i64;
    for (_, l) in &mut bucket.lists {
        l.retain(|&p| {
            let s = paths[p as usize].score;
            s > t
                || (s == t && {
                    ties -= 1;
                    ties >= 0
                })
        });
    }
    t
}

impl Decoder {
    pub fn new(lm: BackoffLm, lex: Lexicon, a: f64, gamma: f64) -> Self {
        let max_span = lex.max_span().min(10);
        let mut d = Decoder {
            lm,
            lex,
            a,
            gamma,
            beam: 200,
            poly_penalty: 1.0,
            poly_minor_penalty: 6.0,
            entry_cap: 48,
            alt_entry_cap: 8,
            alt_single_only_if_empty: true,
            refine_margin: Some(0.0),
            refine_cost_scale: 1.0,
            refine_uni: 0.0,
            domain_bonus: 2.0,
            domain: Default::default(),
            max_span,
            runtime_words: Default::default(),
            gen: 0,
        };
        for line in DOMAIN_TECH.lines().filter(|l| !l.starts_with('#')) {
            let mut it = line.split(' ');
            let Some(w) = it.next().filter(|w| !w.is_empty()) else {
                continue;
            };
            d.domain.insert(w);
            let r: Vec<String> = it.map(String::from).collect();
            if !r.is_empty() && !d.lex.has(&r, w) {
                d.add_entry(w, &[r]);
            }
        }
        d
    }

    /// 解碼音節序列，回傳 N-best（含逐詞拆解）
    pub fn decode(&self, seq: &[String], o: &DecodeOptions) -> Vec<DecodePath> {
        self.decode_in(&mut Lattice::default(), seq, o)
    }

    /// 同 decode，但重用 lat 裡與這次相同的前綴（見 Lattice）
    pub fn decode_in(
        &self,
        lat: &mut Lattice,
        seq: &[String],
        o: &DecodeOptions,
    ) -> Vec<DecodePath> {
        let n = seq.len();
        if n == 0 {
            return vec![];
        }
        let n_best = if o.n_best == 0 { 4 } else { o.n_best };
        let ms = self.max_span;
        let key = |w1: u32, w2: u32| (w1 as u64) << 32 | w2 as u64;
        // 可重用的前綴長度 p：音節與 L3 展開都相同的那段
        let mut p = 0;
        if !lat.buckets.is_empty()
            && (lat.n_best, lat.ms, lat.gen) == (n_best, ms, self.gen)
            && lat.fixed == o.fixed
            && lat.alts.is_some() == o.alternatives.is_some()
        {
            let same_alts = |i: usize| match (&lat.alts, o.alternatives) {
                (Some(x), Some(y)) => x.get(i) == y.get(i),
                _ => true,
            };
            while p < n.min(lat.seq.len()) && lat.seq[p] == seq[p] && same_alts(p) {
                p += 1;
            }
            // 跨過 p 的固定段：舊格裡生效與否看當時長度，從它前面重算
            for f in o.fixed {
                if f.pos < p && f.pos + f.len > p {
                    p = f.pos;
                }
            }
        }
        if p == 0 {
            *lat = Lattice::default();
        }
        let mut words = Words {
            lex: &self.lex,
            extra: std::mem::take(&mut lat.extra),
        };
        let empty = words.intern("");
        let unk = words.intern(UNK_WORD);
        let en = words.intern(EN_CLASS);
        if p == 0 {
            lat.paths.push(Path {
                score: 0.0,
                parent: NONE,
                word: empty,
                w1: empty,
                w2: empty,
                c1: BOS,
                c2: BOS,
                ci: NONE,
                cand: NONE,
            });
            let mut b0 = Bucket::default();
            b0.index.insert(key(empty, empty), 0);
            b0.lists.push((key(empty, empty), vec![0]));
            lat.buckets.push(b0);
            lat.floors.push(f64::NEG_INFINITY);
            lat.counts.push(0);
        } else {
            // 截到 p：p 之後的桶重建；跨過 p 的 span 候選看到的音節變了
            lat.buckets.truncate(p + 1);
            lat.floors.truncate(p + 1);
            lat.counts.truncate(p + 1);
            lat.span_cache.truncate(p * (ms + 1));
            for pos in p.saturating_sub(ms)..p {
                for len in p - pos + 1..=ms {
                    lat.span_cache[pos * (ms + 1) + len] = None;
                }
            }
        }
        lat.buckets.resize_with(n + 1, Bucket::default);
        lat.floors.resize(n + 1, f64::NEG_INFINITY);
        lat.counts.resize(n + 1, 0);
        lat.span_cache.resize(n * (ms + 1), None);
        (lat.seq, lat.fixed, lat.n_best, lat.ms, lat.gen) =
            (seq.to_vec(), o.fixed.to_vec(), n_best, ms, self.gen);
        lat.alts = o.alternatives.map(|a| a.to_vec());
        let Lattice {
            paths,
            buckets,
            span_cache,
            floors,
            counts,
            ..
        } = lat;
        let beam = self.beam;
        let (a, gamma) = (self.a, self.gamma);
        let mut lpws: Vec<f64> = vec![];
        let mut lpcs: Vec<f64> = vec![];
        let mut us: Vec<f64> = vec![];

        // p 之前的位置只補長度 > p−pos 的邊（到達 p 之後的新位置）
        for pos in p.saturating_sub(ms)..n {
            let min_len = if pos < p { p - pos + 1 } else { 1 };
            let max_len = ms.min(n - pos);
            if min_len > max_len {
                continue;
            }
            let groups = std::mem::take(&mut buckets[pos]);
            for (gkey, gp) in &groups.lists {
                if gp.is_empty() {
                    continue;
                }
                let (w1, w2) = ((gkey >> 32) as u32, *gkey as u32);
                let rep = paths[gp[0] as usize];
                for len in min_len..=max_len {
                    let ci = pos * (ms + 1) + len;
                    if span_cache[ci].is_none() {
                        span_cache[ci] = Some(self.fixed_cands(seq, pos, len, o, &mut words));
                    }
                    let Some(cands) = span_cache[ci].as_ref().unwrap() else {
                        continue;
                    };
                    let q = pos + len;
                    let target = &mut buckets[q];
                    let mut floor = floors[q];
                    if cands.is_empty() {
                        if len == 1 {
                            // OOV 音節：以未知詞邊保證格連通（不看門檻，同 TS extend）
                            let wt = a * UNK_PENALTY;
                            let ct = gamma * 0.0;
                            for &p in gp {
                                let pp = paths[p as usize];
                                let (c1, c2) = shift(pp.c1, pp.c2, UNK_WORD);
                                let np = Path {
                                    score: pp.score + wt + ct,
                                    parent: p,
                                    word: unk,
                                    w1: pp.w2,
                                    w2: unk,
                                    c1,
                                    c2,
                                    ci: ci as u32,
                                    cand: NONE,
                                };
                                let k = key(np.w1, unk);
                                let li = *target.index.entry(k).or_insert_with(|| {
                                    target.lists.push((k, vec![]));
                                    target.lists.len() - 1
                                });
                                if admits(&target.lists[li].1, np.score, paths, n_best) {
                                    paths.push(np);
                                    let id = paths.len() as u32 - 1;
                                    counts[q] +=
                                        insert(&mut target.lists[li].1, id, paths, n_best) as usize;
                                }
                            }
                        }
                        continue;
                    }
                    let m = cands.len();
                    lpws.clear();
                    lpcs.clear();
                    us.clear();
                    let (w1s, w2s) = (words.name(w1), words.name(w2));
                    for c in cands {
                        let name = words.name(c.word);
                        let name = if is_english(name) { EN_CLASS } else { name };
                        let read = c
                            .fix
                            .as_ref()
                            .map_or(seq[pos].as_str(), |(_, s)| s.as_str());
                        lpws.push(self.word_lp(name, words.poly(c.word), read, w1s, w2s));
                        lpcs.push(if gamma == 0.0 {
                            0.0
                        } else {
                            self.lm.char_sequence_log_prob(name, (rep.c1, rep.c2))
                        });
                        us.push(o.modifier.map_or(0.0, |f| f(name, pos, len)));
                    }
                    for i in 0..m {
                        let word = cands[i].word;
                        let wt = a * lpws[i];
                        let ct = gamma * lpcs[i];
                        let ut = us[i];
                        let ch = -cands[i].cost;
                        if paths[gp[0] as usize].score + wt + ct + ut + ch < floor {
                            continue;
                        }
                        // LM 上下文（狀態鍵、w2、尾兩字）用 LM 看到的詞；輸出用原字
                        let lw = if is_english(words.name(word)) {
                            en
                        } else {
                            word
                        };
                        let k = key(w2, lw);
                        let mut li = target.index.get(&k).copied();
                        let mut cc: Option<(char, char)> = None;
                        for &p in gp {
                            let score = paths[p as usize].score + wt + ct + ut + ch;
                            if score < floor {
                                break;
                            }
                            let l = match li {
                                Some(l) => {
                                    if !admits(&target.lists[l].1, score, paths, n_best) {
                                        continue;
                                    }
                                    l
                                }
                                None => {
                                    target.lists.push((k, vec![]));
                                    let l = target.lists.len() - 1;
                                    target.index.insert(k, l);
                                    li = Some(l);
                                    l
                                }
                            };
                            let (c1, c2) =
                                *cc.get_or_insert_with(|| shift(rep.c1, rep.c2, words.name(lw)));
                            paths.push(Path {
                                score,
                                parent: p,
                                word,
                                w1: w2,
                                w2: lw,
                                c1,
                                c2,
                                ci: ci as u32,
                                cand: i as u32,
                            });
                            let id = paths.len() as u32 - 1;
                            counts[q] += insert(&mut target.lists[l].1, id, paths, n_best) as usize;
                            if counts[q] > 2 * beam {
                                floor = prune_beam(target, beam, paths);
                                floors[q] = floor;
                                counts[q] = beam;
                            }
                        }
                    }
                }
            }
            for q in pos + min_len..=pos + max_len {
                if counts[q] > beam {
                    floors[q] = prune_beam(&mut buckets[q], beam, paths);
                    counts[q] = beam;
                }
            }
            buckets[pos] = groups;
        }

        // 句尾項：P(EOS | 末兩詞) 與 P(EOS | 末兩字)
        let mut finals: Vec<(f64, u32)> = buckets[n]
            .lists
            .iter()
            .flat_map(|(_, l)| l.iter())
            .map(|&p| {
                let pp = &paths[p as usize];
                let eos_w = a * self
                    .lm
                    .word_log_prob(EOS, words.name(pp.w1), words.name(pp.w2));
                let eos_c = if gamma == 0.0 {
                    0.0
                } else {
                    gamma * self.lm.char_sequence_log_prob(EOS, (pp.c1, pp.c2))
                };
                (pp.score + eos_w + eos_c, p)
            })
            .collect();
        let paths = &*paths;
        finals.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap());
        // 同一串字的不同斷詞／讀音只留最高分那條，否則 N-best 會被同字路徑佔滿
        let mut seen = std::collections::HashSet::new();
        let out: Vec<DecodePath> = finals
            .iter()
            .map(|&(score, p)| {
                let mut breakdown = vec![];
                let mut cur = p;
                while paths[cur as usize].parent != NONE {
                    let pp = &paths[cur as usize];
                    let (pos, len) = (pp.ci as usize / (ms + 1), pp.ci as usize % (ms + 1));
                    let mut reading = seq[pos..pos + len].to_vec();
                    if pp.cand != NONE {
                        let cs = span_cache[pp.ci as usize]
                            .as_ref()
                            .unwrap()
                            .as_ref()
                            .unwrap();
                        if let Some((i, syl)) = &cs[pp.cand as usize].fix {
                            reading[*i] = syl.clone();
                        }
                    }
                    breakdown.push(WordBreakdown {
                        word: words.name(pp.word).to_string(),
                        reading,
                    });
                    cur = pp.parent;
                }
                breakdown.reverse();
                DecodePath { score, breakdown }
            })
            .filter(|d| seen.insert(d.text()))
            .take(n_best)
            .collect();
        lat.extra = words.extra;
        // 固定段的詞走不通（不在候選）時整個格斷掉：不帶固定段重解，畫面才不會變空
        if out.is_empty() && !o.fixed.is_empty() {
            return self.decode(
                seq,
                &DecodeOptions {
                    n_best: o.n_best,
                    modifier: o.modifier,
                    alternatives: o.alternatives,
                    fixed: &[],
                },
            );
        }
        let mut out = out;
        if let Some(m) = self.refine_margin {
            if let Some(r) = out.first().and_then(|t| self.refine(t, seq, o, m)) {
                let t = r.text();
                out.retain(|d| d.text() != t);
                out.insert(0, r);
                out.truncate(n_best);
            }
        }
        out
    }

    /// 詞級 log 機率（未乘 a）：LM（執行中加的詞走 parts_log_prob）＋X1＋破音單字罰分。
    /// name 是 LM 看到的詞；read 是單字採用的讀音（判斷次要讀音）
    fn word_lp(&self, name: &str, poly: bool, read: &str, w1: &str, w2: &str) -> f64 {
        let mut lp = if !self.runtime_words.is_empty()
            && self.runtime_words.contains(name)
            && !self.lm.knows_word(name)
        {
            self.parts_log_prob(name, w1, w2)
        } else {
            self.lm.word_log_prob(name, w1, w2)
        };
        if self.domain_bonus != 0.0 && self.domain.contains(name) {
            lp += self.domain_bonus;
        }
        // 破音字單字重罰：破音字幾乎不以單字存在
        if poly {
            lp -= self.poly_penalty;
            // 次要讀音（將讀 ㄑㄧㄤ）再罰；在詞裡（將進酒）不罰
            if self.lex.poly_set.get(name).is_some_and(|m| m != read) {
                lp -= self.poly_minor_penalty;
            }
        }
        lp
    }

    /// 一條拆解的整句分數（同格裡的算法，不含 L3 代價）：詞級＋字級＋X2＋句尾
    fn path_score(&self, bd: &[WordBreakdown], o: &DecodeOptions) -> f64 {
        let (a, gamma) = (self.a, self.gamma);
        let (mut w1, mut w2) = (String::new(), String::new());
        let (mut c1, mut c2) = (BOS, BOS);
        let (mut pos, mut s) = (0, 0.0);
        for b in bd {
            let len = b.reading.len();
            let name = if is_english(&b.word) {
                EN_CLASS
            } else {
                b.word.as_str()
            };
            if name == UNK_WORD {
                s += a * UNK_PENALTY;
            } else {
                let poly = name.chars().count() == 1 && self.lex.poly_set.contains_key(name);
                s += a * self.word_lp(name, poly, &b.reading[0], &w1, &w2);
                if gamma != 0.0 {
                    s += gamma * self.lm.char_sequence_log_prob(name, (c1, c2));
                }
                s += o.modifier.map_or(0.0, |f| f(name, pos, len));
            }
            (c1, c2) = shift(c1, c2, name);
            w1 = std::mem::replace(&mut w2, name.to_string());
            pos += len;
        }
        s += a * self.lm.word_log_prob(EOS, &w1, &w2);
        if gamma != 0.0 {
            s += gamma * self.lm.char_sequence_log_prob(EOS, (c1, c2));
        }
        s
    }

    /// 把 top 第 pos 個音節換成單字 word（讀音 reading）後的整句 LM 分數（不含 X2、L3 代價）。
    /// 蓋住 pos 的詞拆成前段／word／後段：同一個位置的候選都拆得一樣，只拿來互相比。
    /// 位置落在原樣 token（英文）或字數與音節數不同的詞上回 None
    pub fn context_score(&self, top: &DecodePath, pos: usize, word: &str, reading: &str) -> Option<f64> {
        let mut bd = vec![];
        let mut at = 0;
        for b in &top.breakdown {
            let len = b.reading.len();
            if (at..at + len).contains(&pos) {
                let chars: Vec<char> = b.word.chars().collect();
                if chars.len() != len || is_literal(&b.reading[0]) {
                    return None;
                }
                let k = pos - at;
                if k > 0 {
                    bd.push(WordBreakdown {
                        word: chars[..k].iter().collect(),
                        reading: b.reading[..k].to_vec(),
                    });
                }
                bd.push(WordBreakdown {
                    word: word.to_string(),
                    reading: vec![reading.to_string()],
                });
                if k + 1 < len {
                    bd.push(WordBreakdown {
                        word: chars[k + 1..].iter().collect(),
                        reading: b.reading[k + 1..].to_vec(),
                    });
                }
            } else {
                bd.push(b.clone());
            }
            at += len;
        }
        (pos < at).then(|| self.path_score(&bd, &DecodeOptions::default()))
    }

    /// 解碼後的單字局部修正：top 裡照原讀音打的單字（不在固定段），換成 L3 更正讀音的字，
    /// 整句分數扣掉更正代價後多出 margin 以上才換，由左到右逐字貪婪。
    /// 補 alt_single_only_if_empty 擋掉的「有字的音節打錯」（ㄇㄛˊ→ㄇㄟˊ：魔跳出→沒跳出），格不變。
    /// ponytail: 只修第一名、不重新斷詞；第一名斷錯就救不回來
    fn refine(
        &self,
        top: &DecodePath,
        seq: &[String],
        o: &DecodeOptions,
        margin: f64,
    ) -> Option<DecodePath> {
        let alts = o.alternatives?;
        let mut cur: Vec<WordBreakdown> = top.breakdown.clone();
        let mut base = self.path_score(&cur, o);
        let mut gain = 0.0;
        let mut pos = 0;
        for i in 0..cur.len() {
            let len = cur[i].reading.len();
            let ok = len == 1
                && cur[i].reading[0] == seq[pos]
                && cur[i].word != UNK_WORD
                && !is_literal(&seq[pos])
                && !o.fixed.iter().any(|f| f.pos <= pos && pos < f.pos + f.len);
            if ok {
                let orig = cur[i].clone();
                let mut best: Option<(f64, f64, WordBreakdown)> = None;
                for h in alts.get(pos).map_or(&[][..], |v| v) {
                    if h.cost == 0.0 {
                        continue;
                    }
                    let mut ids = vec![];
                    self.lex
                        .each(std::slice::from_ref(&h.syl), self.alt_entry_cap, |w| {
                            ids.push(w)
                        });
                    for w in ids {
                        cur[i] = WordBreakdown {
                            word: self.lex.word(w).to_string(),
                            reading: vec![h.syl.clone()],
                        };
                        // 扣掉換成常用字本身的好處（一元機率差 × refine_uni），只留上下文的貢獻
                        let cost = h.cost * self.refine_cost_scale
                            + self.refine_uni
                                * self.a
                                * (self.lm.word_unigram(&cur[i].word)
                                    - self.lm.word_unigram(&orig.word));
                        let d = self.path_score(&cur, o) - cost - base;
                        if d > margin && best.as_ref().map_or(true, |b| d > b.0) {
                            best = Some((d, cost, cur[i].clone()));
                        }
                    }
                }
                cur[i] = match best {
                    Some((d, cost, b)) => {
                        base += d + cost;
                        gain += d;
                        b
                    }
                    None => orig,
                };
            }
            pos += len;
        }
        (gain > 0.0).then(|| DecodePath {
            score: top.score + gain,
            breakdown: cur,
        })
    }

    /// span 候選再套固定段：與固定段重疊的 span 只有恰好等於該段的那個詞能走；None＝走不通
    fn fixed_cands(
        &self,
        seq: &[String],
        pos: usize,
        len: usize,
        o: &DecodeOptions,
        words: &mut Words,
    ) -> Option<Vec<Cand>> {
        let alts = o.alternatives;
        let cands = self.cands(seq, pos, len, alts, self.entry_cap, false, words);
        let Some(f) = o
            .fixed
            .iter()
            // 越界的固定段（編輯後殘留）直接忽略，不讓整個格斷掉
            .find(|f| f.pos + f.len <= seq.len() && f.pos < pos + len && pos < f.pos + f.len)
        else {
            return Some(cands);
        };
        if f.pos != pos || f.len != len {
            return None;
        }
        let mut out: Vec<Cand> = cands
            .into_iter()
            .filter(|c| words.name(c.word) == f.word)
            .collect();
        if out.is_empty() {
            // 選字視窗列的單音節更正字（span_cands）也要走得通
            out = self.cands(seq, pos, len, alts, usize::MAX, true, words);
            out.retain(|c| words.name(c.word) == f.word);
        }
        // 選字清單最後一項「注音本身」：照原樣輸出那個音節（同原樣 token），不查詞典
        if out.is_empty() && len == 1 && f.word == seq[pos] {
            out.push(Cand {
                word: words.intern(&seq[pos]),
                fix: None,
                cost: 0.0,
            });
        }
        (!out.is_empty()).then_some(out)
    }

    /// (起點, 長度) 的候選詞：原讀音 + 每詞最多一處 L3 更正。同詞取最低代價（位置照第一次出現）。
    /// single_alts：不管 alt_single_only_if_empty，單音節一律展開（選字視窗與使用者選定的固定段用）
    #[allow(clippy::too_many_arguments)]
    fn cands(
        &self,
        seq: &[String],
        pos: usize,
        len: usize,
        alts: Option<&[Vec<Hypothesis>]>,
        cap: usize,
        single_alts: bool,
        words: &mut Words,
    ) -> Vec<Cand> {
        let obs = &seq[pos..pos + len];
        if obs.iter().any(|t| is_literal(t)) {
            return if len == 1 {
                vec![Cand {
                    word: words.intern(&obs[0]),
                    fix: None,
                    cost: 0.0,
                }]
            } else {
                vec![]
            };
        }
        let mut best: Vec<Cand> = vec![];
        let take = |best: &mut Vec<Cand>,
                    reading: &[String],
                    fix: Option<(usize, &str)>,
                    cost: f64,
                    cap: usize| {
            self.lex.each(reading, cap, |w| {
                match best.iter_mut().find(|c| c.word == w) {
                    Some(prev) => {
                        if cost < prev.cost {
                            prev.cost = cost;
                            prev.fix = fix.map(|(i, s)| (i, s.to_string()));
                        }
                    }
                    None => best.push(Cand {
                        word: w,
                        fix: fix.map(|(i, s)| (i, s.to_string())),
                        cost,
                    }),
                }
            });
        };
        take(&mut best, obs, None, 0.0, cap);
        // 單音節更正只在觀察音節查無任何詞時才做（見 TS spanCands）
        if let Some(alts) = alts {
            if single_alts || !(len == 1 && self.alt_single_only_if_empty && !best.is_empty()) {
                let mut r = obs.to_vec();
                for i in 0..len {
                    for h in alts.get(pos + i).map_or(&[][..], |v| v) {
                        if h.cost == 0.0 {
                            continue;
                        }
                        r[i] = h.syl.clone();
                        take(&mut best, &r, Some((i, &h.syl)), h.cost, self.alt_entry_cap);
                    }
                    r[i] = obs[i].clone();
                }
            }
        }
        best
    }

    /// 選字視窗用：(起點, 長度) 的所有候選詞與通道代價
    pub fn span_cands(
        &self,
        seq: &[String],
        pos: usize,
        len: usize,
        alts: Option<&[Vec<Hypothesis>]>,
    ) -> Vec<SpanCand> {
        let mut words = Words {
            lex: &self.lex,
            extra: vec![],
        };
        let cs = self.cands(seq, pos, len, alts, usize::MAX, true, &mut words);
        cs.iter()
            .map(|c| {
                let mut reading = seq[pos..pos + len].to_vec();
                if let Some((i, syl)) = &c.fix {
                    reading[*i] = syl.clone();
                }
                SpanCand {
                    word: words.name(c.word).to_string(),
                    cost: c.cost,
                    reading,
                }
            })
            .collect()
    }

    /// 執行中加的詞不在詞級 LM 裡時，用它拆成 LM 認得的詞的最佳分數（同 TS Decoder.partsLogProb）
    fn parts_log_prob(&self, w: &str, w1: &str, w2: &str) -> f64 {
        let chars: Vec<char> = w.chars().collect();
        let n = chars.len();
        let mut best = f64::NEG_INFINITY;
        if (2..=6).contains(&n) {
            for mask in 1u32..(1 << (n - 1)) {
                let mut s = 0.0;
                let (mut c1, mut c2) = (w1.to_string(), w2.to_string());
                let mut start = 0;
                let mut ok = true;
                for k in 1..=n {
                    if k < n && mask & (1 << (k - 1)) == 0 {
                        continue;
                    }
                    let piece: String = chars[start..k].iter().collect();
                    if !self.lm.knows_word(&piece) {
                        ok = false;
                        break;
                    }
                    let mut lp = self.lm.word_log_prob(&piece, &c1, &c2);
                    if k - start == 1 && self.lex.poly_set.contains_key(&piece) {
                        lp -= self.poly_penalty;
                    }
                    s += lp;
                    c1 = std::mem::replace(&mut c2, piece);
                    start = k;
                }
                if ok && s > best {
                    best = s;
                }
            }
        }
        if best == f64::NEG_INFINITY {
            self.lm.word_log_prob(w, w1, w2)
        } else {
            best
        }
    }

    /// 增量加入詞條（X2 挖詞／使用者造詞）
    pub fn add_entry(&mut self, word: &str, readings: &[Vec<String>]) {
        self.gen += 1;
        self.runtime_words.insert(word.to_string());
        for r in readings {
            if r.len() > 10 {
                continue;
            }
            self.max_span = self.max_span.max(r.len());
            self.lex.add(r, word);
        }
    }

    /// 拿掉 add_entry 加的詞（學習資料頁的刪除）
    pub fn remove_entry(&mut self, word: &str, readings: &[Vec<String>]) {
        // X1 詞表的詞不拿掉（使用者詞剛好同名時，關學習／刪除不能連詞表的一起刪）
        // ponytail: 整個詞跳過，同名但讀音不同的使用者詞也刪不掉；要精確再記詞表讀音
        if self.domain.contains(word) {
            return;
        }
        self.gen += 1;
        self.runtime_words.remove(word);
        for r in readings {
            self.lex.remove(r, word);
        }
    }

    pub fn has_entry(&self, reading: &[String], word: &str) -> bool {
        self.lex.has(reading, word)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::decoder;

    fn rd(s: &str) -> Vec<String> {
        s.split(' ').map(String::from).collect()
    }

    const LEX: &[(&str, &str)] = &[
        ("ㄋㄧˇ", "你"),
        ("ㄋㄧˇ", "擬"),
        ("ㄏㄠˇ", "好"),
        ("ㄏㄠˇ", "號"),
        ("ㄋㄧˇ ㄏㄠˇ", "你好"),
    ];

    #[test]
    fn literal_and_english_tokens() {
        assert!(is_literal(" ") && is_literal("abc") && is_literal("，"));
        assert!(!is_literal("ㄋㄧˇ") && !is_literal("aㄅ"));
        assert!(is_english("abc") && is_english("a1") && !is_english("12") && !is_english("ㄅa"));
    }

    #[test]
    fn flat_lm_prefers_fewer_words() {
        let d = decoder(LEX);
        let p = d.decode(&rd("ㄋㄧˇ ㄏㄠˇ"), &DecodeOptions::default());
        assert_eq!(p[0].text(), "你好");
        assert_eq!(p[0].breakdown[0].reading, rd("ㄋㄧˇ ㄏㄠˇ"));
        // N-best：其餘是同分的兩詞組合（同分的取捨照狀態的插入順序，你|好 被擠掉）
        assert_eq!(
            p.iter().map(|p| p.text()).collect::<Vec<_>>(),
            ["你好", "你號", "擬好", "擬號"]
        );
        assert!(p[0].score > p[1].score);
        assert!(p[1..].iter().all(|x| x.score == p[1].score));
        assert!(d.decode(&[], &DecodeOptions::default()).is_empty());
    }

    #[test]
    fn unknown_syllables_and_literals() {
        let d = decoder(LEX);
        let p = d.decode(&rd("ㄋㄧˇ ㄇㄚ , abc"), &DecodeOptions::default());
        assert_eq!(p[0].words(), ["你", UNK_WORD, ",", "abc"]);
    }

    #[test]
    fn fixed_span_and_modifier() {
        let d = decoder(LEX);
        let seq = rd("ㄋㄧˇ ㄏㄠˇ");
        let fixed = [FixedSpan {
            pos: 1,
            len: 1,
            word: "號".into(),
        }];
        let p = d.decode(
            &seq,
            &DecodeOptions {
                fixed: &fixed,
                ..Default::default()
            },
        );
        assert!(p.iter().all(|p| p.text().ends_with('號')));
        assert_eq!(p[0].text(), "你號");
        let m = |w: &str, _: usize, _: usize| if w == "擬" { 50.0 } else { 0.0 };
        let p = d.decode(
            &seq,
            &DecodeOptions {
                modifier: Some(&m),
                ..Default::default()
            },
        );
        assert_eq!(p[0].text(), "擬好");
    }

    #[test]
    fn alternatives_correct_readings() {
        let d = decoder(LEX);
        // 打成 ㄋㄧˋ（沒有詞），L3 給 ㄋㄧˇ：單音節只在原讀音查無詞時才更正
        let alts = vec![
            vec![
                Hypothesis {
                    syl: "ㄋㄧˋ".into(),
                    cost: 0.0,
                },
                Hypothesis {
                    syl: "ㄋㄧˇ".into(),
                    cost: 3.0,
                },
            ],
            vec![Hypothesis {
                syl: "ㄏㄠˇ".into(),
                cost: 0.0,
            }],
        ];
        let p = d.decode(
            &rd("ㄋㄧˋ ㄏㄠˇ"),
            &DecodeOptions {
                alternatives: Some(&alts),
                ..Default::default()
            },
        );
        assert_eq!(p[0].text(), "你好");
        assert_eq!(p[0].breakdown[0].reading, rd("ㄋㄧˇ ㄏㄠˇ"));
        let c = d.span_cands(&rd("ㄋㄧˋ"), 0, 1, Some(&alts[..1]));
        assert_eq!(
            c.iter()
                .map(|c| (c.word.as_str(), c.cost))
                .collect::<Vec<_>>(),
            [("你", 3.0), ("擬", 3.0)]
        );
    }

    #[test]
    fn refine_single_char() {
        // ㄇㄛˊ 有字，格裡不做單音節更正；refine 解碼後才把 魔 換成 沒（X2 加成代替 LM 的上下文）
        let mut d = decoder(&[("ㄇㄛˊ", "魔"), ("ㄇㄟˊ", "沒"), ("ㄊㄧㄠˋ", "跳")]);
        d.refine_margin = None;
        let h = |s: &str, cost: f64| Hypothesis {
            syl: s.into(),
            cost,
        };
        let alts = vec![
            vec![h("ㄇㄛˊ", 0.0), h("ㄇㄟˊ", 3.0)],
            vec![h("ㄊㄧㄠˋ", 0.0)],
        ];
        let m = |w: &str, _: usize, _: usize| if w == "沒" { 10.0 } else { 0.0 };
        let o = DecodeOptions {
            modifier: Some(&m),
            alternatives: Some(&alts),
            ..Default::default()
        };
        let seq = rd("ㄇㄛˊ ㄊㄧㄠˋ");
        assert_eq!(d.decode(&seq, &o)[0].text(), "魔跳");
        d.refine_margin = Some(0.0);
        let p = d.decode(&seq, &o);
        assert_eq!(p[0].text(), "沒跳");
        assert_eq!(p[0].breakdown[0].reading, rd("ㄇㄟˊ"));
        assert!(p.iter().filter(|x| x.text() == "沒跳").count() == 1);
        // 贏不過門檻（10 − 3 < 8）就不換
        d.refine_margin = Some(8.0);
        assert_eq!(d.decode(&seq, &o)[0].text(), "魔跳");
        // 選字視窗列出 沒（排在照打讀音的字後面），選了之後格走得通
        let c = d.span_cands(&seq, 0, 1, Some(&alts));
        assert_eq!(
            c.iter().map(|c| c.word.as_str()).collect::<Vec<_>>(),
            ["魔", "沒"]
        );
        let fixed = [FixedSpan {
            pos: 0,
            len: 1,
            word: "沒".into(),
        }];
        let p = d.decode(
            &seq,
            &DecodeOptions {
                alternatives: Some(&alts),
                fixed: &fixed,
                ..Default::default()
            },
        );
        assert_eq!(p[0].text(), "沒跳");
        assert_eq!(p[0].breakdown[0].reading, rd("ㄇㄟˊ"));
    }

    #[test]
    fn runtime_entries() {
        let mut d = decoder(LEX);
        let r = rd("ㄓㄨㄤˋ ㄊㄞˋ");
        assert!(!d.has_entry(&r, "狀態"));
        d.add_entry("狀態", std::slice::from_ref(&r));
        assert!(d.has_entry(&r, "狀態"));
        assert_eq!(d.decode(&r, &DecodeOptions::default())[0].text(), "狀態");
        d.remove_entry("狀態", std::slice::from_ref(&r));
        assert!(!d.has_entry(&r, "狀態"));
    }

    #[test]
    fn domain_prior() {
        let r = rd("ㄢˋ ㄐㄧㄢˋ");
        let mut d = decoder(&[("ㄢˋ ㄐㄧㄢˋ", "案件"), ("ㄢˋ ㄐㄧㄢˋ", "按鍵")]);
        assert_eq!(d.decode(&r, &DecodeOptions::default())[0].text(), "按鍵");
        // 詞典沒有的領域詞照詞表的讀音加進來
        let r2 = rd("ㄔㄨㄥˊ ㄕˋ");
        assert!(d.has_entry(&r2, "重試"));
        d.remove_entry("重試", std::slice::from_ref(&r2));
        assert!(d.has_entry(&r2, "重試"));
        d.domain_bonus = 0.0;
        let p = d.decode(&r, &DecodeOptions::default());
        assert_eq!(p[0].score, p[1].score);
    }
}
