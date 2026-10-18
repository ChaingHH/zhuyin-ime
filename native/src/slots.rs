//! L2 槽位組字區：packages/core/src/slots.ts CompositionBuffer 的移植。
//! 已完成的音節直接存正規形字串（TS 只在 sequence 時才轉，結果相同）；原樣字元也是字串。
use crate::decode::is_literal;
use crate::keymap::{map_key, slot_of, Mapped, MARKS};
use std::collections::HashSet;

#[derive(Default)]
pub struct CompositionBuffer {
    legal: HashSet<String>,
    done: Vec<String>,
    /// 聲母、介音、韻母
    partial: [Option<&'static str>; 3],
    /// 部分槽位的插入歷史，供 Backspace 回退
    history: Vec<usize>,
    /// 游標（第幾個已完成音節之前）；None＝在最後
    cursor_at: Option<usize>,
}

impl CompositionBuffer {
    pub fn new(legal: HashSet<String>) -> Self {
        CompositionBuffer {
            legal,
            ..Default::default()
        }
    }

    pub fn sequence(&self) -> &[String] {
        &self.done
    }

    pub fn pending_display(&self) -> String {
        self.partial.iter().flatten().copied().collect()
    }

    pub fn cursor(&self) -> usize {
        self.cursor_at.unwrap_or(self.done.len())
    }

    pub fn set_cursor(&mut self, i: usize) {
        self.cursor_at = if i >= self.done.len() { None } else { Some(i) };
    }

    fn insert(&mut self, x: String) {
        self.done.insert(self.cursor(), x);
        if let Some(c) = &mut self.cursor_at {
            *c += 1;
        }
    }

    pub fn is_empty(&self) -> bool {
        self.done.is_empty() && self.history.is_empty()
    }

    /// 回傳完成的音節是否合法（沒完成音節時為 true）
    pub fn on_key(&mut self, code: &str) -> bool {
        let ok = true;
        match code {
            "Backspace" => {
                self.backspace();
                return ok;
            }
            "Delete" => {
                self.delete_forward();
                return ok;
            }
            _ => {}
        }
        match map_key(code) {
            Mapped::Tone(t) => {
                if self.history.is_empty() {
                    return true;
                }
                let syl = self.pending_display() + MARKS[t as usize - 1];
                let legal = self.legal.contains(&syl);
                self.insert(syl);
                self.partial = [None; 3];
                self.history.clear();
                legal
            }
            Mapped::Symbol(s) => {
                let slot = slot_of(s).unwrap();
                // 同槽再按＝覆蓋；該槽移到退格歷史最後
                if self.partial[slot].is_some() {
                    self.history.retain(|&h| h != slot);
                }
                self.partial[slot] = Some(s);
                self.history.push(slot);
                ok
            }
            Mapped::Unmapped => true,
        }
    }

    /// 在游標處放一個原樣字元；有未完成槽位時不放
    pub fn push_literal(&mut self, ch: &str) -> bool {
        if !self.history.is_empty() {
            return false;
        }
        self.insert(ch.to_string());
        true
    }

    /// 英文模式打的字母／數字：併進游標前的英文 token，前面不是英文就開新的；有未完成槽位時不收
    pub fn append_english(&mut self, ch: &str) -> bool {
        if !self.history.is_empty() {
            return false;
        }
        let c = self.cursor();
        match self.done[..c].last_mut() {
            Some(prev) if !prev.is_empty() && prev.chars().all(|x| x.is_ascii_alphanumeric()) => {
                prev.push_str(ch)
            }
            _ => self.insert(ch.to_string()),
        }
        true
    }

    /// 先退部分槽位，再退游標前的已完成音節（英文 token 一次退一個字母）
    pub fn backspace(&mut self) -> bool {
        if let Some(last) = self.history.pop() {
            self.partial[last] = None;
            return true;
        }
        let c = self.cursor();
        if let Some(prev) = self.done[..c].last_mut() {
            if is_literal(prev) && prev.chars().count() > 1 {
                prev.pop();
                return true;
            }
        }
        if c > 0 {
            self.done.remove(c - 1);
            if let Some(c) = &mut self.cursor_at {
                *c -= 1;
            }
            return true;
        }
        false
    }

    pub fn delete_forward(&mut self) -> bool {
        if !self.history.is_empty() || self.cursor() >= self.done.len() {
            return false;
        }
        self.done.remove(self.cursor());
        if self.cursor_at.is_some_and(|c| c >= self.done.len()) {
            self.cursor_at = None;
        }
        true
    }

    pub fn reset(&mut self) {
        self.done.clear();
        self.partial = [None; 3];
        self.history.clear();
        self.cursor_at = None;
    }
}
