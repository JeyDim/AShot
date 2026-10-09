//! Links to uploaded screenshots by a template: Box.com shared links rewritten to a custom
//! proxy domain (`https://app.box.com/s/3rud4dfakga5r953wt77anhyzo27tm7r` →
//! `https://proxy.example/3rud4dfakga5r953wt77anhyzo27tm7r` with the template
//! `https://proxy.example/{id}`) or, without a proxy, to the Box embed preview; for S3 the
//! `{id}` is the random id the object was stored under.

use url::Url;

/// Box's own preview page: shows the image without a Box login (for "open" links),
/// also on phones. Used when the build has no proxy domain.
pub const BOX_EMBED_TEMPLATE: &str = "https://app.box.com/embed/s/{id}";

/// Template that earlier versions stored as the default (the proxy domain was built in).
pub const LEGACY_DEFAULT_TEMPLATE: &str = "https://advant.one/{id}";

/// Default link template: the proxy domain (or template) given to the build,
/// otherwise the Box embed link.
pub fn default_template(proxy: Option<&str>) -> String {
    match proxy.map(normalize_template).filter(|t| !t.is_empty()) {
        Some(t) => t,
        None => BOX_EMBED_TEMPLATE.into(),
    }
}

/// Extracts the shared-link identifier from a Box shared link
/// (`https://app.box.com/s/<id>`, `https://<company>.app.box.com/s/<id>`,
/// `https://<company>.box.com/s/<id>` or a static download link
/// `https://app.box.com/shared/static/<id>.png`).
pub fn extract_shared_id(link: &str) -> Option<String> {
    let url = Url::parse(link.trim()).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    if !(host == "box.com" || host.ends_with(".box.com") || host == "box.net" || host.ends_with(".box.net")) {
        return None;
    }
    let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    let candidate = match segments.as_slice() {
        ["s", id, ..] => *id,
        ["shared", "static", file] => file.split('.').next().unwrap_or_default(),
        _ => return None,
    };
    if !candidate.is_empty() && candidate.chars().all(|c| c.is_ascii_alphanumeric()) {
        Some(candidate.to_string())
    } else {
        None
    }
}

/// Normalises a user-entered template (empty stays empty = "the default"):
/// * `proxy.example` → `https://proxy.example/{id}`
/// * `https://proxy.example/` → `https://proxy.example/{id}`
/// * `https://i.proxy.example/{id}.png` stays as is.
pub fn normalize_template(template: &str) -> String {
    let mut t = template.trim().to_string();
    if t.is_empty() {
        return t;
    }
    if !t.contains("://") {
        t = format!("https://{t}");
    }
    if !t.contains("{id}") {
        if !t.ends_with('/') {
            t.push('/');
        }
        t.push_str("{id}");
    }
    t
}

/// Builds the public link from a Box shared link and a template.
///
/// Supported placeholders: `{id}` – shared link id, `{ext}` – file extension
/// without dot (empty when unknown), `{name}` – URL-encoded file name.
/// Returns the original link unchanged when it is not a recognisable Box link.
pub fn rewrite(box_link: &str, template: &str, file_name: Option<&str>) -> String {
    let Some(id) = extract_shared_id(box_link) else {
        return box_link.to_string();
    };
    fill(&default_template(Some(template)), &id, file_name)
}

/// The link by a template (placeholders as in [`rewrite`]).
pub fn fill(template: &str, id: &str, file_name: Option<&str>) -> String {
    let ext = file_name
        .and_then(|n| n.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()))
        .unwrap_or_default();
    let name = file_name.map(encode_component).unwrap_or_default();
    template
        .replace("{id}", id)
        .replace("{ext}", &ext)
        .replace("{name}", &name)
}

/// Short human-friendly form used in the UI: `proxy.example/3rud4dfa…`.
pub fn display(link: &str) -> String {
    let without_scheme = link.split_once("://").map(|(_, rest)| rest).unwrap_or(link);
    without_scheme.trim_end_matches('/').to_string()
}

/// Percent-encodes everything except the unreserved characters of RFC 3986.
pub(crate) fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_example_from_spec() {
        let old = "https://app.box.com/s/3rud4dfakga5r953wt77anhyzo27tm7r";
        assert_eq!(
            rewrite(old, "https://advant.one/{id}", None),
            "https://advant.one/3rud4dfakga5r953wt77anhyzo27tm7r"
        );
    }

    #[test]
    fn default_is_proxy_or_box_embed() {
        assert_eq!(default_template(None), BOX_EMBED_TEMPLATE);
        assert_eq!(default_template(Some(" ")), BOX_EMBED_TEMPLATE);
        assert_eq!(default_template(Some("advant.one")), "https://advant.one/{id}");
        assert_eq!(default_template(Some("https://i.example.com/{id}.{ext}")), "https://i.example.com/{id}.{ext}");
        let old = "https://app.box.com/s/w1xbk8rxw0to943akdsm1xoa5napunwl";
        assert_eq!(rewrite(old, "", None), "https://app.box.com/embed/s/w1xbk8rxw0to943akdsm1xoa5napunwl");
    }

    #[test]
    fn supports_enterprise_subdomains_and_static_links() {
        assert_eq!(
            extract_shared_id("https://advant.app.box.com/s/abc123XYZ?foo=bar").as_deref(),
            Some("abc123XYZ")
        );
        assert_eq!(
            extract_shared_id("https://app.box.com/shared/static/abc123.png").as_deref(),
            Some("abc123")
        );
        assert_eq!(extract_shared_id("https://example.com/s/abc"), None);
        assert_eq!(extract_shared_id("https://app.box.com/file/123"), None);
        assert_eq!(extract_shared_id("https://app.box.com/s/../etc"), None);
        assert_eq!(extract_shared_id("not a url"), None);
    }

    #[test]
    fn template_normalisation() {
        assert_eq!(normalize_template("advant.one"), "https://advant.one/{id}");
        assert_eq!(normalize_template("https://advant.one/"), "https://advant.one/{id}");
        assert_eq!(normalize_template(" "), "");
        assert_eq!(normalize_template("https://i.advant.one/{id}.{ext}"), "https://i.advant.one/{id}.{ext}");
    }

    #[test]
    fn placeholders() {
        let link = "https://app.box.com/s/abc";
        assert_eq!(
            rewrite(link, "https://cdn.advant.one/{id}.{ext}", Some("Shot 1.PNG")),
            "https://cdn.advant.one/abc.png"
        );
        assert_eq!(
            rewrite(link, "https://advant.one/{id}/{name}", Some("Скрин 1.png")),
            "https://advant.one/abc/%D0%A1%D0%BA%D1%80%D0%B8%D0%BD%201.png"
        );
    }

    #[test]
    fn fills_s3_ids() {
        assert_eq!(fill("https://advant.one/{id}", "k3m9x2p7q4r8s5t6", Some("a.png")), "https://advant.one/k3m9x2p7q4r8s5t6");
        assert_eq!(fill("https://i.example.com/{id}.{ext}", "k3m9", Some("Shot.WEBP")), "https://i.example.com/k3m9.webp");
    }

    #[test]
    fn unknown_links_are_left_untouched() {
        assert_eq!(rewrite("https://example.com/x", BOX_EMBED_TEMPLATE, None), "https://example.com/x");
    }

    #[test]
    fn display_strips_scheme() {
        assert_eq!(display("https://advant.one/abc"), "advant.one/abc");
    }
}
