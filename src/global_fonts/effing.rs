//! System fonts, which fonts registered under the same family name shadow, as
//! `@font-face` fonts shadow local ones in a browser. See `docs/effing.md`.

use napi::bindgen_prelude::*;

/// Loads the fonts in `dir` and its subdirectories as system fonts, as
/// `GlobalFonts.loadSystemFonts()` loads the system's font directory: a font
/// registered with `GlobalFonts.register`, `registerFromPath` or
/// `loadFontsFromDir` under one of their family names takes precedence over
/// them. `index.js` loads the user's font directories with it. Returns the
/// number of fonts loaded.
#[napi]
pub fn load_system_fonts_from_dir(dir: String) -> Result<u32> {
  super::load_fonts_from_dir(dir.as_str(), true)
}
