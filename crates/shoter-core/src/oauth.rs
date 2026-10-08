//! OAuth 2.0 redirect handling.
//!
//! Two ways to receive the authorization code, depending on the redirect URI
//! registered for the Box app:
//! * loopback (`http://localhost:<port>/...`): the system browser is redirected to a tiny
//!   local HTTP server ([`bind`] + [`wait_for_code`]);
//! * anything else (e.g. `https://example.com/authorize/box`, like Greenshot uses): the
//!   app shows the Box page in its own window and intercepts the navigation to the
//!   redirect URI ([`is_redirect`] + [`code_from_redirect`]) — the URL never has to exist.

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
    #[error("ответ на вход не прошёл проверку (state)")]
    StateMismatch,
}

/// Port of a loopback redirect URI (`http://localhost:47615/callback` → 47615).
pub fn loopback_port(redirect_uri: &str) -> Option<u16> {
    let url = url::Url::parse(redirect_uri).ok()?;
    let host = url.host_str()?;
    if url.scheme() != "http" || !(host == "localhost" || host == "127.0.0.1") {
        return None;
    }
    url.port_or_known_default()
}

/// Whether `url` points at the redirect URI (same scheme, host, port and path; the query is ignored).
pub fn is_redirect(url: &str, redirect_uri: &str) -> bool {
    let (Ok(a), Ok(b)) = (url::Url::parse(url), url::Url::parse(redirect_uri)) else { return false };
    a.scheme() == b.scheme()
        && a.host_str().map(str::to_ascii_lowercase) == b.host_str().map(str::to_ascii_lowercase)
        && a.port_or_known_default() == b.port_or_known_default()
        && a.path().trim_end_matches('/') == b.path().trim_end_matches('/')
}

/// Authorization code from the redirect URL (`...?code=XYZ&state=...`).
pub fn code_from_redirect(url: &str, expected_state: &str) -> Result<String, OAuthError> {
    let url = url::Url::parse(url).map_err(|_| OAuthError::Denied("некорректный адрес возврата".into()))?;
    let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.to_string());
    if let Some(err) = param("error") {
        return Err(OAuthError::Denied(param("error_description").unwrap_or(err)));
    }
    if param("state").as_deref() != Some(expected_state) {
        return Err(OAuthError::StateMismatch);
    }
    param("code").ok_or_else(|| OAuthError::Denied("Box не вернул код авторизации".into()))
}

const SUCCESS_PAGE: &str = r#"<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>AShot</title>
<style>body{font:16px system-ui,Segoe UI,sans-serif;background:#121214;color:#f2f2f3;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#1e1e20;border:1px solid #2a2a2d;border-radius:16px;padding:32px 40px;text-align:center}
h1{font-size:20px;font-weight:500;margin:0 0 8px}p{color:#9a9a9f;margin:0}</style></head>
<body><div class="card"><h1>✅ Box подключён</h1><p>Можно закрыть эту вкладку и вернуться в AShot.</p></div></body></html>"#;

const ERROR_PAGE: &str = r#"<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>AShot</title></head>
<body style="font:16px system-ui;background:#121214;color:#f2f2f3;display:grid;place-items:center;height:100vh;margin:0">
<div>Вход не выполнен. Вернитесь в AShot и попробуйте ещё раз.</div></body></html>"#;

/// Binds the loopback listener. Call before opening the browser so the port is ready.
pub async fn bind(port: u16) -> Result<TcpListener, OAuthError> {
    TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| OAuthError::Bind(port, e))
}

/// Waits for the browser redirect and returns the authorization code.
/// Requests with a wrong `state` (or unrelated requests such as `/favicon.ico`) are ignored.
pub async fn wait_for_code(listener: TcpListener, expected_state: &str, path: &str, timeout: Duration) -> Result<String, OAuthError> {
    let accept_loop = async {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { continue };
            match handle(&mut stream, expected_state, path).await {
                Some(result) => return result,
                None => continue,
            }
        }
    };
    tokio::time::timeout(timeout, accept_loop).await.map_err(|_| OAuthError::Timeout)?
}

async fn handle(stream: &mut TcpStream, expected_state: &str, expected_path: &str) -> Option<Result<String, OAuthError>> {
    let mut buf = vec![0u8; 8192];
    let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await.ok()?.ok()?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let target = request.lines().next()?.split_whitespace().nth(1)?.to_string();
    let url = url::Url::parse(&format!("http://localhost{target}")).ok()?;
    if url.path().trim_end_matches('/') != expected_path.trim_end_matches('/') {
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
        let waiter = tokio::spawn(async move { wait_for_code(listener, "xyz", "/callback", Duration::from_secs(5)).await });
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
        let waiter = tokio::spawn(async move { wait_for_code(listener, "s", "/callback", Duration::from_secs(5)).await });
        get(port, "/callback?error=access_denied&state=s").await;
        assert!(matches!(waiter.await.unwrap(), Err(OAuthError::Denied(r)) if r == "access_denied"));
    }

    #[test]
    fn redirect_helpers() {
        assert_eq!(loopback_port("http://localhost:47615/callback"), Some(47615));
        assert_eq!(loopback_port("http://127.0.0.1:9000/"), Some(9000));
        assert_eq!(loopback_port("https://getgreenshot.org/authorize/box"), None);
        assert_eq!(loopback_port("garbage"), None);

        let r = "https://getgreenshot.org/authorize/box";
        assert!(is_redirect("https://getgreenshot.org/authorize/box?code=1&state=s", r));
        assert!(is_redirect("https://GetGreenshot.org/authorize/box/?code=1", r));
        assert!(!is_redirect("https://account.box.com/api/oauth2/authorize?redirect_uri=https://getgreenshot.org/authorize/box", r));
        assert!(!is_redirect("https://getgreenshot.org/other", r));

        assert_eq!(code_from_redirect("https://x.org/cb?code=ABC&state=s1", "s1").unwrap(), "ABC");
        assert!(matches!(code_from_redirect("https://x.org/cb?code=ABC&state=zz", "s1"), Err(OAuthError::StateMismatch)));
        assert!(matches!(code_from_redirect("https://x.org/cb?error=access_denied&state=s1", "s1"), Err(OAuthError::Denied(e)) if e == "access_denied"));
    }

    #[tokio::test]
    async fn times_out() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        assert!(matches!(wait_for_code(listener, "s", "/callback", Duration::from_millis(50)).await, Err(OAuthError::Timeout)));
    }
}
