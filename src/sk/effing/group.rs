//! Compositing groups: `skia-c/effing/group.cpp`.

use super::super::{Canvas, ImageFilter, Matrix, Paint, Path, ffi};

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

/// An open group's layer, kept so a recording that resumes mid-group (after
/// its pixels were read) can open the layer again.
pub struct GroupLayer {
  pub paint: Paint,
  pub bounds: Option<[f32; 4]>,
  /// The transform `bounds` are in.
  pub transform: Matrix,
  /// The clip in effect when the group opened, in device space, which the
  /// group's composite is confined to.
  pub clip: Option<Path>,
}

impl GroupLayer {
  /// Opens the layer on `canvas` like `save_group` did, without the
  /// backdrop: the content behind it already has the backdrop baked in.
  /// Leaves `canvas` at the layer's transform. The clip goes on before the
  /// layer, at the enclosing save, so the composite is clipped like the
  /// first recording clipped it.
  pub fn reopen(&self, canvas: &mut Canvas) {
    canvas.reset_transform();
    if let Some(ref clip) = self.clip {
      canvas.set_clip_path(clip);
    }
    canvas.set_transform(&self.transform);
    canvas.save_group(&self.paint, None, self.bounds);
  }
}
