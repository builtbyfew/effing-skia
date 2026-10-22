//! System fonts, which fonts registered under the same family name shadow, as
//! `@font-face` fonts shadow local ones in a browser, and the font
//! collection's revision. See `docs/effing.md`.

use std::sync::OnceLock;
use std::thread;

use napi::bindgen_prelude::*;

/// The user's font directories `index.js` asked to load with the system font
/// directory, set by the first call of `loadSystemFontsInBackground`.
static STARTUP_DIRS: OnceLock<Vec<String>> = OnceLock::new();

/// Set once the startup fonts (`STARTUP_DIRS` and the system font
/// directory) are loaded.
static STARTUP_FONTS: OnceLock<()> = OnceLock::new();

/// Loads the system's fonts as `GlobalFonts.loadSystemFonts()` does, then the
/// fonts in `user_dirs` as `loadSystemFontsFromDir` does, once per process
/// and on a thread of its own: `index.js` calls it at startup. The first call
/// starts the load; later ones, from any JS thread, do nothing. Every
/// `GlobalFonts` call and every text draw, measure or layout that comes
/// after the first call waits for the load to finish, so they see the fonts
/// as if `index.js` had loaded them synchronously, as it did before.
#[napi]
pub fn load_system_fonts_in_background(user_dirs: Vec<String>) {
  if STARTUP_DIRS.set(user_dirs).is_err() {
    return;
  }
  let spawned = thread::Builder::new()
    .name("effing-system-fonts".to_owned())
    .spawn(wait_for_startup_fonts);
  if spawned.is_err() {
    wait_for_startup_fonts();
  }
}

/// Waits until the fonts `loadSystemFontsInBackground` asked for are loaded,
/// loading them on the calling thread if the background thread hasn't
/// started yet. Returns at once if they are, or if nothing asked for them.
/// Everything that reads or changes the font collection calls it first
/// (`get_font`), so the load comes before any of that, in every thread.
pub(super) fn wait_for_startup_fonts() {
  let Some(dirs) = STARTUP_DIRS.get() else {
    return;
  };
  STARTUP_FONTS.get_or_init(|| {
    // Errors are a poisoned collection lock only, which the next call
    // reports; loadSystemFonts() keeps its own result for its callers.
    let _ = super::load_system_font_dir();
    for dir in dirs {
      let _ = super::load_fonts_from_dir(dir.as_str(), true);
    }
  });
}

/// Loads the fonts in `dir` and its subdirectories as system fonts, as
/// `GlobalFonts.loadSystemFonts()` loads the system's font directory: a font
/// registered with `GlobalFonts.register`, `registerFromPath` or
/// `loadFontsFromDir` under one of their family names takes precedence over
/// them, as `loadSystemFontsInBackground` loads the user's font directories.
/// Returns the number of fonts loaded.
#[napi]
pub fn load_system_fonts_from_dir(dir: String) -> Result<u32> {
  wait_for_startup_fonts();
  super::load_fonts_from_dir(dir.as_str(), true)
}

/// The revision of the global font collection, for `@effing/skia/extensions`:
/// upstream's generation counter, which every `GlobalFonts` call that changes
/// the collection bumps (`register`, `registerFromPath`, `remove`,
/// `removeBatch`, `removeAll`, `setAlias`, `loadFontsFromDir`,
/// `loadSystemFonts`, `loadSystemFontsFromDir`, and the startup load
/// `index.js` starts, which this waits for) and the deferred recording keys
/// its typeface charges on. An atomic read: the collection's lock isn't
/// taken.
#[napi]
pub fn font_revision() -> f64 {
  wait_for_startup_fonts();
  super::font_collection_generation() as f64
}
