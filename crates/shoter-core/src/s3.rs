//! Minimal S3 client for any S3-compatible storage (Yandex Object Storage by default):
//! puts a screenshot under a random id, signed with AWS Signature Version 4.
//!
//! Docs: <https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html>,
//! <https://yandex.cloud/ru/docs/storage/s3/>
//! * upload: `PUT {endpoint}/{bucket}/{prefix}{id}` (path-style: bucket names with dots work too)
//!
//! The object key has no extension: the link proxy serves `/{id}` (and `/{id}.png`) by it, and
//! the stored `Content-Type` tells what it is.

use chrono::{DateTime, Utc};
use reqwest::Client;
use sha2::{Digest, Sha256};

use crate::hex;

pub const DEFAULT_ENDPOINT: &str = "https://storage.yandexcloud.net";
pub const DEFAULT_REGION: &str = "ru-central1";
/// Length of the id of an uploaded screenshot: 16 letters of a 32-letter alphabet, 80 random
/// bits — the link is the only thing that protects the picture from being found.
pub const ID_LEN: usize = 16;

#[derive(Debug, thiserror::Error)]
pub enum S3Error {
    #[error("хранилище не настроено: {0}")]
    NotConfigured(String),
    #[error("сетевая ошибка: {0}")]
    Network(#[from] reqwest::Error),
    #[error("хранилище вернуло ошибку {status}: {}", hint(code, message))]
    Api { status: u16, code: String, message: String },
}

pub type Result<T> = std::result::Result<T, S3Error>;

/// Readable reason for the usual S3 error codes.
fn hint(code: &str, message: &str) -> String {
    let reason = match code {
        "InvalidAccessKeyId" => "ключ доступа не найден",
        "SignatureDoesNotMatch" => "неверный секретный ключ",
        "AuthorizationHeaderMalformed" => "неверный регион",
        "AccessDenied" => "нет прав на запись в бакет",
        "NoSuchBucket" => "бакет не найден",
        "RequestTimeTooSkewed" => "часы компьютера расходятся с точным временем",
        "EntityTooLarge" => "файл слишком большой",
        _ if !message.is_empty() => message,
        _ => "без описания",
    };
    if code.is_empty() { reason.to_string() } else { format!("{reason} ({code})") }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct S3Config {
    /// `https://storage.yandexcloud.net`.
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    /// Folder in the bucket: empty or ending with `/`.
    pub prefix: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

impl S3Config {
    /// Path-style URL of an object (opens only when the bucket allows public reads).
    pub fn object_url(&self, key: &str) -> String {
        format!("{}/{}/{}", self.endpoint.trim().trim_end_matches('/'), self.bucket, encode_path(key))
    }

    /// Link template of the direct object URL (`…/{bucket}/{prefix}{id}`): the links without a
    /// proxy domain.
    pub fn link_template(&self) -> String {
        format!("{}{{id}}", self.object_url(&self.prefix))
    }
}

/// Normalises a folder in the bucket: no leading `/`, a trailing one (`shots` → `shots/`).
pub fn normalize_prefix(prefix: &str) -> String {
    let p = prefix.trim().trim_matches('/');
    if p.is_empty() { String::new() } else { format!("{p}/") }
}

/// A screenshot put into the bucket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Uploaded {
    /// Random id: the `{id}` of the link template.
    pub id: String,
    /// Object key: `{prefix}{id}`.
    pub key: String,
    /// Direct (path-style) URL of the object.
    pub url: String,
}

/// Uploads a screenshot under a new random id. `file_name` is what a browser offers when the
/// picture is saved (the `Content-Disposition` of the object).
pub async fn upload(http: &Client, config: &S3Config, file_name: &str, bytes: Vec<u8>, mime: &str) -> Result<Uploaded> {
    let id = crate::random_id(ID_LEN);
    let key = format!("{}{id}", config.prefix);
    let disposition = format!("inline; filename*=UTF-8''{}", crate::links::encode_component(file_name));
    put_object(http, config, &key, bytes, mime, &disposition, Utc::now()).await?;
    Ok(Uploaded { url: config.object_url(&key), id, key })
}

/// Checks the settings by writing a tiny object (`{prefix}ashot-check.txt`): the key of AShot
/// may only write, so nothing can be read back.
pub async fn check(http: &Client, config: &S3Config) -> Result<()> {
    let key = format!("{}ashot-check.txt", config.prefix);
    let body = b"AShot: connection check".to_vec();
    put_object(http, config, &key, body, "text/plain; charset=utf-8", "inline", Utc::now()).await
}

async fn put_object(http: &Client, config: &S3Config, key: &str, bytes: Vec<u8>, mime: &str, disposition: &str, now: DateTime<Utc>) -> Result<()> {
    for (value, what) in [(&config.bucket, "бакет"), (&config.access_key_id, "ключ доступа"), (&config.secret_access_key, "секретный ключ")] {
        if value.trim().is_empty() {
            return Err(S3Error::NotConfigured(format!("не указан {what}")));
        }
    }
    let url: url::Url = config
        .object_url(key)
        .parse()
        .map_err(|e| S3Error::NotConfigured(format!("некорректный адрес хранилища: {e}")))?;
    let host = match (url.host_str(), url.port()) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h.to_string(),
        _ => return Err(S3Error::NotConfigured("в адресе хранилища нет домена".into())),
    };
    let payload_hash = hex(&Sha256::digest(&bytes));
    // Sorted by name: the order of the canonical request.
    let headers = [
        ("content-disposition", disposition.to_string()),
        ("content-type", mime.to_string()),
        ("host", host),
        ("x-amz-content-sha256", payload_hash.clone()),
        ("x-amz-date", now.format("%Y%m%dT%H%M%SZ").to_string()),
    ];
    let authorization = authorization(config, "PUT", url.path(), "", &headers, &payload_hash, now);
    let mut request = http.put(url).header("authorization", authorization).body(bytes);
    for (name, value) in headers.iter().filter(|(n, _)| *n != "host") {
        request = request.header(*name, value);
    }
    let response = request.send().await?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let tag = |name: &str| {
        let open = format!("<{name}>");
        body.split_once(&open)
            .and_then(|(_, rest)| rest.split_once(&format!("</{name}>")))
            .map(|(v, _)| v.trim().to_string())
            .unwrap_or_default()
    };
    Err(S3Error::Api { status, code: tag("Code"), message: tag("Message") })
}

/// The `Authorization` header of AWS Signature Version 4. `headers` — lowercase names, sorted.
fn authorization(
    config: &S3Config,
    method: &str,
    canonical_uri: &str,
    canonical_query: &str,
    headers: &[(&str, String)],
    payload_hash: &str,
    now: DateTime<Utc>,
) -> String {
    let date = now.format("%Y%m%d").to_string();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let region = config.region.trim();
    let signed_headers = headers.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(";");
    let canonical_headers: String = headers.iter().map(|(n, v)| format!("{n}:{}\n", v.trim())).collect();
    let canonical_request = format!("{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let scope = format!("{date}/{region}/s3/aws4_request");
    let string_to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", hex(&Sha256::digest(canonical_request.as_bytes())));
    let mut key = hmac(format!("AWS4{}", config.secret_access_key.trim()).as_bytes(), date.as_bytes());
    for part in [region, "s3", "aws4_request"] {
        key = hmac(&key, part.as_bytes());
    }
    let signature = hex(&hmac(&key, string_to_sign.as_bytes()));
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        config.access_key_id.trim()
    )
}

/// HMAC-SHA256 (RFC 2104).
fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.map(|b| b ^ 0x36));
    inner.update(data);
    let mut outer = Sha256::new();
    outer.update(k.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    let mut out = [0u8; 32];
    out.copy_from_slice(&outer.finalize());
    out
}

/// URI-encodes an object key for the request path and its signature: everything except the
/// unreserved characters and `/`.
fn encode_path(key: &str) -> String {
    key.split('/').map(crate::links::encode_component).collect::<Vec<_>>().join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path_regex};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    #[test]
    fn hmac_rfc4231() {
        // Test case 2 of RFC 4231.
        assert_eq!(
            hex(&hmac(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // A key longer than the block is hashed first (test case 6).
        assert_eq!(
            hex(&hmac(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First")),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn signature_v4_example_from_aws_docs() {
        // "Example: GET Object" of the S3 Signature Version 4 documentation.
        let config = S3Config {
            region: "us-east-1".into(),
            access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            ..Default::default()
        };
        let empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let now = DateTime::parse_from_rfc3339("2013-05-24T00:00:00Z").unwrap().with_timezone(&Utc);
        let headers = [
            ("host", "examplebucket.s3.amazonaws.com".to_string()),
            ("range", "bytes=0-9".to_string()),
            ("x-amz-content-sha256", empty.to_string()),
            ("x-amz-date", "20130524T000000Z".to_string()),
        ];
        assert_eq!(
            authorization(&config, "GET", "/test.txt", "", &headers, empty, now),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn keys_and_urls() {
        assert_eq!(normalize_prefix(" /shots/ "), "shots/");
        assert_eq!(normalize_prefix("a/b"), "a/b/");
        assert_eq!(normalize_prefix("/"), "");
        let config = S3Config { endpoint: "https://storage.yandexcloud.net/".into(), bucket: "ashot".into(), ..Default::default() };
        assert_eq!(config.object_url("shots/abc"), "https://storage.yandexcloud.net/ashot/shots/abc");
        assert_eq!(config.object_url("снимки/a b"), "https://storage.yandexcloud.net/ashot/%D1%81%D0%BD%D0%B8%D0%BC%D0%BA%D0%B8/a%20b");
        assert_eq!(config.link_template(), "https://storage.yandexcloud.net/ashot/{id}");
        let config = S3Config { prefix: "shots/".into(), ..config };
        assert_eq!(config.link_template(), "https://storage.yandexcloud.net/ashot/shots/{id}");
    }

    fn config(server: &MockServer) -> S3Config {
        S3Config {
            endpoint: server.uri(),
            region: DEFAULT_REGION.into(),
            bucket: "ashot".into(),
            prefix: "shots/".into(),
            access_key_id: "YCAJEexample".into(),
            secret_access_key: "secret".into(),
        }
    }

    #[tokio::test]
    async fn uploads_signed_put() {
        let server = MockServer::start().await;
        let body = b"png bytes".to_vec();
        Mock::given(method("PUT"))
            .and(path_regex(r"^/ashot/shots/[a-z2-9]{16}$"))
            .and(header("content-type", "image/png"))
            .and(header("x-amz-content-sha256", hex(&Sha256::digest(&body)).as_str()))
            .and(header("content-disposition", "inline; filename*=UTF-8''%D0%A1%D0%BD%D0%B8%D0%BC%D0%BE%D0%BA%201.png"))
            .and(|r: &Request| {
                let auth = r.headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or_default();
                auth.starts_with("AWS4-HMAC-SHA256 Credential=YCAJEexample/")
                    && auth.contains("/ru-central1/s3/aws4_request, SignedHeaders=content-disposition;content-type;host;x-amz-content-sha256;x-amz-date, Signature=")
            })
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        let http = crate::boxapi::http_client();
        let up = upload(&http, &config(&server), "Снимок 1.png", body, "image/png").await.unwrap();
        assert_eq!(up.id.len(), ID_LEN);
        assert_eq!(up.key, format!("shots/{}", up.id));
        assert_eq!(up.url, format!("{}/ashot/shots/{}", server.uri(), up.id));
    }

    #[tokio::test]
    async fn readable_errors() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(403).set_body_string(
                "<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>",
            ))
            .mount(&server)
            .await;
        let err = check(&crate::boxapi::http_client(), &config(&server)).await.unwrap_err();
        assert!(matches!(&err, S3Error::Api { status: 403, code, .. } if code == "AccessDenied"));
        assert_eq!(err.to_string(), "хранилище вернуло ошибку 403: нет прав на запись в бакет (AccessDenied)");

        let mut empty = config(&server);
        empty.secret_access_key.clear();
        let err = check(&crate::boxapi::http_client(), &empty).await.unwrap_err();
        assert_eq!(err.to_string(), "хранилище не настроено: не указан секретный ключ");
    }
}
