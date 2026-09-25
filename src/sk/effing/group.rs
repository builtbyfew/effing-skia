//! Compositing groups: `skia-c/effing/group.cpp`.

use super::super::{Canvas, ImageFilter, Paint, ffi};

unsafe extern "C" {
  fn effing_canvas_save_group(
    canvas: *mut ffi::skiac_canvas,
    paint: *mut ffi::skiac_paint,
    backdrop: *mut ffi::skiac_image_filter,
    bounds: *const f32,
  );
}

impl Canvas {
  /// `SkCanvas::saveLayer` for a compositing group: everything drawn until the
  /// matching `restore()` is composited as one with `paint`'s alpha, blend
  /// mode and image filter. A `backdrop` filter starts the group from the
  /// filtered content behind it, and `bounds` (x, y, w, h in local space)
  /// hints the group's size and clips its content. Owes one `restore()`.
  pub fn save_group(
    &mut self,
    paint: &Paint,
    backdrop: Option<&ImageFilter>,
    bounds: Option<[f32; 4]>,
  ) {
    unsafe {
      effing_canvas_save_group(
        self.0,
        paint.0,
        backdrop.map_or(std::ptr::null_mut(), |f| f.0),
        bounds.as_ref().map_or(std::ptr::null(), |b| b.as_ptr()),
      );
    }
  }
}
