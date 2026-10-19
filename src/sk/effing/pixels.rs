//! Direct access to an image's pixels: `skia-c/effing/pixels.cpp`.

use std::{ptr, slice};

use super::super::{SkImage, ffi};

unsafe extern "C" {
  fn effing_image_peek_premul_rgba(
    image: *mut ffi::skiac_image,
    pixels: *mut *const u8,
    row_bytes: *mut usize,
  ) -> bool;
}

impl SkImage {
  /// The image's pixels and the bytes between the starts of two rows,
  /// borrowed without a copy, when it is a raster image stored as
  /// premultiplied RGBA (a raster canvas snapshot is). Each row is
  /// `width * 4` bytes; the last row may end before a full stride. The
  /// pixels and the stride are 4-byte aligned, so rows can be read as `u32`s.
  pub fn peek_premul_rgba(&self) -> Option<(&[u8], usize)> {
    let (width, height) = (self.width() as usize, self.height() as usize);
    let mut pixels = ptr::null();
    let mut row_bytes = 0;
    if width == 0
      || height == 0
      || !unsafe { effing_image_peek_premul_rgba(self.0, &mut pixels, &mut row_bytes) }
      || row_bytes < width * 4
      || pixels.addr() % 4 != 0
      || row_bytes % 4 != 0
    {
      return None;
    }
    let len = row_bytes * (height - 1) + width * 4;
    // SAFETY: Skia's pixmap spans `height` rows `row_bytes` apart, each at
    // least `width * 4` bytes, and stays valid and unchanged while the image
    // lives (see pixels.hpp). (Skia already keeps RGBA rows 4-byte aligned;
    // the check above is what the `u32` readers rely on.)
    Some((unsafe { slice::from_raw_parts(pixels, len) }, row_bytes))
  }
}
