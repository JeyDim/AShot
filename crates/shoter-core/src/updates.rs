//! Updates from a manifest `latest.json` that CI attaches to every release:
//!
//! ```json
//! { "version": "0.1.17", "notes": "- …", "url": "https://…/releases/tag/v0.1.17",
//!   "files": { "installer": { "url": "AShot_0.1.17_x64-setup.exe", "size": 1, "sha256": "…" },
//!              "portable":  { "url": "…", "size": 1, "sha256": "…" } } }
//! ```
//!
//! The manifest is read from GitHub (`…/releases/latest/download/latest.json`) or from an
//! own server (IIS) that mirrors the releases. File URLs may be absolute or relative to
//! the manifest.

use std::path::Path;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::hex;

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("сеть: {0}")]
    Http(#[from] reqwest::Error),
    #[error("сервер обновлений ответил {0}")]
    Status(u16),
    #[error("обновлений пока нет")]
    NoReleases,
    #[error("некорректный манифест обновления: {0}")]
    BadManifest(String),
    #[error("в обновлении нет файла для этой установки")]
    NoFile,
    #[error("файл скачан не полностью или повреждён")]
    Corrupt,
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    /// Release page ("what's new"); may be empty.
    #[serde(default)]
    pub url: String,
    pub files: Files,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Files {
    pub installer: Option<FileEntry>,
    pub portable: Option<FileEntry>,
    pub msi: Option<FileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    /// Absolute, or relative to the manifest.
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

/// How the running copy was installed, i.e. which file updates it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    /// NSIS installer (an `uninstall.exe` lies next to the exe).
    Installer,
    /// A single exe anywhere: replaced in place.
    Portable,
}

impl Manifest {
    pub fn file(&self, kind: InstallKind) -> Option<&FileEntry> {
        match kind {
            InstallKind::Installer => self.files.installer.as_ref(),
            InstallKind::Portable => self.files.portable.as_ref(),
        }
    }
}

/// Manifest address for a configured update source: a `….json` URL is used as is,
/// anything else is a folder that contains `latest.json`.
pub fn manifest_url(source: &str) -> Option<String> {
    let source = source.trim();
    if source.is_empty() {
        return None;
    }
    if source.to_ascii_lowercase().ends_with(".json") {
        return Some(source.to_string());
    }
    Some(format!("{}/latest.json", source.trim_end_matches('/')))
}

/// Manifest of the latest GitHub release of `repo` (`owner/name`). The download URL is not
/// rate-limited like the GitHub API (60 requests/hour per IP without a token).
pub fn github_manifest_url(repo: &str) -> String {
    format!("https://github.com/{repo}/releases/latest/download/latest.json")
}

/// `"v0.1.57"` / `"0.1.57"` → `(0, 1, 57)`; pre-release suffixes are ignored.
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let core = s.trim().trim_start_matches(['v', 'V']).split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let v = (parts.next()??, parts.next().unwrap_or(Some(0))?, parts.next().unwrap_or(Some(0))?);
    parts.next().is_none().then_some(v)
}

/// Whether `candidate` is a newer version than `current`.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

pub async fn fetch_manifest(http: &Client, url: &str) -> Result<Manifest, UpdateError> {
    // `no-cache`: proxies and IIS must not hand out a stale manifest.
    let resp = http.get(url).header("Cache-Control", "no-cache").send().await?;
    match resp.status().as_u16() {
        200 => {}
        404 => return Err(UpdateError::NoReleases),
        code => return Err(UpdateError::Status(code)),
    }
    let manifest: Manifest = serde_json::from_slice(&resp.bytes().await?).map_err(|e| UpdateError::BadManifest(e.to_string()))?;
    if parse_version(&manifest.version).is_none() {
        return Err(UpdateError::BadManifest(format!("версия «{}»", manifest.version)));
    }
    Ok(manifest)
}

/// Absolute URL of a file listed in the manifest found at `manifest_url`.
pub fn file_url(manifest_url: &str, file: &FileEntry) -> Result<String, UpdateError> {
    let base = url::Url::parse(manifest_url).map_err(|e| UpdateError::BadManifest(e.to_string()))?;
    base.join(&file.url).map(String::from).map_err(|e| UpdateError::BadManifest(e.to_string()))
}

/// Downloads `url` to `dest`, checking the size and SHA-256 from the manifest.
/// `progress(downloaded, total)` is called after every chunk.
pub async fn download(http: &Client, url: &str, file: &FileEntry, dest: &Path, mut progress: impl FnMut(u64, u64)) -> Result<(), UpdateError> {
    let mut resp = http.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(UpdateError::Status(resp.status().as_u16()));
    }
    let part = dest.with_extension("part");
    let mut out = std::fs::File::create(&part)?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    while let Some(chunk) = resp.chunk().await? {
        std::io::Write::write_all(&mut out, &chunk)?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        progress(downloaded, file.size);
    }
    drop(out);
    if downloaded != file.size || !hex(&hasher.finalize()).eq_ignore_ascii_case(file.sha256.trim()) {
        let _ = std::fs::remove_file(&part);
        return Err(UpdateError::Corrupt);
    }
    std::fs::rename(&part, dest)?;
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn versions() {
        assert_eq!(parse_version("v0.1.57"), Some((0, 1, 57)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version("0.1.3-beta"), Some((0, 1, 3)));
        assert_eq!(parse_version("x"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert!(is_newer("v0.1.10", "0.1.9"));
        assert!(is_newer("0.2.0", "0.1.99"));
        assert!(!is_newer("0.1.9", "0.1.9"));
        assert!(!is_newer("0.1.8", "0.1.9"));
        assert!(!is_newer("garbage", "0.1.0"));
    }

    #[test]
    fn manifest_addresses() {
        assert_eq!(manifest_url("https://updates.example.com/ashot/").unwrap(), "https://updates.example.com/ashot/latest.json");
        assert_eq!(manifest_url("https://updates.example.com/ashot").unwrap(), "https://updates.example.com/ashot/latest.json");
        assert_eq!(manifest_url("https://x.example/feed.JSON").unwrap(), "https://x.example/feed.JSON");
        assert_eq!(manifest_url("  "), None);
        assert_eq!(github_manifest_url("o/r"), "https://github.com/o/r/releases/latest/download/latest.json");

        let rel = FileEntry { url: "AShot_0.1.17_x64-setup.exe".into(), size: 1, sha256: String::new() };
        assert_eq!(
            file_url("https://updates.example.com/ashot/latest.json", &rel).unwrap(),
            "https://updates.example.com/ashot/AShot_0.1.17_x64-setup.exe"
        );
        let abs = FileEntry { url: "https://github.com/o/r/releases/download/v1/a.exe".into(), ..rel };
        assert_eq!(file_url("https://github.com/o/r/releases/latest/download/latest.json", &abs).unwrap(), abs.url);
    }

    #[tokio::test]
    async fn fetches_and_downloads_with_checks() {
        let server = MockServer::start().await;
        let body = b"new exe".to_vec();
        let sha = hex(&Sha256::digest(&body));
        Mock::given(method("GET"))
            .and(path("/ashot/latest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "version": "0.1.58", "notes": "- fix", "url": "",
                "files": { "portable": { "url": "AShot_0.1.58_x64-portable.exe", "size": body.len(), "sha256": sha } }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/ashot/AShot_0.1.58_x64-portable.exe"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
            .mount(&server)
            .await;

        let http = Client::new();
        let murl = manifest_url(&format!("{}/ashot/", server.uri())).unwrap();
        let manifest = fetch_manifest(&http, &murl).await.unwrap();
        assert_eq!(manifest.version, "0.1.58");
        assert!(manifest.file(InstallKind::Installer).is_none());
        let file = manifest.file(InstallKind::Portable).unwrap().clone();
        let url = file_url(&murl, &file).unwrap();

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("AShot.exe");
        let mut last = (0, 0);
        download(&http, &url, &file, &dest, |d, t| last = (d, t)).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert_eq!(last, (body.len() as u64, body.len() as u64));

        // A wrong checksum is rejected and leaves nothing behind.
        let bad = FileEntry { sha256: "0".repeat(64), ..file };
        let dest2 = dir.path().join("AShot2.exe");
        assert!(matches!(download(&http, &url, &bad, &dest2, |_, _| {}).await, Err(UpdateError::Corrupt)));
        assert!(!dest2.exists() && !dest2.with_extension("part").exists());
    }

    #[tokio::test]
    async fn missing_or_broken_manifest() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/none/latest.json")).respond_with(ResponseTemplate::new(404)).mount(&server).await;
        Mock::given(method("GET"))
            .and(path("/bad/latest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>"))
            .mount(&server)
            .await;
        let http = Client::new();
        assert!(matches!(fetch_manifest(&http, &format!("{}/none/latest.json", server.uri())).await, Err(UpdateError::NoReleases)));
        assert!(matches!(fetch_manifest(&http, &format!("{}/bad/latest.json", server.uri())).await, Err(UpdateError::BadManifest(_))));
    }
}
