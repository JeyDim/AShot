fn main() {
    // Build metadata shown in the "About" window.
    let date = std::process::Command::new("git")
        .args(["log", "-1", "--format=%cs"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "dev".into());
    let commit = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "local".into());
    println!("cargo:rustc-env=SHOTER_BUILD_DATE={date}");
    println!("cargo:rustc-env=SHOTER_COMMIT={commit}");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    // Built-in Box app (OAuth client) – provided by CI secrets, see README.
    println!("cargo:rerun-if-env-changed=SHOTER_BOX_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=SHOTER_BOX_CLIENT_SECRET");
    println!("cargo:rerun-if-env-changed=SHOTER_BOX_REDIRECT_URI");
    // Proxy domain for links (CI secret PROXY_DOMAIN); empty = Box embed links.
    println!("cargo:rerun-if-env-changed=SHOTER_PROXY_DOMAIN");
    // Self-update source: own server (CI secret UPDATE_URL) or the GitHub repository.
    println!("cargo:rerun-if-env-changed=SHOTER_UPDATE_URL");
    println!("cargo:rerun-if-env-changed=SHOTER_UPDATE_REPO");
    tauri_build::build()
}
