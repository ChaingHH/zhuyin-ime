//! 學習資料頁的本機網頁服務（pime.rs show_learned）。瀏覽器開檔案沒辦法回頭改後端的資料，
//! 所以右鍵選單「查看學習資料」開 http://127.0.0.1:<port>/?t=<token>：每次載入都拿最新的資料，頁面上的刪除送 POST /delete。
//! 資料與刪除都交給主迴圈處理（引擎、學習資料只在主執行緒），這裡只收發 HTTP。
//! 安全：只綁 127.0.0.1；每個請求都要帶隨機 token（128 bit，OS 亂數）；Host 必須是 127.0.0.1:<port>
//! （擋 DNS rebinding）；POST 的 Origin 必須是這個頁面自己（擋別的網頁送表單）。30 分鐘沒有請求就關掉。
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

const IDLE: Duration = Duration::from_secs(30 * 60);
/// 刪除請求的內容很小（一個詞和讀音），再大就不收
const MAX_BODY: usize = 4096;

pub enum WebReq {
    /// 學習資料頁（HTML）
    Page,
    /// 刪除：{"kind": "phrase"|"seq"|"global", "word": …, "reading": …}；回 JSON
    Delete(serde_json::Value),
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
        loop {
            match listener.accept() {
                Ok((s, _)) => {
                    last = Instant::now();
                    if let Err(e) = handle(s, &host, &token, &send) {
                        eprintln!("[pime] 學習資料頁：{e}");
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if last.elapsed() > IDLE {
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
) -> std::io::Result<()> {
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
        return respond(&mut s, "403 Forbidden", "text/plain", "forbidden");
    }
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
            Some(page) => respond(&mut s, "200 OK", "text/html", &page),
            None => respond(
                &mut s,
                "503 Service Unavailable",
                "text/plain",
                "backend busy",
            ),
        },
        ("POST", "/delete") => {
            if origin.as_deref() != Some(&format!("http://{host}")) {
                return respond(&mut s, "403 Forbidden", "text/plain", "bad origin");
            }
            if len > MAX_BODY {
                return respond(&mut s, "413 Payload Too Large", "text/plain", "too large");
            }
            let mut body = vec![0; len];
            r.read_exact(&mut body)?;
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body) else {
                return respond(&mut s, "400 Bad Request", "text/plain", "bad json");
            };
            match ask(WebReq::Delete(v)) {
                Some(j) => respond(&mut s, "200 OK", "application/json", &j),
                None => respond(
                    &mut s,
                    "503 Service Unavailable",
                    "text/plain",
                    "backend busy",
                ),
            }
        }
        _ => respond(&mut s, "404 Not Found", "text/plain", "not found"),
    }
}
