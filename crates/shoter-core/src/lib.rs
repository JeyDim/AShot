//! Platform-independent core of AdvantShoter.
//!
//! Everything here is plain Rust without any windowing/OS dependencies so it can be
//! unit-tested on any platform. The Tauri application (`src-tauri`) wires it together
//! with screen capture, tray, hotkeys and the web UI.

pub mod boxapi;
pub mod filename;
pub mod geometry;
pub mod history;
pub mod imaging;
pub mod links;
pub mod oauth;
pub mod settings;

pub use geometry::Rect;

/// Random lowercase alphanumeric string (no ambiguous characters).
/// Not cryptographically strong; used for file names and OAuth `state`.
pub fn random_string(len: usize) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut out = String::with_capacity(len);
    let mut seed = 0u64;
    while out.len() < len {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(seed);
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default(),
        );
        let mut v = h.finish();
        seed = v;
        for _ in 0..8 {
            if out.len() == len {
                break;
            }
            out.push(ALPHABET[(v % ALPHABET.len() as u64) as usize] as char);
            v /= ALPHABET.len() as u64;
        }
    }
    out
}

/// Decodes `%XX` escapes (invalid sequences are kept as-is).
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn random_strings() {
        let a = super::random_string(12);
        assert_eq!(a.len(), 12);
        assert_ne!(a, super::random_string(12));
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(super::percent_decode("/session%2F1%2F0.bmp"), "/session/1/0.bmp");
        assert_eq!(super::percent_decode("/a%2"), "/a%2");
        assert_eq!(super::percent_decode("/%D0%B9"), "/й");
        assert_eq!(super::percent_decode("/plain"), "/plain");
    }
}
