//! Loopback receiver for the OAuth 2.0 redirect (`http://localhost:<port>/callback?code=...&state=...`).

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Debug, thiserror::Error)]
pub enum OAuthError {
    #[error("не удалось открыть порт {0} для входа: {1}")]
    Bind(u16, std::io::Error),
    #[error("время ожидания входа истекло")]
    Timeout,
    #[error("Box отклонил вход: {0}")]
    Denied(String),
}

const SUCCESS_PAGE: &str = r#"<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>AdvantShoter</title>
<style>body{font:16px system-ui,Segoe UI,sans-serif;background:#0f1115;color:#e8eaf0;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#181b22;border:1px solid #2a2f3a;border-radius:16px;padding:32px 40px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:#9aa3b2;margin:0}</style></head>
<body><div class="card"><h1>✅ Box подключён</h1><p>Можно закрыть эту вкладку и вернуться в AdvantShoter.</p></div></body></html>"#;

const ERROR_PAGE: &str = r#"<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>AdvantShoter</title></head>
<body style="font:16px system-ui;background:#0f1115;color:#e8eaf0;display:grid;place-items:center;height:100vh;margin:0">
<div>Вход не выполнен. Вернитесь в AdvantShoter и попробуйте ещё раз.</div></body></html>"#;

/// Binds the loopback listener. Call before opening the browser so the port is ready.
pub async fn bind(port: u16) -> Result<TcpListener, OAuthError> {
    TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| OAuthError::Bind(port, e))
}

/// Waits for the browser redirect and returns the authorization code.
/// Requests with a wrong `state` (or unrelated requests such as `/favicon.ico`) are ignored.
pub async fn wait_for_code(listener: TcpListener, expected_state: &str, timeout: Duration) -> Result<String, OAuthError> {
    let accept_loop = async {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { continue };
            match handle(&mut stream, expected_state).await {
                Some(result) => return result,
                None => continue,
            }
        }
    };
    tokio::time::timeout(timeout, accept_loop).await.map_err(|_| OAuthError::Timeout)?
}

async fn handle(stream: &mut TcpStream, expected_state: &str) -> Option<Result<String, OAuthError>> {
    let mut buf = vec![0u8; 8192];
    let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await.ok()?.ok()?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let target = request.lines().next()?.split_whitespace().nth(1)?.to_string();
    let url = url::Url::parse(&format!("http://localhost{target}")).ok()?;
    if url.path() != "/callback" {
        respond(stream, "404 Not Found", "").await;
        return None;
    }
    let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.to_string());
    if param("state").as_deref() != Some(expected_state) {
        respond(stream, "400 Bad Request", ERROR_PAGE).await;
        return None;
    }
    if let Some(code) = param("code") {
        respond(stream, "200 OK", SUCCESS_PAGE).await;
        return Some(Ok(code));
    }
    respond(stream, "200 OK", ERROR_PAGE).await;
    let reason = param("error_description").or_else(|| param("error")).unwrap_or_else(|| "неизвестная ошибка".into());
    Some(Err(OAuthError::Denied(reason)))
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn get(port: u16, path: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn receives_code_and_ignores_noise() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiter = tokio::spawn(async move { wait_for_code(listener, "xyz", Duration::from_secs(5)).await });
        assert!(get(port, "/favicon.ico").await.starts_with("HTTP/1.1 404"));
        assert!(get(port, "/callback?code=bad&state=wrong").await.starts_with("HTTP/1.1 400"));
        let ok = get(port, "/callback?code=THECODE&state=xyz").await;
        assert!(ok.contains("Box подключён"));
        assert_eq!(waiter.await.unwrap().unwrap(), "THECODE");
    }

    #[tokio::test]
    async fn reports_denial() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiter = tokio::spawn(async move { wait_for_code(listener, "s", Duration::from_secs(5)).await });
        get(port, "/callback?error=access_denied&state=s").await;
        assert!(matches!(waiter.await.unwrap(), Err(OAuthError::Denied(r)) if r == "access_denied"));
    }

    #[tokio::test]
    async fn times_out() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        assert!(matches!(wait_for_code(listener, "s", Duration::from_millis(50)).await, Err(OAuthError::Timeout)));
    }
}
