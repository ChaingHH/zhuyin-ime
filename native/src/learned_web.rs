//! 學習資料頁的本機網頁服務（pime.rs show_learned）。瀏覽器開檔案沒辦法回頭改後端的資料，
//! 所以右鍵選單「總控台」開 http://127.0.0.1:<port>/?t=<token>：每次載入都拿最新的資料，頁面上的刪除送 POST /delete，
//! 開關與清除送 POST /action。
//! 資料與刪除都交給主迴圈處理（引擎、學習資料只在主執行緒），這裡只收發 HTTP。
//! 安全：只綁 127.0.0.1；每個請求都要帶隨機 token（128 bit，OS 亂數）；Host 必須是 127.0.0.1:<port>
//! （擋 DNS rebinding）；POST 的 Origin 必須是這個頁面自己（擋別的網頁送表單）。
//! 何時關：頁面關掉時送 POST /close（pagehide），開著的頁面數歸零、GRACE 內沒有新的頁面（重新整理會先 close 再 GET）
//! 就關。收不到 close 的時候（有的瀏覽器關分頁不送、瀏覽器當掉）：開著的頁面每 60 秒 GET /ping，
//! IDLE 沒有任何請求也關。
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 這麼久沒有請求就關。頁面每 60 秒 ping 一次；背景分頁的計時器最慢也每分鐘跑一次（Chrome 的節流），留 3 倍餘裕
const IDLE: Duration = Duration::from_secs(3 * 60);
/// 最後一個頁面關掉後等多久才關（重新整理是先 close 再 GET）
const GRACE: Duration = Duration::from_secs(3);

/// 一個請求對開著的頁面數的影響
enum Event {
    Open,
    Close,
    Other,
}
/// 刪除請求的內容很小（一個詞和讀音），再大就不收
const MAX_BODY: usize = 4096;

pub enum WebReq {
    /// 學習資料頁（HTML）
    Page,
    /// 刪除：{"kind": "phrase"|"seq"|"global", "word": …, "reading": …}；回 JSON
    Delete(serde_json::Value),
    /// 開關與清除：{"op": "learning"|"usage"|"l3"|"refine"|"menuPromote"|"typoLearning", "on": bool}、{"op": "clearUsage"|"clearTypos"|"clearAll"}；回 JSON
    Action(serde_json::Value),
}

/// 交給主迴圈的請求；主迴圈把回應送回 reply
pub struct Ask {
    pub req: WebReq,
    pub token: String,
    pub reply: Sender<String>,
}

pub struct Server {
    pub url: String,
    alive: Arc<AtomicBool>,
}

impl Server {
    /// 還在服務（沒有因為閒置或錯誤關掉）
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }
}

/// 128 bit 亂數：RandomState 的種子來自作業系統的亂數
fn random_token() -> String {
    let part = || {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos()),
        );
        h.finish()
    };
    format!("{:016x}{:016x}", part(), part())
}

/// 開服務。send：把請求交給主迴圈，主迴圈已經結束時回 false
pub fn start(send: impl Fn(Ask) -> bool + Send + 'static) -> std::io::Result<Server> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    listener.set_nonblocking(true)?;
    let token = random_token();
    let url = format!("http://127.0.0.1:{port}/?t={token}");
    let alive = Arc::new(AtomicBool::new(true));
    let alive2 = alive.clone();
    std::thread::spawn(move || {
        let host = format!("127.0.0.1:{port}");
        let mut last = Instant::now();
        // 開著的頁面數；歸零的時間
        let (mut open, mut closed_at) = (0usize, None::<Instant>);
        loop {
            match listener.accept() {
                Ok((s, _)) => {
                    last = Instant::now();
                    match handle(s, &host, &token, &send) {
                        Ok(Event::Open) => {
                            open += 1;
                            closed_at = None;
                        }
                        Ok(Event::Close) => {
                            open = open.saturating_sub(1);
                            if open == 0 {
                                closed_at = Some(Instant::now());
                            }
                        }
                        Ok(Event::Other) => {}
                        Err(e) => eprintln!("[pime] 學習資料頁：{e}"),
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if last.elapsed() > IDLE || closed_at.is_some_and(|t| t.elapsed() > GRACE) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(_) => break,
            }
        }
        alive2.store(false, Ordering::Relaxed);
    });
    Ok(Server { url, alive })
}

fn respond(s: &mut TcpStream, status: &str, kind: &str, body: &str) -> std::io::Result<()> {
    write!(
        s,
        "HTTP/1.1 {status}\r\nContent-Type: {kind}; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    )
}

fn handle(
    s: TcpStream,
    host: &str,
    token: &str,
    send: &impl Fn(Ask) -> bool,
) -> std::io::Result<Event> {
    s.set_nonblocking(false)?;
    s.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut r = BufReader::new(s.try_clone()?);
    let mut s = s;
    let mut line = String::new();
    r.by_ref().take(8192).read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let (mut h_host, mut origin, mut len) = (String::new(), None::<String>, 0usize);
    loop {
        let mut h = String::new();
        if r.by_ref().take(8192).read_line(&mut h)? == 0 || h.trim().is_empty() {
            break;
        }
        let Some((k, v)) = h.split_once(':') else {
            continue;
        };
        let v = v.trim().to_string();
        match k.trim().to_ascii_lowercase().as_str() {
            "host" => h_host = v,
            "origin" => origin = Some(v),
            "content-length" => len = v.parse().unwrap_or(usize::MAX),
            _ => {}
        }
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let t = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("t="))
        .unwrap_or("");
    if h_host != host || t != token {
        return respond(&mut s, "403 Forbidden", "text/plain", "forbidden").map(|_| Event::Other);
    }
    let same_origin = origin.as_deref() == Some(&format!("http://{host}"));
    let ask = |req: WebReq| -> Option<String> {
        let (tx, rx) = channel();
        send(Ask {
            req,
            token: token.to_string(),
            reply: tx,
        })
        .then_some(())?;
        rx.recv_timeout(Duration::from_secs(10)).ok()
    };
    match (method, path) {
        ("GET", "/") => match ask(WebReq::Page) {
            Some(page) => respond(&mut s, "200 OK", "text/html", &page).map(|_| Event::Open),
            None => respond(
                &mut s,
                "503 Service Unavailable",
                "text/plain",
                "backend busy",
            )
            .map(|_| Event::Other),
        },
        // 頁面關掉（pagehide）
        // 頁面還開著（只更新最後請求的時間）
        ("GET", "/ping") => respond(&mut s, "200 OK", "text/plain", "ok").map(|_| Event::Other),
        ("POST", "/close") if same_origin => {
            respond(&mut s, "200 OK", "text/plain", "ok").map(|_| Event::Close)
        }
        ("POST", "/delete" | "/action") => {
            if !same_origin {
                return respond(&mut s, "403 Forbidden", "text/plain", "bad origin")
                    .map(|_| Event::Other);
            }
            if len > MAX_BODY {
                return respond(&mut s, "413 Payload Too Large", "text/plain", "too large")
                    .map(|_| Event::Other);
            }
            let mut body = vec![0; len];
            r.read_exact(&mut body)?;
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body) else {
                return respond(&mut s, "400 Bad Request", "text/plain", "bad json")
                    .map(|_| Event::Other);
            };
            let req = if path == "/delete" {
                WebReq::Delete(v)
            } else {
                WebReq::Action(v)
            };
            match ask(req) {
                Some(j) => respond(&mut s, "200 OK", "application/json", &j),
                None => respond(
                    &mut s,
                    "503 Service Unavailable",
                    "text/plain",
                    "backend busy",
                ),
            }
            .map(|_| Event::Other)
        }
        _ => respond(&mut s, "404 Not Found", "text/plain", "not found").map(|_| Event::Other),
    }
}
