# snow-ui-selector (vendored)

UI element hit-testing (UI Automation / MSAA) used by the capture overlay to
highlight windows **and individual controls inside them** under the mouse cursor.

Source: [mg-chao/snow-shot](https://github.com/mg-chao/snow-shot) → `snow-crates/crates/snow-ui-selector`,
commit `9ca44a60f3a49c2c36071d1a06ef721883ba0259`.
License: Apache-2.0, Copyright (C) 2026 mg-chao — see `LICENSE` and `COPYRIGHT`.

`Cargo.toml` was adapted for this workspace. Source changes (Apache-2.0 §4b):
`src/windows/spatial.rs` and `src/windows/uia/cache.rs` pass the search envelope by value,
as required by rstar 0.13; `ElementRegionService::window_at` (in `src/windows/mod.rs`,
`uia.rs`, `msaa.rs`) returns the window under a point, so the app can pick the MSAA backend
for Firefox windows.
