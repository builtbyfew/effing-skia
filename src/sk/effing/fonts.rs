//! System fonts, which registered fonts shadow: `skia-c/effing/fonts.cpp`.

use std::ffi::{CString, c_char};

use super::super::{FontCollection, ffi};

unsafe extern "C" {
  fn effing_font_collection_register_system_font(
    collection: *mut ffi::skiac_font_collection,
    path: *const c_char,
  ) -> u32;
}

impl FontCollection {
  /// Registers the font file at `font_path` under its own family name as a
  /// system font, which any face registered under that name shadows. Returns
  /// the font's id, as `register_from_path` does, or `None` when the file is
  /// no font. A font already registered from `font_path` stays as it is.
  pub fn register_system_font(&self, font_path: &str) -> Option<u32> {
    let path = CString::new(font_path).ok()?;
    let typeface_id = unsafe { effing_font_collection_register_system_font(self.0, path.as_ptr()) };
    (typeface_id > 0).then_some(typeface_id)
  }
}
