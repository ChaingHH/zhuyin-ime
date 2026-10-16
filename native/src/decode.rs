//! L4 詞格 + L5 list-Viterbi 解碼：packages/core/src/decode.ts Decoder.decode 的移植。
//! 只做預設設定：沒有 L3 通道、X2 修飾、固定段、IDF。迭代順序與同分處理都照 TS
//! （狀態依插入順序、同分排後、全域 beam 同分依桶的迭代順序），結果逐位元相同。
use crate::lexicon::Lexicon;
use crate::lm::BackoffLm;
use std::collections::HashMap;

const BOS: char = '\u{2}';
const EOS: &str = "\u{3}";
const UNK_WORD: &str = "\u{25A1}";
/// JS 的 Math.log(1e-7)：寫死，免得 libm 的末位與 V8 不同
const UNK_PENALTY: f64 = -16.11809565095832;
const ENTRY_CAP: usize = 48;
const NONE: u32 = u32::MAX;

/// 不含任何注音符號的 token（組字中按的空格等）：原樣輸出、自成一詞
fn is_literal(t: &str) -> bool {
    !t.chars().any(|c| ('ㄅ'..='ㄯ').contains(&c))
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
}

/// 依插入順序迭代的 狀態（前兩詞）→ 由高到低的路徑清單（JS Map 的語意）
#[derive(Default)]
struct Bucket {
    index: HashMap<u64, usize>,
    lists: Vec<(u64, Vec<u32>)>,
}

pub struct Decoder<'a> {
    pub lm: &'a BackoffLm,
    pub lex: &'a Lexicon,
    pub a: f64,
    pub gamma: f64,
    pub beam: usize,
    pub poly_penalty: f64,
    max_span: usize,
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
        let n = self.lex.word_count() as u32;
        if id < n {
            self.lex.poly[id as usize]
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

impl<'a> Decoder<'a> {
    pub fn new(lm: &'a BackoffLm, lex: &'a Lexicon, a: f64, gamma: f64) -> Self {
        Decoder {
            lm,
            lex,
            a,
            gamma,
            beam: 200,
            poly_penalty: 2.5,
            max_span: lex.max_span().min(10),
        }
    }

    /// 解碼音節序列，回傳 N-best（詞序、分數）
    pub fn decode(&self, seq: &[String], n_best: usize) -> Vec<(Vec<String>, f64)> {
        let n = seq.len();
        if n == 0 {
            return vec![];
        }
        let mut words = Words {
            lex: self.lex,
            extra: vec![],
        };
        let empty = words.intern("");
        let unk = words.intern(UNK_WORD);
        let key = |w1: u32, w2: u32| (w1 as u64) << 32 | w2 as u64;
        let mut paths = vec![Path {
            score: 0.0,
            parent: NONE,
            word: empty,
            w1: empty,
            w2: empty,
            c1: BOS,
            c2: BOS,
        }];
        let mut buckets: Vec<Bucket> = (0..=n).map(|_| Bucket::default()).collect();
        buckets[0].index.insert(key(empty, empty), 0);
        buckets[0].lists.push((key(empty, empty), vec![0]));
        let ms = self.max_span;
        let mut span_cache: Vec<Option<Vec<u32>>> = vec![None; n * (ms + 1)];
        let mut floors = vec![f64::NEG_INFINITY; n + 1];
        let mut counts = vec![0usize; n + 1];
        let beam = self.beam;
        let (a, gamma) = (self.a, self.gamma);
        let mut lpws: Vec<f64> = vec![];
        let mut lpcs: Vec<f64> = vec![];

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
                        span_cache[ci] = Some(self.span_cands(seq, pos, len, &mut words));
                    }
                    let cands = span_cache[ci].as_ref().unwrap();
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
                    let (w1s, w2s) = (words.name(w1), words.name(w2));
                    for &w in cands {
                        let name = words.name(w);
                        let mut lp = self.lm.word_log_prob(name, w1s, w2s);
                        // 破音字單字重罰：破音字幾乎不以單字存在
                        if words.poly(w) {
                            lp -= self.poly_penalty;
                        }
                        lpws.push(lp);
                        lpcs.push(if gamma == 0.0 {
                            0.0
                        } else {
                            self.lm.char_sequence_log_prob(name, (rep.c1, rep.c2))
                        });
                    }
                    for i in 0..m {
                        let word = cands[i];
                        let wt = a * lpws[i];
                        let ct = gamma * lpcs[i];
                        if paths[gp[0] as usize].score + wt + ct < floor {
                            continue;
                        }
                        let k = key(w2, word);
                        let mut li = target.index.get(&k).copied();
                        let mut cc: Option<(char, char)> = None;
                        for &p in gp {
                            let score = paths[p as usize].score + wt + ct;
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
                                *cc.get_or_insert_with(|| shift(rep.c1, rep.c2, words.name(word)));
                            paths.push(Path {
                                score,
                                parent: p,
                                word,
                                w1: w2,
                                w2: word,
                                c1,
                                c2,
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
        finals
            .iter()
            .take(n_best)
            .map(|&(score, p)| {
                let mut out = vec![];
                let mut cur = p;
                while paths[cur as usize].parent != NONE {
                    out.push(words.name(paths[cur as usize].word).to_string());
                    cur = paths[cur as usize].parent;
                }
                out.reverse();
                (out, score)
            })
            .collect()
    }

    /// (起點, 長度) 的候選詞（沒有 L3：只查原讀音），同詞只留第一次
    fn span_cands(&self, seq: &[String], pos: usize, len: usize, words: &mut Words) -> Vec<u32> {
        let obs = &seq[pos..pos + len];
        if obs.iter().any(|t| is_literal(t)) {
            return if len == 1 {
                vec![words.intern(&obs[0])]
            } else {
                vec![]
            };
        }
        let mut out: Vec<u32> = vec![];
        self.lex.each(obs, ENTRY_CAP, |w| {
            if !out.contains(&w) {
                out.push(w);
            }
        });
        out
    }
}
