//! PIME 後端協定（`zhuyin-native pime`）：PIMELauncher 從 stdin 送 `<client_id>|<JSON>`，
//! 後端每則回一行 `PIME_MSG|<client_id>|<JSON>`。方法與回應欄位照 PIME 的 python/textService.py：
//! init、onActivate／onDeactivate、filterKeyDown／onKeyDown／filterKeyUp／onKeyUp、onCommand、
//! onKeyboardStatusChanged、onCompositionTerminated、close；回應帶 compositionString、
//! compositionCursor、commitString、candidateList、showCandidates、candidateCursor、return。
//! 按鍵行為照網頁測試台（packages/cli/web/index.html）：單按 Shift 切換注音／英文、Enter 送出、
//! ↓ 開選字視窗、數字選字、←→ 移游標、Esc 取消；沒在組字時編輯鍵交給應用程式；
//! 組字中按 Ctrl／Alt 組合鍵（Ctrl+V…）先送出組字再交給應用程式。
//!
//! 記憶體跟著使用走（docs/MEMORY.md §6）：PIMELauncher 在第一次有 client 用到這個後端時才開行程，
//! 之後不會關，行程結束 1 秒後還會自動重開。所以行程常駐、引擎不常駐：第一個要組字的按鍵才載入
//! 引擎，閒置 ZHUYIN_IDLE_SECS 秒（預設 300）沒按鍵、或最後一個 client 停用時卸載。
use crate::engine::{EngineState, ImeEngine, Mode};
use crate::{decode, l3, lexicon, lm, x2};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime};

#[link(name = "kernel32")]
extern "system" {
    fn GetProcessHeap() -> isize;
    fn HeapCompact(h: isize, flags: u32) -> usize;
    fn GetCurrentProcess() -> isize;
    fn SetProcessWorkingSetSize(p: isize, min: usize, max: usize) -> i32;
    fn SetStdHandle(which: u32, h: isize) -> i32;
    fn GetLocalTime(t: *mut [u16; 8]);
}

/// 現在的當地時間 "2026-10-21 13:11:42"
fn now_str() -> String {
    let mut t = [0u16; 8];
    unsafe { GetLocalTime(&mut t) };
    format!(
        "{}-{:02}-{:02} {:02}:{:02}:{:02}",
        t[0], t[1], t[3], t[4], t[5], t[6]
    )
}

/// stderr（eprintln、panic 訊息）改寫到記錄檔。Rust 每次寫 stderr 都重新拿標準控制代碼，所以換掉就生效。
/// 超過 1MB 先改名成 .old。打不開就照舊（stderr 被 PIMELauncher 丟掉）
pub fn log_to_file(path: &std::path::Path) {
    use std::os::windows::io::AsRawHandle;
    if std::fs::metadata(path).is_ok_and(|m| m.len() > 1 << 20) {
        let _ = std::fs::rename(path, path.with_extension("log.old"));
    }
    let _ = path.parent().map(std::fs::create_dir_all);
    let Ok(f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    // STD_ERROR_HANDLE = (DWORD)-12；檔案要活到行程結束
    unsafe { SetStdHandle(-12i32 as u32, f.as_raw_handle() as isize) };
    std::mem::forget(f);
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        eprintln!("[pime] {} panic：", now_str());
        default(info);
    }));
    eprintln!(
        "[pime] {} 啟動 pid {} {}",
        now_str(),
        std::process::id(),
        env!("CARGO_PKG_VERSION")
    );
}

const VK_SHIFT: usize = 0x10;
const VK_CONTROL: usize = 0x11;
const VK_MENU: usize = 0x12;
const MODE_BUTTON: &str = "windows-mode-icon";
const ID_MODE: i64 = 1;
/// 右鍵選單：哪一邊的 Shift 切換中英（id 2 沿用舊版的「只用左 Shift」）
const ID_SHIFT_LEFT: i64 = 2;
const ID_SHIFT_RIGHT: i64 = 3;
const ID_SHIFT_BOTH: i64 = 4;
/// 選字視窗展開成表格：直的 9 個（每欄由上往下 1–9）、橫的 4 欄（使用者指定 9×4，2026-10-21，同微軟注音）。
/// PIME 的 DLL 逐列畫（libIME2 CandidateWindow 第 i 個在第 i / candPerRow 列），所以送出前要轉置（`grid`）
const TABLE_COLS: usize = 4;
const TABLE_ROWS: usize = 9;
/// 候選字型：微軟注音用的微軟正黑體（LOGFONT 字型名最多 31 字元，PIMETextService.cpp:258）
const CAND_FONT: &str = "Microsoft JhengHei UI";
const CAND_FONT_SIZE: i64 = 14;
/// 送出後多久沒按鍵才寫 adapter.json（ZHUYIN_SAVE_SECS 可改）。每次 Enter 都整檔重寫要約 17ms
/// （docs/MEMORY.md「X2 學習資料的成長」），所以只標記有改動，停手後才寫；卸載、結束時一定寫。
/// ponytail: 後端被直接殺掉（例如登出）會少存最後這幾秒的學習
fn save_delay() -> Duration {
    secs(
        std::env::var("ZHUYIN_SAVE_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30.0),
        30.0,
    )
}

/// 設定檔／環境變數的秒數 → Duration，夾在 1 秒到 1 天。`from_secs_f64` 遇到負數、NaN、
/// 太大會 panic，而這裡在 `catch_unwind` 外，後端會一直重開
pub fn secs(v: f64, default: f64) -> Duration {
    Duration::try_from_secs_f64(v.clamp(1.0, 86400.0)).unwrap_or(Duration::from_secs_f64(default))
}

/// 載入失敗後多久再試（或下次 onActivate）
const RETRY: Duration = Duration::from_secs(30);
const VK_RSHIFT: usize = 0xa1;
/// 右 Shift 的掃描碼
const SCAN_RSHIFT: u64 = 0x36;

/// Windows 虛擬鍵碼 → KeyboardEvent.code（美式鍵盤實體鍵位）
fn code_of(vk: u32) -> Option<String> {
    let c = match vk {
        0x30..=0x39 => return Some(format!("Digit{}", vk - 0x30)),
        0x41..=0x5a => return Some(format!("Key{}", char::from(vk as u8))),
        0x60..=0x69 => return Some(format!("Numpad{}", vk - 0x60)),
        0x6a => "NumpadMultiply",
        0x6b => "NumpadAdd",
        0x6d => "NumpadSubtract",
        0x6e => "NumpadDecimal",
        0x6f => "NumpadDivide",
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
        0x21 => "PageUp",
        0x22 => "PageDown",
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
    /// 這個 Shift 是右邊那顆
    right_shift: bool,
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
        right_shift: msg["scanCode"].as_u64() == Some(SCAN_RSHIFT) || down(VK_RSHIFT),
    }
}

/// 載入引擎需要的設定
pub struct Config {
    /// 有 models/lm.bo.bin、processed/lexicon.bin、processed/syllables.json 的目錄
    pub data: String,
    /// adapter.json 的位置；None＝不學習也不存檔
    pub adapter_file: Option<PathBuf>,
    pub l3: bool,
    pub icon_dir: PathBuf,
    /// 多久沒按鍵就卸載引擎
    pub idle: Duration,
    /// 使用者設定檔 config.json（環境變數不一定傳得到後端）；None＝不讀不寫
    pub settings_file: Option<PathBuf>,
}

/// 載入引擎。回傳值第二項：學習檔可不可以寫（讀不懂就不寫，免得蓋掉使用者的學習資料）
fn load(cfg: &Config) -> Result<(ImeEngine, bool), String> {
    let lm = lm::BackoffLm::load(&format!("{}/models/lm.bo.bin", cfg.data))?;
    let lex = lexicon::Lexicon::load(&format!("{}/processed/lexicon.bin", cfg.data))?;
    let mut dec = decode::Decoder::new(lm, lex, 1.0, 0.5);
    let legal = crate::load_legal(&cfg.data);
    let mut save_ok = true;
    let mut adapter = cfg
        .adapter_file
        .as_ref()
        .map(|f| match std::fs::read_to_string(f) {
            Err(_) => x2::UserAdapter::new(),
            Ok(s) => x2::UserAdapter::from_json(&s).unwrap_or_else(|e| {
                eprintln!("[pime] {} 讀不懂（{e}），這次不學習，原檔不動", f.display());
                save_ok = false;
                let mut a = x2::UserAdapter::new();
                a.enabled = false;
                a
            }),
        });
    // 使用者詞條（手動造詞＋歷史挖詞）注入解碼格，同 runtime.ts
    for e in adapter.iter_mut().flat_map(|a| a.drain_pending()) {
        dec.add_entry(&e.word, &e.readings);
    }
    let mut eng = ImeEngine::new(dec, legal.clone(), adapter);
    if cfg.l3 {
        eng.channel = Some(l3::Channel::new(legal, Default::default()));
    }
    Ok((eng, save_ok))
}

pub struct Backend {
    cfg: Config,
    /// None＝還沒載入或已卸載
    eng: Option<ImeEngine>,
    save_ok: bool,
    /// 上次載入失敗的時間：之後 RETRY 秒內按鍵全部放行給應用程式，過了或 onActivate 再試
    /// （例如重載時剛好遇到安裝換檔）
    broken: Option<Instant>,
    /// 注音／英文；引擎卸載後也要記得
    mode: Mode,
    /// 目前啟用這個輸入法的 client
    active: HashSet<String>,
    last_key: Instant,
    win8: bool,
    /// 目前組字屬於哪個 client
    owner: String,
    /// 單按 Shift：按下 Shift 後到放開前沒有按別的鍵
    shift_alone: bool,
    /// 哪一邊的 Shift 單按會切換中英：config.json 的 "shiftToggle"，"both"｜"left"｜"right"
    shift_toggle: &'static str,
    /// 選字視窗是否展開成表格（→／Tab 展開、← 收回；視窗關掉就回到清單）
    table: bool,
    /// 這個鍵（filterKeyDown 決定）只是展開／收回表格，onKeyDown 不交給引擎
    layout_key: bool,
    /// 每個 client 的 DLL 目前的 candPerRow（只在變了才送）。每個程式各有一份 DLL：
    /// 只記一份的話，別的程式 onActivate 或展開過表格後，這個程式的視窗會用錯的欄數畫（2026-10-21 清單變成橫的 1×9）
    sent_cols: HashMap<String, usize>,
    /// 候選字型與字級（config.json 的 candFontName／candFontSize）
    font: (String, i64),
    /// 學習資料有改動、還沒寫檔
    dirty: bool,
    save_delay: Duration,
    /// config.json 的 hotUpdate：執行檔被換掉後，沒有 client 啟用時自己結束，讓 PIMELauncher 開新版。
    /// 要 PIME v2.0.0-beta2 以上（舊版 DLL 遇到後端結束會讓宿主程式當掉）。
    /// 設定檔沒寫時看 PIME 版本（`pime_restart_safe`），讀不到版本就關
    hot_update: bool,
    /// 啟動時的執行檔路徑與修改時間
    exe: Option<(PathBuf, SystemTime)>,
}

impl Backend {
    pub fn new(cfg: Config) -> Self {
        Backend {
            cfg,
            eng: None,
            save_ok: true,
            broken: None,
            mode: Mode::Zhuyin,
            active: HashSet::new(),
            last_key: Instant::now(),
            win8: true,
            owner: String::new(),
            shift_alone: false,
            shift_toggle: "both",
            table: false,
            layout_key: false,
            sent_cols: HashMap::new(),
            font: (CAND_FONT.into(), CAND_FONT_SIZE),
            dirty: false,
            save_delay: save_delay(),
            hot_update: false,
            exe: std::env::current_exe()
                .ok()
                .and_then(|p| Some((p.clone(), std::fs::metadata(&p).ok()?.modified().ok()?))),
        }
        .with_settings()
    }

    fn with_settings(mut self) -> Self {
        self.read_settings();
        self
    }

    fn settings(&self) -> Map<String, Value> {
        self.cfg
            .settings_file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }

    /// 讀 config.json：shiftToggle（"both"｜"left"｜"right"，其他值當 both）、idleSecs（閒置幾秒卸載）、l3（下次載入生效）。
    /// 檔案裡有的項目蓋過環境變數與預設；每次 onActivate 重讀，改了不用重開
    fn read_settings(&mut self) {
        let s = self.settings();
        self.shift_toggle = match s.get("shiftToggle").and_then(Value::as_str) {
            Some("left") => "left",
            Some("right") => "right",
            _ => "both",
        };
        if let Some(secs_v) = s.get("idleSecs").and_then(Value::as_f64) {
            self.cfg.idle = secs(secs_v, 300.0);
        }
        if let Some(l3) = s.get("l3").and_then(Value::as_bool) {
            self.cfg.l3 = l3;
        }
        self.hot_update = s
            .get("hotUpdate")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| self.pime_restart_safe());
        self.font = (
            s.get("candFontName")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty() && n.encode_utf16().count() <= 31)
                .unwrap_or(CAND_FONT)
                .into(),
            s.get("candFontSize")
                .and_then(Value::as_i64)
                .filter(|n| (6..=72).contains(n))
                .unwrap_or(CAND_FONT_SIZE),
        );
    }

    fn menu_open(&self) -> bool {
        self.eng
            .as_ref()
            .is_some_and(|e| e.state(true).menu.is_some())
    }

    /// 表格展開／收回。DLL 的 updateStatus 最後才套用 customizeUI，同一則回應裡的候選清單
    /// 會用舊的 candPerRow 畫（PIMEClient.cpp updateStatus、PIMETextService.cpp:269）。
    /// 所以在 filterKeyDown 的回應先送 candPerRow（沒有 edit session 也安全：updateUI 不碰 session），
    /// 同一個鍵的 onKeyDown 回應再帶候選清單，就會用新的欄數重畫
    fn table_layout(&mut self, k: &Key, r: &mut Map<String, Value>) {
        // 清單時 →／Tab 展開、表格第一頁最左欄 ← 收回：這個鍵只換排法，不交給引擎（引擎的 ← → 是換欄）
        let first_col = self
            .eng
            .as_ref()
            .and_then(|e| e.state(true).menu)
            .is_some_and(|m| m.page == 0 && m.cursor < TABLE_ROWS);
        if self.menu_open() {
            match k.code.as_deref() {
                Some("ArrowRight" | "Tab") if !self.table => {
                    self.table = true;
                    self.layout_key = true;
                }
                Some("ArrowLeft") if self.table && first_col => {
                    self.table = false;
                    self.layout_key = true;
                }
                _ => {}
            }
        } else {
            self.table = false;
        }
        let page = if self.table {
            TABLE_COLS * TABLE_ROWS
        } else {
            TABLE_ROWS
        };
        let Some(e) = self.eng.as_mut() else {
            return;
        };
        e.set_page_size(page);
        // 欄數照這個鍵之後那一頁的候選數：最後一頁不滿 36 個就少幾欄，視窗不會拖著空欄
        let len = k
            .code
            .as_deref()
            .and_then(|c| e.menu_page_len_after(c))
            .unwrap_or(0);
        let cols = if self.table {
            len.div_ceil(TABLE_ROWS).clamp(1, TABLE_COLS)
        } else {
            1
        };
        if self.sent_cols.get(&self.owner) != Some(&cols) {
            self.sent_cols.insert(self.owner.clone(), cols);
            r.insert("customizeUI".into(), json!({ "candPerRow": cols }));
        }
    }

    /// 這次組字的 client 的 DLL 現在幾欄
    fn cols(&self) -> usize {
        self.sent_cols.get(&self.owner).copied().unwrap_or(1)
    }

    /// 改一項設定並存檔（保留檔案裡其他項目；先寫暫存檔再改名）
    fn write_setting(&self, key: &str, v: Value) {
        let Some(f) = &self.cfg.settings_file else {
            return;
        };
        let mut s = self.settings();
        s.insert(key.into(), v);
        let tmp = f.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(&Value::Object(s)).unwrap();
        let ok = f.parent().map_or(Ok(()), std::fs::create_dir_all).is_ok()
            && std::fs::write(&tmp, text).is_ok()
            && std::fs::rename(&tmp, f).is_ok();
        if !ok {
            eprintln!("[pime] 無法寫入 {}", f.display());
        }
    }

    /// 需要時才載入引擎
    fn engine(&mut self) -> Option<&mut ImeEngine> {
        if self.eng.is_none() && !self.gave_up() {
            let t = Instant::now();
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| load(&self.cfg)));
            match r {
                Ok(Ok((mut eng, save_ok))) => {
                    eng.mode = self.mode;
                    self.eng = Some(eng);
                    self.save_ok = save_ok;
                    eprintln!("[pime] 載入引擎 {:?}", t.elapsed());
                }
                Ok(Err(e)) => {
                    self.broken = Some(Instant::now());
                    eprintln!("[pime] 載入失敗，{RETRY:?} 內按鍵都放行：{e}");
                }
                Err(_) => {
                    self.broken = Some(Instant::now());
                    eprintln!("[pime] 載入失敗（panic），{RETRY:?} 內按鍵都放行");
                }
            }
        }
        self.eng.as_mut()
    }

    /// 剛載入失敗，還沒到重試時間
    fn gave_up(&self) -> bool {
        self.broken.is_some_and(|t| t.elapsed() < RETRY)
    }

    /// 存學習檔、丟掉引擎，再把空出來的 heap 與工作集還給系統
    fn unload(&mut self) {
        if self.eng.is_none() {
            return;
        }
        self.flush();
        self.eng = None;
        unsafe {
            HeapCompact(GetProcessHeap(), 0);
            SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);
        }
        eprintln!("[pime] 卸載引擎");
    }

    fn composing(&self) -> bool {
        self.eng.as_ref().is_some_and(|e| e.is_composing())
    }

    /// 有改動才寫 adapter.json
    fn flush(&mut self) {
        if self.dirty {
            self.save_adapter();
            self.dirty = false;
        }
    }

    fn save_adapter(&self) {
        let (Some(f), Some(a)) = (
            self.cfg.adapter_file.as_ref().filter(|_| self.save_ok),
            self.eng.as_ref().and_then(|e| e.adapter.as_ref()),
        ) else {
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
        let name = if self.mode == Mode::Zhuyin {
            "zh.ico"
        } else {
            "en.ico"
        };
        self.cfg.icon_dir.join(name).to_string_lossy().into_owned()
    }

    fn mode_button(&self, r: &mut Map<String, Value>, method: &str) {
        if !self.win8 {
            return;
        }
        let tip = if self.mode == Mode::Zhuyin {
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

    /// 把引擎狀態寫進回應：組字字串、游標（UTF-16 單位）、選字視窗（cols＝DLL 目前的欄數）
    fn show(r: &mut Map<String, Value>, st: &EngineState, cols: usize) {
        let chars: Vec<char> = st.composition.chars().collect();
        let pend = st.pending.as_deref().map_or(0, |p| p.chars().count());
        let upto = (st.cursor + pend).min(chars.len());
        let cursor: usize = chars[..upto].iter().map(|c| c.len_utf16()).sum();
        r.insert("compositionString".into(), json!(st.composition));
        r.insert("compositionCursor".into(), json!(cursor));
        match &st.menu {
            Some(m) => {
                let (items, cursor, keys) = grid(&m.items, m.cursor, cols);
                // 標籤跟著排法變，每次都送：updateStatus 先套用 setSelKeys 才畫候選
                r.insert("setSelKeys".into(), json!(keys));
                r.insert("candidateList".into(), json!(items));
                r.insert("candidateCursor".into(), json!(cursor));
                r.insert("showCandidates".into(), json!(true));
            }
            None => {
                r.insert("showCandidates".into(), json!(false));
            }
        }
    }

    fn commit_text(r: &mut Map<String, Value>, text: &str) {
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
        if let Some(e) = self.eng.as_mut() {
            e.clear();
        }
        r.insert("compositionString".into(), json!(""));
        r.insert("showCandidates".into(), json!(false));
    }

    /// 只換模式、更新語言列圖示。沒有 edit session 的回應（onCommand）只能用這個：
    /// PIME 的 DLL 在沒有 session 時收到 showMessage 會解參考空指標，宿主程式直接當掉
    fn flip_mode(&mut self, r: &mut Map<String, Value>) {
        if let Some(e) = self.eng.as_mut() {
            e.mode = if self.mode == Mode::Zhuyin {
                Mode::English
            } else {
                Mode::Zhuyin
            };
        }
        self.mode = if self.mode == Mode::Zhuyin {
            Mode::English
        } else {
            Mode::Zhuyin
        };
        self.mode_button(r, "changeButton");
    }

    /// 單按 Shift（onKeyUp，有 edit session）：換模式（只換語言列圖示，不跳提示）。
    /// 組字區不送出：接著打的英文併進組字區（ImeEngine::on_key），後打的字還能改前面的中文
    fn toggle(&mut self, r: &mut Map<String, Value>) {
        let cols = self.cols();
        // 引擎沒載入就沒有組字，只換模式
        if let Some(e) = self.eng.as_mut() {
            let was = e.is_composing();
            e.toggle_mode();
            if e.is_composing() {
                Self::show(r, &e.state(true), cols);
            } else if was {
                // 組字區只有打到一半的注音，切英文後丟掉了：清掉畫面上的組字
                r.insert("compositionString".into(), json!(""));
            }
        }
        self.mode = if self.mode == Mode::Zhuyin {
            Mode::English
        } else {
            Mode::Zhuyin
        };
        self.mode_button(r, "changeButton");
    }

    fn filter_key_down(&mut self, k: &Key, r: &mut Map<String, Value>) -> bool {
        if k.vk as usize == VK_SHIFT {
            let side_ok = match self.shift_toggle {
                "left" => !k.right_shift,
                "right" => k.right_shift,
                _ => true,
            };
            self.shift_alone = !k.ctrl_alt && side_ok;
            return false;
        }
        self.shift_alone = false;
        // 每個鍵都先重設：組字被系統結束後，下一個鍵不會走 table_layout
        self.layout_key = false;
        // 單按 Ctrl、Alt、Win 不動組字（Ctrl+V 要等 V 按下才送出組字）
        if matches!(k.vk, 0x11 | 0x12 | 0x5b | 0x5c | 0xa2..=0xa5) {
            return false;
        }
        if self.composing() {
            self.table_layout(k, r);
            return true;
        }
        !self.gave_up()
            && self.mode == Mode::Zhuyin
            && !k.ctrl_alt
            && k.code.as_deref().is_some_and(starts_composition)
    }

    fn on_key_down(&mut self, k: &Key, r: &mut Map<String, Value>) -> bool {
        // Ctrl／Alt 組合鍵（Ctrl+V 貼上、Ctrl+Z、Ctrl+S…）：先送出組字（同 Enter），按鍵交給應用程式。
        // DLL 先套用回應（commitString）再看 return，所以應用程式收到按鍵時字已經在文件裡
        if k.ctrl_alt {
            if let Some(e) = self.eng.as_mut().filter(|e| e.is_composing()) {
                let text = e.commit(0);
                self.dirty = true;
                Self::commit_text(r, &text);
                self.clear(r);
            }
            return false;
        }
        // 組字中的其他鍵（Tab、F1…）吃掉，不讓它插進組字中間
        let Some(code) = k.code.as_deref() else {
            return true;
        };
        let cols = self.cols();
        let layout_key = self.layout_key;
        let Some(eng) = self.engine() else {
            return false;
        };
        if code == "Enter" && eng.state(true).menu.is_none() {
            let text = eng.commit(0);
            self.dirty = true;
            Self::commit_text(r, &text);
            self.clear(r);
            return true;
        }
        let was = eng.is_composing();
        let st = if layout_key {
            eng.state(true)
        } else {
            eng.on_key(code, k.key.as_deref())
        };
        // 英文模式下打空白／標點會整段送出（有學習）
        if was && st.text.is_some() {
            self.dirty = true;
        }
        if let Some(t) = &st.text {
            Self::commit_text(r, t);
        }
        Self::show(r, &st, cols);
        true
    }

    /// client 停用或斷線：沒有 client 在用就卸載
    fn leave(&mut self, client: &str) {
        self.active.remove(client);
        self.sent_cols.remove(client);
        if self.active.is_empty() {
            self.unload();
        }
    }

    /// 還要等多久才有事做（寫學習檔、閒置卸載）；都沒有就一直等訊息
    fn next_wait(&self) -> Option<Duration> {
        let since = self.last_key.elapsed();
        let save = self.dirty.then(|| self.save_delay.saturating_sub(since));
        let idle = self
            .eng
            .as_ref()
            .map(|_| self.cfg.idle.saturating_sub(since));
        match (save, idle) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
        // 開 hotUpdate 時，引擎卸載後也要定期醒來看執行檔換了沒
        .or(self.hot_update.then_some(Duration::from_secs(60)))
    }

    /// 裝的 PIME 能不能承受後端結束：讀 PIME 目錄的 version.txt（執行檔在 PIME\zhuyin\ 底下）。
    /// v2.0.0-beta 的 DLL 遇到後端結束會讓宿主程式當掉；beta2 起修掉（EasyIME/PIME#905）。讀不到就當不安全
    fn pime_restart_safe(&self) -> bool {
        let v = self.exe.as_ref().and_then(|(p, _)| {
            std::fs::read_to_string(p.parent()?.parent()?.join("version.txt")).ok()
        });
        v.is_some_and(|v| pime_version_ok(v.trim()))
    }

    /// 執行檔被換掉了，沒有 client 啟用，引擎已卸載（沒在組字、學習檔已存）：可以結束讓啟動器開新版。
    /// 只在兩則請求之間呼叫，不會在處理請求時結束。讀不到修改時間不算換掉
    fn should_restart(&self) -> bool {
        self.hot_update
            && self.active.is_empty()
            && self.eng.is_none()
            && !self.dirty
            && self.exe.as_ref().is_some_and(|(p, t)| {
                std::fs::metadata(p)
                    .and_then(|m| m.modified())
                    .is_ok_and(|t2| t2 != *t)
            })
    }

    fn on_timeout(&mut self) {
        let since = self.last_key.elapsed();
        if since >= self.save_delay {
            self.flush();
        }
        if self.eng.is_some() && since >= self.cfg.idle {
            self.idle_timeout();
        }
    }

    fn idle_timeout(&mut self) {
        if self.composing() {
            // 組字到一半不卸載，免得畫面上的組字沒了著落；再等一輪
            self.last_key = Instant::now();
        } else {
            self.unload();
        }
    }

    fn handle(&mut self, client: &str, msg: &Value) -> Map<String, Value> {
        let method = msg["method"].as_str().unwrap_or("");
        let mut r = Map::new();
        if method.ends_with("KeyDown") || method.ends_with("KeyUp") {
            self.last_key = Instant::now();
        }
        // 只有一份組字狀態：換了 client 就丟掉前一個 client 的組字
        // ponytail: 全部 client 共用一個引擎與中英模式；要各程式各自的模式再改成每 client 一份狀態
        if client != self.owner && method.ends_with("KeyDown") {
            if let Some(e) = self.eng.as_mut() {
                e.clear();
            }
            self.owner = client.to_string();
        }
        let ret: Option<bool> = match method {
            "init" => {
                self.win8 = msg["isWindows8Above"].as_bool().unwrap_or(true);
                None
            }
            "onActivate" => {
                self.active.insert(client.to_string());
                self.broken = None;
                self.read_settings();
                self.table = false;
                self.sent_cols.insert(client.to_string(), 1);
                r.insert(
                    "customizeUI".into(),
                    json!({
                        "candPerRow": 1,
                        "candUseCursor": true,
                        "candFontName": self.font.0,
                        "candFontSize": self.font.1,
                    }),
                );
                self.mode_button(&mut r, "addButton");
                None
            }
            "onDeactivate" => {
                self.clear(&mut r);
                if self.win8 {
                    r.insert("removeButton".into(), json!([MODE_BUTTON]));
                }
                self.leave(client);
                None
            }
            "filterKeyDown" => Some(self.filter_key_down(&key_of(msg), &mut r)),
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
            // 語言列圖示：左鍵＝id 1，右鍵選單選項＝選單的 id。這裡沒有 edit session：
            // 不能送 showMessage／commitString／compositionString。組字中按圖示不切換（組字會沒地方送出）
            "onCommand" => {
                match msg["id"].as_i64() {
                    Some(ID_MODE) if !self.composing() => self.flip_mode(&mut r),
                    Some(id @ (ID_SHIFT_LEFT | ID_SHIFT_RIGHT | ID_SHIFT_BOTH)) => {
                        self.shift_toggle = match id {
                            ID_SHIFT_LEFT => "left",
                            ID_SHIFT_RIGHT => "right",
                            _ => "both",
                        };
                        self.write_setting("shiftToggle", json!(self.shift_toggle));
                    }
                    _ => {}
                }
                None
            }
            // 右鍵點語言列圖示：回傳選單（PIME 的 menuFromJson 只讀 id／text／checked／enabled／submenu；
            // id 0＋空字串＝分隔線。沒有單選格式，三個 Shift 選項用 checked 標目前那個）
            "onMenu" => {
                r.insert(
                    "return".into(),
                    json!([
                        {"id": ID_MODE, "text": "切換中／英"},
                        {"id": 0, "text": ""},
                        {"id": ID_SHIFT_BOTH, "text": "左右 Shift 都切換中英", "checked": self.shift_toggle == "both"},
                        {"id": ID_SHIFT_LEFT, "text": "只用左 Shift 切換中英", "checked": self.shift_toggle == "left"},
                        {"id": ID_SHIFT_RIGHT, "text": "只用右 Shift 切換中英", "checked": self.shift_toggle == "right"},
                    ]),
                );
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
                if let Some(e) = self.eng.as_mut() {
                    e.clear();
                }
                None
            }
            "onPreservedKey" => Some(false),
            "onCompartmentChanged" => None,
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

/// 引擎一頁的候選（每欄 TABLE_ROWS 個，欄由左到右）轉成 DLL 逐列畫的順序。
/// 回傳（候選、反白位置、選字鍵標籤）：標籤是那一格在欄裡的第幾個（1–9）；
/// 最後一欄不滿時中間的空格補空字串、標籤補空白（DLL 仍會畫出「 . 」），尾端的空格不送
fn grid(items: &[String], cursor: usize, cols: usize) -> (Vec<String>, usize, String) {
    let cols = cols.max(1);
    // 一般是 9 列；欄數比候選少（例如 DLL 還是 1 欄）就加長，不丟候選
    let rows = items
        .len()
        .div_ceil(cols)
        .max(items.len().min(TABLE_ROWS))
        .max(1);
    let mut out = vec![];
    let mut keys = String::new();
    for i in 0..rows * cols {
        let (row, col) = (i / cols, i % cols);
        match items.get(col * rows + row) {
            Some(w) => {
                out.push(w.clone());
                keys.push(char::from(b'1' + (row % TABLE_ROWS) as u8));
            }
            None => {
                out.push(String::new());
                keys.push(' ');
            }
        }
    }
    while out.last().is_some_and(String::is_empty) {
        out.pop();
        keys.pop();
    }
    (out, cursor % rows * cols + cursor / rows, keys)
}

#[cfg(test)]
#[test]
fn grid_is_column_major() {
    let w = |n: usize| (0..n).map(|i| i.to_string()).collect::<Vec<_>>();
    // 36 個、4 欄：第一列是每欄的第 1 個，標籤 1111 2222 …
    let (items, cur, keys) = grid(&w(36), 10, 4);
    assert_eq!(&items[..5], ["0", "9", "18", "27", "1"]);
    assert_eq!(&keys[..8], "11112222");
    assert_eq!(keys.len(), 36);
    // 第 10 個（第 2 欄第 2 個）在第 2 列第 2 格
    assert_eq!(items[cur], "10");
    // 20 個、3 欄：第 3 欄只有 2 個，中間空格補空字串、尾端不送
    let (items, cur, keys) = grid(&w(20), 19, 3);
    assert_eq!(&items[..3], ["0", "9", "18"]);
    assert_eq!(items[5], "19");
    assert_eq!(items[8], "");
    assert_eq!(&keys[6..9], "33 ");
    assert_eq!(items.last().unwrap(), "17");
    assert_eq!(items[cur], "19");
    // 1 欄：原順序
    let (items, cur, keys) = grid(&w(9), 3, 1);
    assert_eq!(items, w(9));
    assert_eq!((cur, keys.as_str()), (3, "123456789"));
}

/// "2.0.0-beta" 不行；"2.0.0-beta2" 以上、正式版 2.x 以上可以
fn pime_version_ok(v: &str) -> bool {
    let (base, pre) = v.split_once('-').unwrap_or((v, ""));
    let major: u32 = base
        .split('.')
        .next()
        .and_then(|m| m.parse().ok())
        .unwrap_or(0);
    if major < 2 || base != "2.0.0" {
        return major >= 2;
    }
    match pre.strip_prefix("beta") {
        Some(n) => n.parse::<u32>().is_ok_and(|n| n >= 2),
        None => pre.is_empty(),
    }
}

#[cfg(test)]
#[test]
fn pime_versions() {
    for (v, ok) in [
        ("2.0.0-beta", false),
        ("2.0.0-beta2", true),
        ("2.0.0-beta3", true),
        ("2.0.0", true),
        ("2.1.0", true),
        ("1.3.0", false),
        ("1.3.0-beta", false),
        ("", false),
    ] {
        assert_eq!(pime_version_ok(v), ok, "{v}");
    }
}

/// 處理一行 `<client_id>|<JSON>`，回要寫出的那一行（close 與看不懂的行不回）
fn respond(be: &mut Backend, line: &str) -> Option<String> {
    let (client, text) = line.trim().split_once('|')?;
    let msg = match serde_json::from_str::<Value>(text) {
        Ok(m) => m,
        Err(_) => {
            eprintln!("[pime] 無法解析：{}", line.trim_end());
            // 撈得到 seqNum 就回失敗，DLL 才不會乾等到逾時
            let seq = text.split("\"seqNum\":").nth(1)?;
            let n: i64 = seq
                .trim_start()
                .split(|c: char| !c.is_ascii_digit() && c != '-')
                .next()?
                .parse()
                .ok()?;
            return Some(format!(
                "PIME_MSG|{client}|{}",
                json!({"success": false, "seqNum": n})
            ));
        }
    };
    if msg["method"] == "close" {
        be.leave(client);
        return None;
    }
    // 一則訊息出錯不能拖垮後端：所有打字中的程式都靠這個行程。出錯就清掉組字、回 success:false。
    // 這裡可能沒有 edit session，絕不能帶 showMessage
    let reply = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| be.handle(client, &msg)))
        .unwrap_or_else(|_| {
            if let Some(e) = be.eng.as_mut() {
                e.clear();
            }
            let mut r = Map::new();
            r.insert("success".into(), json!(false));
            r.insert("compositionString".into(), json!(""));
            r.insert("showCandidates".into(), json!(false));
            r.insert("seqNum".into(), msg["seqNum"].clone());
            r
        });
    Some(format!("PIME_MSG|{client}|{}", Value::Object(reply)))
}

pub fn serve(mut be: Backend) {
    // 另一條執行緒讀 stdin，主迴圈才能在等訊息時順便計時閒置。
    // 用位元組讀：一行壞 UTF-8 不能讓讀取執行緒結束（lines() 會回錯誤）
    let (tx, rx) = channel::<String>();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match stdin.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if tx.send(String::from_utf8_lossy(&buf).into_owned()).is_err() {
                break;
            }
        }
    });
    let mut out = std::io::stdout().lock();
    let mut write = |s: String| writeln!(out, "{s}").and_then(|_| out.flush()).is_ok();
    loop {
        let got = match be.next_wait() {
            Some(d) => rx.recv_timeout(d),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match got {
            Ok(l) => {
                if let Some(s) = respond(&mut be, &l) {
                    if !write(s) {
                        eprintln!("[pime] {} 結束：stdout 寫不出去", now_str());
                        break;
                    }
                }
            }
            // 閒置卸載、寫學習檔也不能拖垮後端（同 respond）
            Err(RecvTimeoutError::Timeout) => {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| be.on_timeout()));
            }
            Err(RecvTimeoutError::Disconnected) => {
                eprintln!(
                    "[pime] {} 結束：stdin 關閉（PIMELauncher 結束或關掉後端）",
                    now_str()
                );
                break;
            }
        }
        if be.should_restart() {
            // 結束前把已經送來的請求處理完；有的話這輪不結束，下次再看
            let mut pending = false;
            while let Ok(l) = rx.try_recv() {
                pending = true;
                if let Some(s) = respond(&mut be, &l) {
                    write(s);
                }
            }
            if !pending {
                eprintln!(
                    "[pime] {} 執行檔已更新，結束讓 PIMELauncher 開新版",
                    now_str()
                );
                break;
            }
        }
    }
    be.unload();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backend() -> Backend {
        Backend::new(Config {
            data: "no-such-dir".into(),
            adapter_file: None,
            l3: false,
            icon_dir: PathBuf::new(),
            idle: Duration::from_secs(300),
            settings_file: None,
        })
    }

    #[test]
    fn secs_clamped() {
        assert_eq!(secs(-5.0, 30.0), Duration::from_secs(1));
        assert_eq!(secs(1e20, 30.0), Duration::from_secs(86400));
        assert_eq!(secs(f64::INFINITY, 30.0), Duration::from_secs(86400));
        assert_eq!(secs(f64::NAN, 30.0), Duration::from_secs(30));
        assert_eq!(secs(2.5, 30.0), Duration::from_millis(2500));
    }

    #[test]
    fn bad_json_replies_with_seq() {
        let mut be = backend();
        assert_eq!(
            respond(&mut be, "c1|{\"method\":\"onKeyDown\",\"seqNum\": 42,"),
            Some(r#"PIME_MSG|c1|{"success":false,"seqNum":42}"#.into())
        );
        assert_eq!(respond(&mut be, "c1|garbage"), None);
        assert_eq!(respond(&mut be, "no bar"), None);
    }

    #[test]
    fn load_failure_retries() {
        let mut be = backend();
        assert!(be.engine().is_none());
        assert!(be.gave_up());
        // onActivate 清掉失敗記錄，下個鍵會再試
        respond(&mut be, r#"c1|{"method":"onActivate","seqNum":1}"#);
        assert!(!be.gave_up());
        be.broken = Some(Instant::now() - RETRY);
        assert!(!be.gave_up());
    }

    #[test]
    fn no_restart_with_active_client() {
        let mut be = backend();
        respond(&mut be, r#"c1|{"method":"onActivate","seqNum":1}"#);
        // onActivate 會重讀設定，所以之後才開
        be.hot_update = true;
        be.exe = Some((std::env::current_exe().unwrap(), SystemTime::UNIX_EPOCH));
        assert!(!be.should_restart());
        respond(&mut be, r#"c1|{"method":"close"}"#);
        assert!(be.should_restart());
        // 讀不到修改時間不算換掉
        be.exe = Some((PathBuf::from("no-such.exe"), SystemTime::UNIX_EPOCH));
        assert!(!be.should_restart());
    }
}
