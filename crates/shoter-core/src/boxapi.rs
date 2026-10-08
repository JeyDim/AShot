//! Minimal Box.com API client: authentication, upload, shared links.
//!
//! Docs: <https://developer.box.com/reference/>
//! * upload:      `POST https://upload.box.com/api/2.0/files/content` (multipart, `attributes` before `file`)
//! * shared link: `PUT  https://api.box.com/2.0/files/{id}?fields=shared_link`
//! * tokens:      `POST https://api.box.com/oauth2/token`

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use reqwest::multipart::{Form, Part};
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum BoxError {
    #[error("Box не настроен: {0}")]
    NotConfigured(String),
    #[error("сетевая ошибка: {0}")]
    Network(#[from] reqwest::Error),
    #[error("ошибка авторизации Box: {0}")]
    Auth(String),
    #[error("Box API вернул ошибку {status}: {message}")]
    Api { status: u16, code: String, message: String },
    #[error("неожиданный ответ Box: {0}")]
    Unexpected(String),
}

pub type Result<T> = std::result::Result<T, BoxError>;

#[derive(Debug, Clone)]
pub struct Endpoints {
    pub api: String,
    pub upload: String,
    pub token: String,
    pub authorize: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            api: "https://api.box.com/2.0".into(),
            upload: "https://upload.box.com/api/2.0".into(),
            token: "https://api.box.com/oauth2/token".into(),
            authorize: "https://account.box.com/api/oauth2/authorize".into(),
        }
    }
}

/// Persisted OAuth tokens. Box refresh tokens are single-use (rotated on every refresh),
/// so the caller MUST persist the new pair every time [`TokenSink::save`] is called.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds.
    pub expires_at: i64,
}

pub trait TokenSink: Send + Sync {
    fn save(&self, tokens: &OAuthTokens);
}

#[derive(Debug, Clone)]
pub enum Credentials {
    DeveloperToken(String),
    ClientCredentials {
        client_id: String,
        client_secret: String,
        /// "enterprise" or "user"
        subject_type: String,
        subject_id: String,
    },
    OAuth {
        client_id: String,
        client_secret: String,
        tokens: OAuthTokens,
    },
}

#[derive(Debug, Clone)]
struct CachedToken {
    token: String,
    expires_at: i64,
}

pub struct BoxClient {
    http: Client,
    endpoints: Endpoints,
    credentials: Mutex<Credentials>,
    cached: Mutex<Option<CachedToken>>,
    sink: Option<Arc<dyn TokenSink>>,
    /// (parent id, folder name) → folder id, resolved once per client.
    folders: Mutex<std::collections::HashMap<(String, String), String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BoxUser {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub login: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BoxFile {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedLink {
    pub url: String,
    pub download_url: Option<String>,
    pub access: Option<String>,
    pub effective_access: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub file_id: String,
    pub file_name: String,
    pub shared_link: SharedLink,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    error: String,
    #[serde(default)]
    error_description: String,
}

#[derive(Deserialize)]
struct UploadResponse {
    entries: Vec<BoxFile>,
}

#[derive(Deserialize)]
struct SharedLinkRaw {
    url: String,
    #[serde(default)]
    download_url: Option<String>,
    #[serde(default)]
    access: Option<String>,
    #[serde(default)]
    effective_access: Option<String>,
}

#[derive(Deserialize)]
struct FileWithLink {
    shared_link: Option<SharedLinkRaw>,
}

pub fn http_client() -> Client {
    Client::builder()
        .user_agent(concat!("AShot/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .expect("failed to build HTTP client")
}

/// URL the user opens to grant access (OAuth 2.0 authorization code flow).
/// Without `redirect_uri` Box sends the user to the redirect URI configured for the app
/// (works when the app has exactly one).
pub fn authorize_url(endpoints: &Endpoints, client_id: &str, redirect_uri: Option<&str>, state: &str) -> String {
    let mut url = url::Url::parse(&endpoints.authorize).expect("valid authorize endpoint");
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code").append_pair("client_id", client_id);
        if let Some(r) = redirect_uri {
            q.append_pair("redirect_uri", r);
        }
        q.append_pair("state", state);
    }
    url.to_string()
}

/// Exchanges the authorization code for tokens.
pub async fn exchange_code(
    http: &Client,
    endpoints: &Endpoints,
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: Option<&str>,
) -> Result<OAuthTokens> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ];
    // Same redirect URI as in the authorization request (OAuth 2.0 §4.1.3), if any.
    if let Some(r) = redirect_uri {
        form.push(("redirect_uri", r));
    }
    let resp = http.post(&endpoints.token).form(&form).send().await?;
    let token: TokenResponse = parse_token_response(resp).await?;
    Ok(OAuthTokens {
        expires_at: Utc::now().timestamp() + token.expires_in.unwrap_or(3600),
        refresh_token: token
            .refresh_token
            .ok_or_else(|| BoxError::Auth("Box не вернул refresh token".into()))?,
        access_token: token.access_token,
    })
}

async fn parse_token_response(resp: Response) -> Result<TokenResponse> {
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        let msg = serde_json::from_str::<ApiErrorBody>(&text)
            .map(|b| {
                if b.error_description.is_empty() { b.error } else { format!("{} ({})", b.error_description, b.error) }
            })
            .unwrap_or_else(|_| text.clone());
        return Err(BoxError::Auth(format!("HTTP {}: {msg}", status.as_u16())));
    }
    serde_json::from_str(&text).map_err(|e| BoxError::Unexpected(format!("token response: {e}")))
}

async fn api_error(resp: Response) -> BoxError {
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    match serde_json::from_str::<ApiErrorBody>(&text) {
        Ok(b) => BoxError::Api { status, code: b.code, message: if b.message.is_empty() { text } else { b.message } },
        Err(_) => BoxError::Api { status, code: String::new(), message: text },
    }
}

impl BoxClient {
    pub fn new(http: Client, endpoints: Endpoints, credentials: Credentials, sink: Option<Arc<dyn TokenSink>>) -> Self {
        Self {
            http,
            endpoints,
            credentials: Mutex::new(credentials),
            cached: Mutex::new(None),
            sink,
            folders: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// Returns a valid access token, refreshing it when needed. Serialised by a mutex so
    /// concurrent uploads never use the same (single-use) refresh token twice.
    pub async fn access_token(&self) -> Result<String> {
        let mut cached = self.cached.lock().await;
        let now = Utc::now().timestamp();
        if let Some(c) = cached.as_ref() {
            if c.expires_at - 60 > now {
                return Ok(c.token.clone());
            }
        }
        let mut creds = self.credentials.lock().await;
        let fresh = match &mut *creds {
            Credentials::DeveloperToken(token) => {
                if token.trim().is_empty() {
                    return Err(BoxError::NotConfigured("не задан developer token".into()));
                }
                CachedToken { token: token.trim().to_string(), expires_at: i64::MAX }
            }
            Credentials::ClientCredentials { client_id, client_secret, subject_type, subject_id } => {
                if client_id.is_empty() || client_secret.is_empty() || subject_id.is_empty() {
                    return Err(BoxError::NotConfigured("для Client Credentials нужны Client ID, Client Secret и Enterprise ID/User ID".into()));
                }
                let resp = self
                    .http
                    .post(&self.endpoints.token)
                    .form(&[
                        ("grant_type", "client_credentials"),
                        ("client_id", client_id.as_str()),
                        ("client_secret", client_secret.as_str()),
                        ("box_subject_type", subject_type.as_str()),
                        ("box_subject_id", subject_id.as_str()),
                    ])
                    .send()
                    .await?;
                let t = parse_token_response(resp).await?;
                CachedToken { token: t.access_token, expires_at: now + t.expires_in.unwrap_or(3600) }
            }
            Credentials::OAuth { client_id, client_secret, tokens } => {
                if tokens.refresh_token.is_empty() && tokens.access_token.is_empty() {
                    return Err(BoxError::NotConfigured("выполните вход в Box в настройках".into()));
                }
                if !tokens.access_token.is_empty() && tokens.expires_at - 60 > now {
                    CachedToken { token: tokens.access_token.clone(), expires_at: tokens.expires_at }
                } else {
                    let resp = self
                        .http
                        .post(&self.endpoints.token)
                        .form(&[
                            ("grant_type", "refresh_token"),
                            ("refresh_token", tokens.refresh_token.as_str()),
                            ("client_id", client_id.as_str()),
                            ("client_secret", client_secret.as_str()),
                        ])
                        .send()
                        .await?;
                    let t = parse_token_response(resp).await?;
                    tokens.access_token = t.access_token.clone();
                    if let Some(r) = t.refresh_token {
                        tokens.refresh_token = r;
                    }
                    tokens.expires_at = now + t.expires_in.unwrap_or(3600);
                    if let Some(sink) = &self.sink {
                        sink.save(tokens);
                    }
                    CachedToken { token: t.access_token, expires_at: tokens.expires_at }
                }
            }
        };
        *cached = Some(fresh.clone());
        Ok(fresh.token)
    }

    async fn invalidate_token(&self) {
        *self.cached.lock().await = None;
        if let Credentials::OAuth { tokens, .. } = &mut *self.credentials.lock().await {
            tokens.expires_at = 0;
        }
    }

    /// Sends a request built by `build` with a bearer token; on 401 refreshes the token once and retries.
    async fn send_authorized<F>(&self, build: F) -> Result<Response>
    where
        F: Fn(&str) -> reqwest::RequestBuilder,
    {
        let token = self.access_token().await?;
        let resp = build(&token).send().await?;
        if resp.status() != StatusCode::UNAUTHORIZED {
            return Ok(resp);
        }
        self.invalidate_token().await;
        let token = self.access_token().await?;
        Ok(build(&token).send().await?)
    }

    pub async fn current_user(&self) -> Result<BoxUser> {
        let url = format!("{}/users/me?fields=id,name,login", self.endpoints.api);
        let resp = self.send_authorized(|t| self.http.get(&url).bearer_auth(t)).await?;
        if !resp.status().is_success() {
            return Err(api_error(resp).await);
        }
        resp.json().await.map_err(Into::into)
    }

    /// Uploads a new file. On a name conflict (409) retries with a numbered name.
    pub async fn upload(&self, folder_id: &str, file_name: &str, bytes: Vec<u8>, mime: &str) -> Result<BoxFile> {
        let url = format!("{}/files/content?fields=id,name,size", self.endpoints.upload);
        let mut name = file_name.to_string();
        for attempt in 0..3 {
            let attributes = serde_json::json!({ "name": name, "parent": { "id": folder_id } }).to_string();
            let resp = self
                .send_authorized(|t| {
                    let part = Part::bytes(bytes.clone()).file_name(name.clone()).mime_str(mime).expect("valid mime");
                    // Box requires `attributes` to come before `file`.
                    let form = Form::new().text("attributes", attributes.clone()).part("file", part);
                    self.http.post(&url).bearer_auth(t).multipart(form)
                })
                .await?;
            if resp.status() == StatusCode::CONFLICT && attempt < 2 {
                let (stem, ext) = name.rsplit_once('.').map(|(s, e)| (s.to_string(), format!(".{e}"))).unwrap_or((name.clone(), String::new()));
                name = format!("{stem}-{}{ext}", crate::random_string(4));
                continue;
            }
            if !resp.status().is_success() {
                return Err(api_error(resp).await);
            }
            let body: UploadResponse = resp.json().await?;
            return body.entries.into_iter().next().ok_or_else(|| BoxError::Unexpected("пустой ответ на загрузку".into()));
        }
        unreachable!("loop always returns")
    }

    /// Creates (or updates) the shared link of a file. When the enterprise forbids the
    /// requested access level (typically "open"), falls back to the enterprise default;
    /// the returned `effective_access` tells the caller what was actually applied.
    pub async fn create_shared_link(&self, file_id: &str, access: &str) -> Result<SharedLink> {
        match self.put_shared_link(file_id, Some(access)).await {
            Err(BoxError::Api { status: 400 | 403, .. }) if !access.is_empty() => self.put_shared_link(file_id, None).await,
            other => other,
        }
    }

    async fn put_shared_link(&self, file_id: &str, access: Option<&str>) -> Result<SharedLink> {
        let url = format!("{}/files/{}?fields=shared_link", self.endpoints.api, file_id);
        let body = match access {
            Some(a) => serde_json::json!({ "shared_link": { "access": a } }),
            None => serde_json::json!({ "shared_link": {} }),
        };
        let resp = self.send_authorized(|t| self.http.put(&url).bearer_auth(t).json(&body)).await?;
        if !resp.status().is_success() {
            return Err(api_error(resp).await);
        }
        let file: FileWithLink = resp.json().await?;
        let raw = file.shared_link.ok_or_else(|| BoxError::Unexpected("Box не вернул shared_link".into()))?;
        Ok(SharedLink { url: raw.url, download_url: raw.download_url, access: raw.access, effective_access: raw.effective_access })
    }

    pub async fn upload_and_share(&self, folder_id: &str, file_name: &str, bytes: Vec<u8>, mime: &str, access: &str) -> Result<UploadResult> {
        let file = self.upload(folder_id, file_name, bytes, mime).await?;
        let shared_link = self.create_shared_link(&file.id, access).await?;
        Ok(UploadResult { file_id: file.id, file_name: file.name, shared_link })
    }

    /// Id of the folder `name` inside `parent_id`, creating it when it does not exist.
    pub async fn ensure_folder(&self, parent_id: &str, name: &str) -> Result<String> {
        let key = (parent_id.to_string(), name.to_string());
        if let Some(id) = self.folders.lock().await.get(&key) {
            return Ok(id.clone());
        }
        let url = format!("{}/folders?fields=id,name", self.endpoints.api);
        let body = serde_json::json!({ "name": name, "parent": { "id": parent_id } });
        let resp = self.send_authorized(|t| self.http.post(&url).bearer_auth(t).json(&body)).await?;
        let status = resp.status();
        let id = if status.is_success() {
            let v: serde_json::Value = resp.json().await?;
            v["id"].as_str().map(str::to_string)
        } else if status == StatusCode::CONFLICT {
            // Already exists: Box returns the existing item in context_info.conflicts
            // (an array for folders, an object in some responses).
            let v: serde_json::Value = resp.json().await.unwrap_or_default();
            let conflicts = &v["context_info"]["conflicts"];
            let item = if conflicts.is_array() { &conflicts[0] } else { conflicts };
            match (item["type"].as_str(), item["id"].as_str()) {
                (Some("folder") | None, Some(id)) => Some(id.to_string()),
                // A *file* with that name is in the way – fall back to the parent folder.
                _ => Some(parent_id.to_string()),
            }
        } else {
            return Err(api_error(resp).await);
        };
        let id = id.ok_or_else(|| BoxError::Unexpected("Box не вернул id папки".into()))?;
        self.folders.lock().await.insert(key, id.clone());
        Ok(id)
    }

    pub async fn delete_file(&self, file_id: &str) -> Result<()> {
        let url = format!("{}/files/{}", self.endpoints.api, file_id);
        let resp = self.send_authorized(|t| self.http.delete(&url).bearer_auth(t)).await?;
        if resp.status().is_success() || resp.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(api_error(resp).await)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use wiremock::matchers::{body_string_contains, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn endpoints(server: &MockServer) -> Endpoints {
        Endpoints {
            api: format!("{}/2.0", server.uri()),
            upload: format!("{}/upload/2.0", server.uri()),
            token: format!("{}/oauth2/token", server.uri()),
            authorize: format!("{}/authorize", server.uri()),
        }
    }

    #[derive(Default)]
    struct Sink(StdMutex<Vec<OAuthTokens>>);
    impl TokenSink for Sink {
        fn save(&self, tokens: &OAuthTokens) {
            self.0.lock().unwrap().push(tokens.clone());
        }
    }

    #[tokio::test]
    async fn upload_and_share_with_developer_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/upload/2.0/files/content"))
            .and(header("authorization", "Bearer DEV"))
            .and(body_string_contains("name=\"attributes\""))
            .and(body_string_contains("\"parent\":{\"id\":\"42\"}"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "total_count": 1,
                "entries": [{ "id": "777", "name": "shot.png", "size": 3 }]
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/2.0/files/777"))
            .and(body_string_contains("\"access\":\"open\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "777",
                "shared_link": {
                    "url": "https://app.box.com/s/3rud4dfakga5r953wt77anhyzo27tm7r",
                    "download_url": "https://app.box.com/shared/static/3rud4dfakga5r953wt77anhyzo27tm7r.png",
                    "access": "open",
                    "effective_access": "open"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let client = BoxClient::new(http_client(), endpoints(&server), Credentials::DeveloperToken("DEV".into()), None);
        let res = client.upload_and_share("42", "shot.png", vec![1, 2, 3], "image/png", "open").await.unwrap();
        assert_eq!(res.file_id, "777");
        assert_eq!(res.shared_link.url, "https://app.box.com/s/3rud4dfakga5r953wt77anhyzo27tm7r");
        assert_eq!(
            crate::links::rewrite(&res.shared_link.url, "https://advant.one/{id}", Some(&res.file_name)),
            "https://advant.one/3rud4dfakga5r953wt77anhyzo27tm7r"
        );
    }

    #[tokio::test]
    async fn oauth_refresh_rotates_and_persists_tokens() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth2/token"))
            .and(body_string_contains("grant_type=refresh_token"))
            .and(body_string_contains("refresh_token=OLD"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "NEWACCESS", "refresh_token": "NEWREFRESH", "expires_in": 3600, "token_type": "bearer"
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/2.0/users/me"))
            .and(header("authorization", "Bearer NEWACCESS"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": "1", "name": "Иван", "login": "ivan@advant.one" })))
            .mount(&server)
            .await;

        let sink = Arc::new(Sink::default());
        let client = BoxClient::new(
            http_client(),
            endpoints(&server),
            Credentials::OAuth {
                client_id: "cid".into(),
                client_secret: "secret".into(),
                tokens: OAuthTokens { access_token: String::new(), refresh_token: "OLD".into(), expires_at: 0 },
            },
            Some(sink.clone()),
        );
        let user = client.current_user().await.unwrap();
        assert_eq!(user.login, "ivan@advant.one");
        // second call uses the cached token (token endpoint expected exactly once)
        client.current_user().await.unwrap();
        let saved = sink.0.lock().unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].refresh_token, "NEWREFRESH");
    }

    #[tokio::test]
    async fn client_credentials_and_retry_on_401() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth2/token"))
            .and(body_string_contains("grant_type=client_credentials"))
            .and(body_string_contains("box_subject_type=enterprise"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "access_token": "CCG", "expires_in": 3600 })))
            .expect(2)
            .mount(&server)
            .await;
        // first call is rejected → client must fetch a new token and retry
        Mock::given(method("GET"))
            .and(path("/2.0/users/me"))
            .respond_with(ResponseTemplate::new(401))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/2.0/users/me"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": "2" })))
            .mount(&server)
            .await;
        let client = BoxClient::new(
            http_client(),
            endpoints(&server),
            Credentials::ClientCredentials {
                client_id: "cid".into(),
                client_secret: "s".into(),
                subject_type: "enterprise".into(),
                subject_id: "123".into(),
            },
            None,
        );
        assert_eq!(client.current_user().await.unwrap().id, "2");
    }

    #[tokio::test]
    async fn upload_conflict_renames() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/upload/2.0/files/content"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({ "code": "item_name_in_use", "message": "exists" })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/upload/2.0/files/content"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "entries": [{ "id": "9", "name": "shot-abcd.png" }] })))
            .mount(&server)
            .await;
        let client = BoxClient::new(http_client(), endpoints(&server), Credentials::DeveloperToken("T".into()), None);
        let f = client.upload("0", "shot.png", vec![0], "image/png").await.unwrap();
        assert_eq!(f.id, "9");
    }

    #[tokio::test]
    async fn falls_back_when_open_links_are_forbidden() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(body_string_contains("\"access\":\"open\""))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({ "code": "bad_request", "message": "open shared links are disabled" })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(body_string_contains("\"shared_link\":{}"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "shared_link": { "url": "https://app.box.com/s/abc", "access": "company", "effective_access": "company" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = BoxClient::new(http_client(), endpoints(&server), Credentials::DeveloperToken("T".into()), None);
        let link = client.create_shared_link("1", "open").await.unwrap();
        assert_eq!(link.effective_access.as_deref(), Some("company"));
    }

    #[tokio::test]
    async fn api_errors_are_reported() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({ "code": "not_found", "message": "Not Found" })))
            .mount(&server)
            .await;
        let client = BoxClient::new(http_client(), endpoints(&server), Credentials::DeveloperToken("T".into()), None);
        match client.create_shared_link("1", "open").await {
            Err(BoxError::Api { status, code, .. }) => {
                assert_eq!(status, 404);
                assert_eq!(code, "not_found");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn ensures_folder_once() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/2.0/folders"))
            .and(body_string_contains("\"name\":\"AShot\""))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": "555", "name": "AShot" })))
            .expect(1)
            .mount(&server)
            .await;
        let client = BoxClient::new(http_client(), endpoints(&server), Credentials::DeveloperToken("T".into()), None);
        assert_eq!(client.ensure_folder("0", "AShot").await.unwrap(), "555");
        // cached – no second request
        assert_eq!(client.ensure_folder("0", "AShot").await.unwrap(), "555");
    }

    #[tokio::test]
    async fn existing_folder_is_reused() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/2.0/folders"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "code": "item_name_in_use",
                "context_info": { "conflicts": [{ "type": "folder", "id": "777", "name": "AShot" }] }
            })))
            .mount(&server)
            .await;
        let client = BoxClient::new(http_client(), endpoints(&server), Credentials::DeveloperToken("T".into()), None);
        assert_eq!(client.ensure_folder("0", "AShot").await.unwrap(), "777");
    }

    #[test]
    fn missing_configuration() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let client = BoxClient::new(http_client(), Endpoints::default(), Credentials::DeveloperToken(" ".into()), None);
        assert!(matches!(rt.block_on(client.access_token()), Err(BoxError::NotConfigured(_))));
    }

    #[test]
    fn builds_authorize_url() {
        let url = authorize_url(&Endpoints::default(), "cid", Some("http://localhost:47615/callback"), "st");
        assert!(url.starts_with("https://account.box.com/api/oauth2/authorize?"));
        assert!(url.contains("client_id=cid"));
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A47615%2Fcallback"));

        // No redirect URI: Box uses the one configured for the app.
        let url = authorize_url(&Endpoints::default(), "cid", None, "st");
        assert!(!url.contains("redirect_uri"));
        assert!(url.ends_with("state=st"));
    }
}
