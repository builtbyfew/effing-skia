//! Installed fonts that shadow the system's: `skia-c/font_families.cpp`.

use std::ffi::{CString, c_char};

use super::super::{FontCollection, ffi};

unsafe extern "C" {
  fn effing_font_collection_register_installed_font(
    collection: *mut ffi::skiac_font_collection,
    path: *const c_char,
    shadowable: bool,
  ) -> u32;
}

impl FontCollection {
  /// `register_system_font` for a font `loadFontsFromDir` loads: an
  /// installed font, as upstream has it, which shadows the system's family
  /// of its name as a registered font does. Returns the font's id, or `None`
  /// when the file is no font.
  pub fn register_shadowing_installed_font(&self, font_path: &str) -> Option<u32> {
    let path = CString::new(font_path).ok()?;
    let id =
      unsafe { effing_font_collection_register_installed_font(self.0, path.as_ptr(), false) };
    (id > 0).then_some(id)
  }
}
