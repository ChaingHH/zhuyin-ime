//! PIME 後端協定（`zhuyin-native pime`）：PIMELauncher 從 stdin 送 `<client_id>|<JSON>`，
//! 後端每則回一行 `PIME_MSG|<client_id>|<JSON>`。方法與回應欄位照 PIME 的 python/textService.py：
//! init、onActivate／onDeactivate、filterKeyDown／onKeyDown／filterKeyUp／onKeyUp、onCommand、
//! onKeyboardStatusChanged、onCompositionTerminated、close；回應帶 compositionString、
//! compositionCursor、commitString、candidateList、showCandidates、candidateCursor、return。
//! 按鍵行為照網頁測試台（packages/cli/web/index.html）：單按 Shift 切換注音／英文、Enter 送出、
//! ↓ 開選字視窗、數字選字、←→ 移游標、Esc 取消；沒在組字時編輯鍵交給應用程式。
use crate::engine::{EngineState, ImeEngine, Mode};
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;

const VK_SHIFT: usize = 0x10;
const VK_CONTROL: usize = 0x11;
const VK_MENU: usize = 0x12;
const MODE_BUTTON: &str = "windows-mode-icon";
const ID_MODE: i64 = 1;

/// Windows 虛擬鍵碼 → KeyboardEvent.code（美式鍵盤實體鍵位）
fn code_of(vk: u32) -> Option<String> {
    let c = match vk {
        0x30..=0x39 => return Some(format!("Digit{}", vk - 0x30)),
        0x41..=0x5a => return Some(format!("Key{}", char::from(vk as u8))),
        0x08 => "Backspace",
        0x09 => "Tab",
        0x0d => "Enter",
        0x1b => "Escape",
        0x20 => "Space",
        0x23 => "End",
        0x24 => "Home",
        0x25 => "ArrowLeft",
        0x26 => "ArrowUp",
        0x27 => "ArrowRight",
        0x28 => "ArrowDown",
        0x2e => "Delete",
        0xba => "Semicolon",
        0xbb => "Equal",
        0xbc => "Comma",
        0xbd => "Minus",
        0xbe => "Period",
        0xbf => "Slash",
        0xc0 => "Backquote",
        0xdb => "BracketLeft",
        0xdc => "Backslash",
        0xdd => "BracketRight",
        0xde => "Quote",
        _ => return None,
    };
    Some(c.to_string())
}

/// 沒在組字時要攔下來的鍵：注音、聲調與標點鍵（網頁測試台的 SEND 去掉編輯鍵）。
/// 空白、Enter、方向鍵等交給應用程式
fn starts_composition(code: &str) -> bool {
    code.starts_with("Key")
        || code.starts_with("Digit")
        || matches!(
            code,
            "Minus"
                | "Semicolon"
                | "Comma"
                | "Period"
                | "Slash"
                | "BracketLeft"
                | "BracketRight"
                | "Backslash"
                | "Quote"
                | "Backquote"
        )
}

struct Key {
    code: Option<String>,
    /// KeyboardEvent.key：TSF 依目前修飾鍵轉出的字元（Shift+, → "<"），標點靠它
    key: Option<String>,
    vk: u32,
    ctrl_alt: bool,
}

fn key_of(msg: &Value) -> Key {
    let vk = msg["keyCode"].as_u64().unwrap_or(0) as u32;
    let ch = msg["charCode"].as_u64().unwrap_or(0) as u32;
    let down = |k: usize| {
        msg["keyStates"]
            .get(k)
            .and_then(Value::as_u64)
            .is_some_and(|s| s & 0x80 != 0)
    };
    Key {
        code: code_of(vk),
        key: (ch > 0x1f && ch != 0x7f)
            .then(|| char::from_u32(ch).map(String::from))
            .flatten(),
        vk,
        ctrl_alt: down(VK_CONTROL) || down(VK_MENU),
    }
}

pub struct Backend {
    eng: ImeEngine,
    /// adapter.json 的位置；None＝不學習也不存檔
    adapter_file: Option<PathBuf>,
    icon_dir: PathBuf,
    win8: bool,
    /// 目前組字屬於哪個 client
    owner: String,
    /// 單按 Shift：按下 Shift 後到放開前沒有按別的鍵
    shift_alone: bool,
}

impl Backend {
    pub fn new(eng: ImeEngine, adapter_file: Option<PathBuf>, icon_dir: PathBuf) -> Self {
        Backend {
            eng,
            adapter_file,
            icon_dir,
            win8: true,
            owner: String::new(),
            shift_alone: false,
        }
    }

    fn save_adapter(&self) {
        let (Some(f), Some(a)) = (&self.adapter_file, &self.eng.adapter) else {
            return;
        };
        // 先寫暫存檔再改名：寫到一半當掉不會毀掉學習資料
        let tmp = f.with_extension("json.tmp");
        let ok = f.parent().map_or(Ok(()), std::fs::create_dir_all).is_ok()
            && std::fs::write(&tmp, a.to_json()).is_ok()
            && std::fs::rename(&tmp, f).is_ok();
        if !ok {
            eprintln!("[pime] 無法寫入 {}", f.display());
        }
    }

    fn mode_icon(&self) -> String {
        let name = if self.eng.mode == Mode::Zhuyin {
            "zh.ico"
        } else {
            "en.ico"
        };
        self.icon_dir.join(name).to_string_lossy().into_owned()
    }

    fn mode_button(&self, r: &mut Map<String, Value>, method: &str) {
        if !self.win8 {
            return;
        }
        let tip = if self.eng.mode == Mode::Zhuyin {
            "注音（單按 Shift 切換英文）"
        } else {
            "英文（單按 Shift 切換注音）"
        };
        r.entry(method)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id": MODE_BUTTON, "icon": self.mode_icon(), "tooltip": tip, "commandId": ID_MODE,
            }));
    }

    /// 把引擎狀態寫進回應：組字字串、游標（UTF-16 單位）、選字視窗
    fn show(&self, r: &mut Map<String, Value>, st: &EngineState) {
        let chars: Vec<char> = st.composition.chars().collect();
        let pend = st.pending.as_deref().map_or(0, |p| p.chars().count());
        let upto = (st.cursor + pend).min(chars.len());
        let cursor: usize = chars[..upto].iter().map(|c| c.len_utf16()).sum();
        r.insert("compositionString".into(), json!(st.composition));
        r.insert("compositionCursor".into(), json!(cursor));
        match &st.menu {
            Some(m) => {
                r.insert("candidateList".into(), json!(m.items));
                r.insert("candidateCursor".into(), json!(0));
                r.insert("showCandidates".into(), json!(true));
            }
            None => {
                r.insert("showCandidates".into(), json!(false));
            }
        }
    }

    fn commit_text(&self, r: &mut Map<String, Value>, text: &str) {
        if !text.is_empty() {
            let prev = r
                .get("commitString")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            r.insert("commitString".into(), json!(prev + text));
        }
    }

    fn clear(&mut self, r: &mut Map<String, Value>) {
        self.eng.clear();
        r.insert("compositionString".into(), json!(""));
        r.insert("showCandidates".into(), json!(false));
    }

    fn toggle(&mut self, r: &mut Map<String, Value>) {
        let text = self.eng.toggle_mode();
        if !text.is_empty() {
            self.save_adapter();
        }
        self.commit_text(r, &text);
        r.insert("compositionString".into(), json!(""));
        r.insert("showCandidates".into(), json!(false));
        self.mode_button(r, "changeButton");
        let msg = if self.eng.mode == Mode::Zhuyin {
            "注"
        } else {
            "英"
        };
        r.insert("showMessage".into(), json!({"message": msg, "duration": 1}));
    }

    fn filter_key_down(&mut self, k: &Key) -> bool {
        if k.vk as usize == VK_SHIFT {
            self.shift_alone = !k.ctrl_alt;
            return false;
        }
        self.shift_alone = false;
        if self.eng.is_composing() {
            return true;
        }
        self.eng.mode == Mode::Zhuyin
            && !k.ctrl_alt
            && k.code.as_deref().is_some_and(starts_composition)
    }

    fn on_key_down(&mut self, k: &Key, r: &mut Map<String, Value>) -> bool {
        // 組字中的其他鍵（Tab、F1、Ctrl+…）吃掉，不讓它插進組字中間
        let Some(code) = k.code.as_deref().filter(|_| !k.ctrl_alt) else {
            return true;
        };
        if code == "Enter" && self.eng.state(true).menu.is_none() {
            let text = self.eng.commit(0);
            self.save_adapter();
            self.commit_text(r, &text);
            self.clear(r);
            return true;
        }
        let st = self.eng.on_key(code, k.key.as_deref());
        if let Some(t) = &st.text {
            self.commit_text(r, t);
        }
        self.show(r, &st);
        true
    }

    fn handle(&mut self, client: &str, msg: &Value) -> Map<String, Value> {
        let method = msg["method"].as_str().unwrap_or("");
        let mut r = Map::new();
        // 只有一份組字狀態：換了 client 就丟掉前一個 client 的組字
        // ponytail: 全部 client 共用一個引擎與中英模式；要各程式各自的模式再改成每 client 一份狀態
        if client != self.owner && method.ends_with("KeyDown") {
            if self.eng.is_composing() {
                self.eng.clear();
            }
            self.owner = client.to_string();
        }
        let ret: Option<bool> = match method {
            "init" => {
                self.win8 = msg["isWindows8Above"].as_bool().unwrap_or(true);
                None
            }
            "onActivate" => {
                r.insert("setSelKeys".into(), json!("123456789"));
                r.insert(
                    "customizeUI".into(),
                    json!({"candPerRow": 1, "candUseCursor": true}),
                );
                self.mode_button(&mut r, "addButton");
                None
            }
            "onDeactivate" => {
                self.clear(&mut r);
                if self.win8 {
                    r.insert("removeButton".into(), json!([MODE_BUTTON]));
                }
                None
            }
            "filterKeyDown" => Some(self.filter_key_down(&key_of(msg))),
            "onKeyDown" => Some(self.on_key_down(&key_of(msg), &mut r)),
            "filterKeyUp" => {
                let k = key_of(msg);
                let toggle = k.vk as usize == VK_SHIFT && self.shift_alone;
                self.shift_alone = false;
                Some(toggle)
            }
            "onKeyUp" => {
                self.toggle(&mut r);
                Some(true)
            }
            "onCommand" => {
                if msg["id"].as_i64() == Some(ID_MODE) {
                    self.toggle(&mut r);
                }
                None
            }
            "onKeyboardStatusChanged" => {
                if msg["opened"].as_bool() == Some(false) {
                    self.clear(&mut r);
                }
                if self.win8 {
                    r.insert(
                        "changeButton".into(),
                        json!([{"id": MODE_BUTTON, "enable": msg["opened"]}]),
                    );
                }
                None
            }
            // 被系統強制結束（切換程式等）：已顯示的組字留在文件裡，引擎這邊清空、不學習
            "onCompositionTerminated" => {
                self.eng.clear();
                None
            }
            "onPreservedKey" => Some(false),
            "onMenu" | "onCompartmentChanged" => None,
            _ => {
                r.insert("success".into(), json!(false));
                None
            }
        };
        if let Some(v) = ret {
            r.insert("return".into(), json!(v));
        }
        r.entry("success").or_insert(json!(true));
        r.insert("seqNum".into(), msg["seqNum"].clone());
        r
    }
}

pub fn serve(mut be: Backend) {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        let Some((client, text)) = line.split_once('|') else {
            continue;
        };
        let Ok(msg) = serde_json::from_str::<Value>(text) else {
            eprintln!("[pime] 無法解析：{line}");
            continue;
        };
        if msg["method"] == "close" {
            continue;
        }
        // 一則訊息出錯不能拖垮後端：所有打字中的程式都靠這個行程。出錯就清掉組字、回 success:false
        let reply =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| be.handle(client, &msg)))
                .unwrap_or_else(|_| {
                    be.eng.clear();
                    let mut r = Map::new();
                    r.insert("success".into(), json!(false));
                    r.insert("seqNum".into(), msg["seqNum"].clone());
                    r
                });
        if writeln!(out, "PIME_MSG|{client}|{}", Value::Object(reply))
            .and_then(|_| out.flush())
            .is_err()
        {
            break;
        }
    }
}
