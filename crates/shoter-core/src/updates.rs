//! Updates from GitHub Releases. CI publishes every build of the main branch as a
//! release `v<version>` with the NSIS installer (`…-setup.exe`) and the portable exe
//! (`…-portable.exe`); the app compares versions and downloads the matching file.

use std::path::Path;

use reqwest::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const GITHUB_API: &str = "https://api.github.com";

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("сеть: {0}")]
    Http(#[from] reqwest::Error),
    #[error("GitHub ответил {0}")]
    Status(u16),
    #[error("релизов пока нет")]
    NoReleases,
    #[error("в релизе нет файла для этой установки")]
    NoAsset,
    #[error("файл скачан не полностью или повреждён")]
    Corrupt,
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub tag_name: String,
    #[serde(default)]
    pub body: Option<String>,
    pub html_url: String,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub assets: Vec<Asset>,
}

impl Release {
    /// Version without the `v` prefix.
    pub fn version(&self) -> &str {
        self.tag_name.trim_start_matches(['v', 'V'])
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Asset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
    /// `sha256:<hex>` (GitHub computes it for uploaded assets).
    #[serde(default)]
    pub digest: Option<String>,
}

/// How the running copy was installed, i.e. which release file updates it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    /// NSIS installer (an `uninstall.exe` lies next to the exe).
    Installer,
    /// A single exe anywhere: replaced in place.
    Portable,
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

/// Release file for the given kind of installation.
pub fn pick_asset(release: &Release, kind: InstallKind) -> Option<&Asset> {
    release.assets.iter().find(|a| {
        let name = a.name.to_ascii_lowercase();
        match kind {
            InstallKind::Installer => name.ends_with("-setup.exe"),
            InstallKind::Portable => name.ends_with(".exe") && name.contains("portable"),
        }
    })
}

/// Latest published release of `repo` (`owner/name`).
pub async fn latest_release(http: &Client, api_base: &str, repo: &str) -> Result<Release, UpdateError> {
    let resp = http
        .get(format!("{api_base}/repos/{repo}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?;
    match resp.status().as_u16() {
        200 => Ok(resp.json().await?),
        404 => Err(UpdateError::NoReleases),
        code => Err(UpdateError::Status(code)),
    }
}

/// Downloads `asset` to `dest`, checking its size and SHA-256 (when GitHub provides one).
/// `progress(downloaded, total)` is called after every chunk.
pub async fn download(http: &Client, asset: &Asset, dest: &Path, mut progress: impl FnMut(u64, u64)) -> Result<(), UpdateError> {
    let mut resp = http.get(&asset.browser_download_url).send().await?;
    if !resp.status().is_success() {
        return Err(UpdateError::Status(resp.status().as_u16()));
    }
    let part = dest.with_extension("part");
    let mut file = std::fs::File::create(&part)?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    while let Some(chunk) = resp.chunk().await? {
        std::io::Write::write_all(&mut file, &chunk)?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        progress(downloaded, asset.size);
    }
    drop(file);
    let expected = asset.digest.as_deref().and_then(|d| d.strip_prefix("sha256:"));
    let actual = hex(&hasher.finalize());
    if downloaded != asset.size || expected.is_some_and(|e| !e.eq_ignore_ascii_case(&actual)) {
        let _ = std::fs::remove_file(&part);
        return Err(UpdateError::Corrupt);
    }
    std::fs::rename(&part, dest)?;
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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

    fn release() -> Release {
        let asset = |name: &str| Asset { name: name.into(), size: 1, browser_download_url: String::new(), digest: None };
        Release {
            tag_name: "v0.1.57".into(),
            body: None,
            html_url: String::new(),
            published_at: None,
            assets: vec![asset("AShot_0.1.57_x64_ru-RU.msi"), asset("AShot_0.1.57_x64-setup.exe"), asset("AShot_0.1.57_x64-portable.exe")],
        }
    }

    #[test]
    fn picks_asset_for_installation() {
        let r = release();
        assert_eq!(r.version(), "0.1.57");
        assert_eq!(pick_asset(&r, InstallKind::Installer).unwrap().name, "AShot_0.1.57_x64-setup.exe");
        assert_eq!(pick_asset(&r, InstallKind::Portable).unwrap().name, "AShot_0.1.57_x64-portable.exe");
    }

    #[tokio::test]
    async fn fetches_and_downloads_with_checks() {
        let server = MockServer::start().await;
        let body = b"new exe".to_vec();
        let digest = format!("sha256:{}", hex(&Sha256::digest(&body)));
        let url = format!("{}/dl/AShot-portable.exe", server.uri());
        Mock::given(method("GET"))
            .and(path("/repos/o/r/releases/latest"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "tag_name": "v0.1.58", "html_url": "https://github.com/o/r/releases/tag/v0.1.58", "body": "notes",
                "assets": [{ "name": "AShot_0.1.58_x64-portable.exe", "size": body.len(), "browser_download_url": url, "digest": digest }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/dl/AShot-portable.exe"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
            .mount(&server)
            .await;

        let http = Client::new();
        let release = latest_release(&http, &server.uri(), "o/r").await.unwrap();
        assert_eq!(release.version(), "0.1.58");
        let asset = pick_asset(&release, InstallKind::Portable).unwrap().clone();

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("AShot.exe");
        let mut last = (0, 0);
        download(&http, &asset, &dest, |d, t| last = (d, t)).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert_eq!(last, (body.len() as u64, body.len() as u64));

        // A wrong checksum is rejected and leaves nothing behind.
        let bad = Asset { digest: Some(format!("sha256:{}", "0".repeat(64))), ..asset };
        let dest2 = dir.path().join("AShot2.exe");
        assert!(matches!(download(&http, &bad, &dest2, |_, _| {}).await, Err(UpdateError::Corrupt)));
        assert!(!dest2.exists() && !dest2.with_extension("part").exists());
    }

    #[tokio::test]
    async fn no_releases_yet() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).respond_with(ResponseTemplate::new(404)).mount(&server).await;
        assert!(matches!(latest_release(&Client::new(), &server.uri(), "o/r").await, Err(UpdateError::NoReleases)));
    }
}
