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
    pub entry_cap: usize,
    /// L3 更正讀音每個 key 取的最多候選詞數
    pub alt_entry_cap: usize,
    /// 單音節只在原讀音查無詞時才套用 L3 更正
    pub alt_single_only_if_empty: bool,
    max_span: usize,
    /// 執行中加的詞（add_entry），詞級分數走 parts_log_prob
    runtime_words: std::collections::HashSet<String>,
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
}

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

#[derive(Default)]
pub struct DecodeOptions<'m> {
    pub n_best: usize,
    /// X2 修飾：詞、起點、長度 → log 加成
    pub modifier: Option<&'m dyn Fn(&str, usize, usize) -> f64>,
    /// L3 假設：每個位置的候選意圖音節（第一個是觀察音節、代價 0）
    pub alternatives: Option<&'m [Vec<Hypothesis>]>,
    pub fixed: &'m [FixedSpan],
}

/// 詞編號：小於詞典詞數的是詞典詞，其餘是這次解碼的額外詞（空詞、□、原樣 token）
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
            s.chars().count() == 1 && self.lex.poly_set.contains(s)
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
        Decoder {
            lm,
            lex,
            a,
            gamma,
            beam: 200,
            poly_penalty: 2.5,
            entry_cap: 48,
            alt_entry_cap: 8,
            alt_single_only_if_empty: true,
            max_span,
            runtime_words: Default::default(),
        }
    }

    /// 解碼音節序列，回傳 N-best（含逐詞拆解）
    pub fn decode(&self, seq: &[String], o: &DecodeOptions) -> Vec<DecodePath> {
        let n = seq.len();
        if n == 0 {
            return vec![];
        }
        let n_best = if o.n_best == 0 { 4 } else { o.n_best };
        let mut words = Words {
            lex: &self.lex,
            extra: vec![],
        };
        let empty = words.intern("");
        let unk = words.intern(UNK_WORD);
        let en = words.intern(EN_CLASS);
        let key = |w1: u32, w2: u32| (w1 as u64) << 32 | w2 as u64;
        let mut paths = vec![Path {
            score: 0.0,
            parent: NONE,
            word: empty,
            w1: empty,
            w2: empty,
            c1: BOS,
            c2: BOS,
            ci: NONE,
            cand: NONE,
        }];
        let mut buckets: Vec<Bucket> = (0..=n).map(|_| Bucket::default()).collect();
        buckets[0].index.insert(key(empty, empty), 0);
        buckets[0].lists.push((key(empty, empty), vec![0]));
        let ms = self.max_span;
        // None＝還沒算；Some(None)＝被固定段擋住（不同於查無詞，不補未知詞）
        let mut span_cache: Vec<Option<Option<Vec<Cand>>>> = vec![None; n * (ms + 1)];
        let mut floors = vec![f64::NEG_INFINITY; n + 1];
        let mut counts = vec![0usize; n + 1];
        let beam = self.beam;
        let (a, gamma) = (self.a, self.gamma);
        let mut lpws: Vec<f64> = vec![];
        let mut lpcs: Vec<f64> = vec![];
        let mut us: Vec<f64> = vec![];

        for pos in 0..n {
            let groups = std::mem::take(&mut buckets[pos]);
            let max_len = ms.min(n - pos);
            for (gkey, gp) in &groups.lists {
                if gp.is_empty() {
                    continue;
                }
                let (w1, w2) = ((gkey >> 32) as u32, *gkey as u32);
                let rep = paths[gp[0] as usize];
                for len in 1..=max_len {
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
                                if admits(&target.lists[li].1, np.score, &paths, n_best) {
                                    paths.push(np);
                                    let id = paths.len() as u32 - 1;
                                    counts[q] += insert(&mut target.lists[li].1, id, &paths, n_best)
                                        as usize;
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
                        let mut lp = if !self.runtime_words.is_empty()
                            && self.runtime_words.contains(name)
                            && !self.lm.knows_word(name)
                        {
                            self.parts_log_prob(name, w1s, w2s)
                        } else {
                            self.lm.word_log_prob(name, w1s, w2s)
                        };
                        // 破音字單字重罰：破音字幾乎不以單字存在
                        if words.poly(c.word) {
                            lp -= self.poly_penalty;
                        }
                        lpws.push(lp);
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
                                    if !admits(&target.lists[l].1, score, &paths, n_best) {
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
                            counts[q] +=
                                insert(&mut target.lists[l].1, id, &paths, n_best) as usize;
                            if counts[q] > 2 * beam {
                                floor = prune_beam(target, beam, &paths);
                                floors[q] = floor;
                                counts[q] = beam;
                            }
                        }
                    }
                }
            }
            for q in pos + 1..=pos + max_len {
                if counts[q] > beam {
                    floors[q] = prune_beam(&mut buckets[q], beam, &paths);
                    counts[q] = beam;
                }
            }
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
        out
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
        let cands = self.cands(seq, pos, len, alts, self.entry_cap, words);
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
            out = self.cands(seq, pos, len, alts, usize::MAX, words);
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

    /// (起點, 長度) 的候選詞：原讀音 + 每詞最多一處 L3 更正。同詞取最低代價（位置照第一次出現）
    fn cands(
        &self,
        seq: &[String],
        pos: usize,
        len: usize,
        alts: Option<&[Vec<Hypothesis>]>,
        cap: usize,
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
            if !(len == 1 && self.alt_single_only_if_empty && !best.is_empty()) {
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
        let cs = self.cands(seq, pos, len, alts, usize::MAX, &mut words);
        cs.iter()
            .map(|c| SpanCand {
                word: words.name(c.word).to_string(),
                cost: c.cost,
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
                    if k - start == 1 && self.lex.poly_set.contains(&piece) {
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
        self.runtime_words.insert(word.to_string());
        for r in readings {
            if r.len() > 10 {
                continue;
            }
            self.max_span = self.max_span.max(r.len());
            self.lex.add(r, word);
        }
    }

    pub fn has_entry(&self, reading: &[String], word: &str) -> bool {
        self.lex.has(reading, word)
    }
}
