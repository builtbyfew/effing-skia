//! Filter layers sized to their content: `skia-c/effing/filter_layer.cpp`.

use super::super::{Canvas, Paint, SkPicture, SkPictureRecorder, ffi};

unsafe extern "C" {
  fn effing_filter_layer_begin_content(recorder: *mut ffi::skiac_picture_recorder);
  fn effing_canvas_draw_filter_layer(
    canvas: *mut ffi::skiac_canvas,
    paint: *mut ffi::skiac_paint,
    content: *mut ffi::skiac_picture,
  );
}

impl SkPictureRecorder {
  /// Begins recording a filtered draw, in the space of the layer it is drawn
  /// through: the finished picture's cull rect is the union of what it
  /// draws (everything for a draw Skia can't bound), and the picture plays
  /// back every op wherever it is played.
  pub fn begin_filter_layer_content(&self) {
    unsafe { effing_filter_layer_begin_content(self.0) }
  }
}

impl Canvas {
  /// Draws `content`, recorded with `begin_filter_layer_content`, through a
  /// layer composited with `paint` and sized to what `content` draws.
  /// `paint` must pass `Paint::group_fits_content`.
  pub fn draw_filter_layer(&mut self, content: &SkPicture, paint: &Paint) {
    unsafe { effing_canvas_draw_filter_layer(self.0, paint.0, content.0) }
  }
}
