//! OAuth 2.0 redirect handling.
//!
//! The app shows the Box page in its own window and intercepts the navigation back to
//! the redirect URI, whatever it is ([`redirect_result`]) — the URL never has to exist.
//! The redirect URI registered for the Box app does not even have to be known: the
//! request may omit it, or the app tries the usual ones ([`redirect_candidates`]).

#[derive(Debug, thiserror::Error)]
pub enum OAuthError {
    #[error("Box отклонил вход: {0}")]
    Denied(String),
    #[error("Box не принял адрес возврата (redirect_uri): {0}")]
    RedirectRejected(String),
}

/// Redirect URIs that Box apps are commonly registered with (Greenshot-style apps use
/// the Box web app itself), tried when the configured one is unknown or rejected.
pub const COMMON_REDIRECTS: &[&str] = &[
    "https://www.box.com/home/",
    "https://www.box.com/home",
    "https://app.box.com",
    "https://app.box.com/",
    "http://localhost:47615/callback",
];

/// Redirect URIs to try, in order: `preferred` ones (learned / configured), then none at
/// all (Box falls back to the app's only redirect URI), then [`COMMON_REDIRECTS`].
/// `None` means "omit `redirect_uri`"; empty and duplicate entries are skipped.
pub fn redirect_candidates<'a>(preferred: impl IntoIterator<Item = Option<&'a str>>) -> Vec<Option<String>> {
    let mut out: Vec<Option<String>> = Vec::new();
    let all = preferred
        .into_iter()
        .filter_map(|r| match r.map(str::trim) {
            Some("") => None,
            r => Some(r.map(str::to_string)),
        })
        .chain([None])
        .chain(COMMON_REDIRECTS.iter().map(|r| Some(r.to_string())));
    for candidate in all {
        if !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}

/// Result of an OAuth redirect back to the app: any URL whose query carries our `state`
/// together with `code` or `error`. `None` for every other page (Box login, SSO, …):
/// identity providers use their own `state`, so they never match.
pub fn redirect_result(url: &str, expected_state: &str) -> Option<Result<String, OAuthError>> {
    let url = url::Url::parse(url).ok()?;
    let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.to_string());
    if param("state").as_deref() != Some(expected_state) {
        return None;
    }
    if let Some(code) = param("code").filter(|c| !c.is_empty()) {
        return Some(Ok(code));
    }
    let error = param("error")?;
    let description = param("error_description").unwrap_or_default();
    if is_redirect_error(&error, &description) {
        return Some(Err(OAuthError::RedirectRejected(error)));
    }
    Some(Err(OAuthError::Denied(if description.is_empty() { error } else { description })))
}

/// Whether an OAuth error is about the redirect URI (`redirect_uri_mismatch`, …).
pub fn is_redirect_error(error: &str, description: &str) -> bool {
    let text = format!("{error} {description}").to_ascii_lowercase();
    text.contains("redirect_uri") || text.contains("redirect uri")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_results() {
        assert_eq!(redirect_result("https://app.box.com/?code=C1&state=s1", "s1").unwrap().unwrap(), "C1");
        assert_eq!(redirect_result("https://www.box.com/home/?state=s1&code=C2", "s1").unwrap().unwrap(), "C2");
        assert_eq!(redirect_result("http://localhost:47615/callback?code=C3&state=s1", "s1").unwrap().unwrap(), "C3");
        // The authorization request itself, Box login pages, SSO with its own state.
        assert!(redirect_result("https://account.box.com/api/oauth2/authorize?response_type=code&client_id=x&state=s1", "s1").is_none());
        assert!(redirect_result("https://account.box.com/login?redirect_url=%2Fapi%2Foauth2%2Fauthorize%3Fstate%3Ds1", "s1").is_none());
        assert!(redirect_result("https://login.microsoftonline.com/cb?code=IDP&state=other", "s1").is_none());
        assert!(redirect_result("not a url", "s1").is_none());
        assert!(matches!(
            redirect_result("https://app.box.com/?error=access_denied&error_description=The+user+denied+access&state=s1", "s1"),
            Some(Err(OAuthError::Denied(d))) if d == "The user denied access"
        ));
        assert!(matches!(
            redirect_result("https://account.box.com/api/oauth2/authorize?error=redirect_uri_mismatch&state=s1", "s1"),
            Some(Err(OAuthError::RedirectRejected(_)))
        ));
        assert!(matches!(
            redirect_result("https://x.org/?error=invalid_request&error_description=Invalid+redirect_uri&state=s1", "s1"),
            Some(Err(OAuthError::RedirectRejected(_)))
        ));
    }

    #[test]
    fn candidates_order_and_dedup() {
        let c = redirect_candidates([Some("https://app.box.com"), Some("  "), None, Some("https://my.example/cb")]);
        assert_eq!(c[0].as_deref(), Some("https://app.box.com"));
        assert_eq!(c[1], None);
        assert_eq!(c[2].as_deref(), Some("https://my.example/cb"));
        assert_eq!(c.iter().filter(|r| r.as_deref() == Some("https://app.box.com")).count(), 1);
        assert_eq!(c.iter().filter(|r| r.is_none()).count(), 1);
        assert!(c.contains(&Some("https://www.box.com/home/".to_string())));
        assert_eq!(redirect_candidates([])[0], None);
    }
}
