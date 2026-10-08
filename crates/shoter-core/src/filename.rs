//! File name patterns for saved screenshots.
//!
//! Tokens: `{date}` (2026-10-08), `{time}` (14-05-09), `{n}` (next free number in the
//! folder), `{yyyy} {yy} {MM} {dd} {HH} {mm} {ss} {fff}` (date/time parts),
//! `{w}` / `{h}` (image size), `{rand}` (6 random characters).

use chrono::{DateTime, Datelike, Local, Timelike};

pub const DEFAULT_PATTERN: &str = "Screenshot {date} {time}";

pub fn format(pattern: &str, now: DateTime<Local>, width: u32, height: u32) -> String {
    let pattern = if pattern.trim().is_empty() { DEFAULT_PATTERN } else { pattern };
    let rand = crate::random_string(6);
    let name = pattern
        .replace("{date}", &format!("{:04}-{:02}-{:02}", now.year(), now.month(), now.day()))
        .replace("{time}", &format!("{:02}-{:02}-{:02}", now.hour(), now.minute(), now.second()))
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

/// `{n}` is left in the name by [`format`]: it becomes the first number that gives a new file.
const NUMBER: &str = "{n}";

/// Path for "Save": fills `{n}` with the next free number or, without `{n}`,
/// adds ` (2)`, ` (3)`… when the file already exists.
pub fn numbered_path(dir: &std::path::Path, name: &str, ext: &str) -> std::path::PathBuf {
    if !name.contains(NUMBER) {
        return unique_path(dir, name, ext);
    }
    (1..100_000)
        .map(|i| dir.join(format!("{}.{ext}", name.replace(NUMBER, &i.to_string()))))
        .find(|p| !p.exists())
        .unwrap_or_else(|| unique_path(dir, &name.replace(NUMBER, "1"), ext))
}

/// Name for places without a folder to count in (Box upload resolves conflicts itself).
pub fn first_number(name: &str) -> String {
    name.replace(NUMBER, "1")
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
        assert_eq!(format("Shot_{date}_{time}", now, 1, 1), "Shot_2026-10-08_14-05-09");
        assert_eq!(format("Shot {n}", now, 1, 1), "Shot {n}");
    }

    #[test]
    fn numbers() {
        let dir = tempfile::tempdir().unwrap();
        let p1 = numbered_path(dir.path(), "Shot {n}", "png");
        assert_eq!(p1.file_name().unwrap(), "Shot 1.png");
        std::fs::write(&p1, b"1").unwrap();
        std::fs::write(dir.path().join("Shot 2.png"), b"2").unwrap();
        assert_eq!(numbered_path(dir.path(), "Shot {n}", "png").file_name().unwrap(), "Shot 3.png");
        assert_eq!(first_number("Shot {n}"), "Shot 1");
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
