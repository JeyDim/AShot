//! File name patterns for saved screenshots.
//!
//! Tokens: `{yyyy} {yy} {MM} {dd} {HH} {mm} {ss} {fff}` (date/time parts),
//! `{w}` / `{h}` (image size), `{rand}` (6 random characters).

use chrono::{DateTime, Datelike, Local, Timelike};

pub const DEFAULT_PATTERN: &str = "Screenshot {yyyy}-{MM}-{dd} {HH}-{mm}-{ss}";

pub fn format(pattern: &str, now: DateTime<Local>, width: u32, height: u32) -> String {
    let pattern = if pattern.trim().is_empty() { DEFAULT_PATTERN } else { pattern };
    let rand = crate::random_string(6);
    let name = pattern
        .replace("{yyyy}", &format!("{:04}", now.year()))
        .replace("{yy}", &format!("{:02}", now.year() % 100))
        .replace("{MM}", &format!("{:02}", now.month()))
        .replace("{dd}", &format!("{:02}", now.day()))
        .replace("{HH}", &format!("{:02}", now.hour()))
        .replace("{mm}", &format!("{:02}", now.minute()))
        .replace("{ss}", &format!("{:02}", now.second()))
        .replace("{fff}", &format!("{:03}", now.timestamp_subsec_millis()))
        .replace("{w}", &width.to_string())
        .replace("{h}", &height.to_string())
        .replace("{rand}", &rand);
    sanitize(&name)
}

/// Removes characters that are not allowed in Windows file names.
pub fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim().to_string();
    if trimmed.is_empty() {
        "Screenshot".to_string()
    } else {
        trimmed
    }
}

/// Returns `dir/name.ext`, adding ` (2)`, ` (3)`… when the file already exists.
pub fn unique_path(dir: &std::path::Path, name: &str, ext: &str) -> std::path::PathBuf {
    let first = dir.join(format!("{name}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..10_000)
        .map(|i| dir.join(format!("{name} ({i}).{ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn formats_tokens() {
        let now = Local.with_ymd_and_hms(2026, 10, 8, 14, 5, 9).unwrap();
        assert_eq!(format(DEFAULT_PATTERN, now, 10, 20), "Screenshot 2026-10-08 14-05-09");
        assert_eq!(format("{w}x{h}", now, 10, 20), "10x20");
        assert_eq!(format("{rand}", now, 1, 1).len(), 6);
    }

    #[test]
    fn sanitizes() {
        assert_eq!(sanitize("a:b/c?.png."), "a_b_c_.png");
        assert_eq!(sanitize("  "), "Screenshot");
    }

    #[test]
    fn unique_paths() {
        let dir = tempfile::tempdir().unwrap();
        let p1 = unique_path(dir.path(), "x", "png");
        std::fs::write(&p1, b"1").unwrap();
        let p2 = unique_path(dir.path(), "x", "png");
        assert_eq!(p2.file_name().unwrap(), "x (2).png");
    }
}
