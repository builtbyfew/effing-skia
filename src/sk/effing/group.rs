//! Compositing groups: `skia-c/effing/group.cpp`.

use super::super::{Canvas, ImageFilter, Matrix, Paint, Path, SkPicture, ffi};

unsafe extern "C" {
  fn effing_canvas_save_group(
    canvas: *mut ffi::skiac_canvas,
    paint: *mut ffi::skiac_paint,
    backdrop: *mut ffi::skiac_image_filter,
    bounds: *const f32,
  );
  fn effing_group_fits_content(
    paint: *mut ffi::skiac_paint,
    matrix: *mut ffi::skiac_matrix,
  ) -> bool;
  fn effing_canvas_clip_bounds(canvas: *mut ffi::skiac_canvas, bounds: *const f32);
  fn effing_group_content_bounds(
    paint: *mut ffi::skiac_paint,
    matrix: *mut ffi::skiac_matrix,
    clip: *const f32,
    width: f32,
    height: f32,
    out: *mut f32,
  );
  fn effing_canvas_composite_group(
    canvas: *mut ffi::skiac_canvas,
    content: *mut ffi::skiac_picture,
    paint: *mut ffi::skiac_paint,
    matrix: *mut ffi::skiac_matrix,
  );
}

impl Paint {
  /// Whether a group composited with this paint under `transform` leaves
  /// everything outside what it draws alone, so its layer can be sized to
  /// its content: not for blend modes that change the destination where the
  /// layer is transparent (`copy`, `source-in`, `destination-in`, …), nor
  /// for an image filter whose output bounds can't be computed or under a
  /// rotation or skew, where the filtered layer is resampled.
  pub fn group_fits_content(&self, transform: &Matrix) -> bool {
    unsafe { effing_group_fits_content(self.0, transform.0) }
  }
}

impl Canvas {
  /// Clips to `bounds` (x, y, w, h in local space).
  pub fn clip_bounds(&mut self, bounds: [f32; 4]) {
    unsafe { effing_canvas_clip_bounds(self.0, bounds.as_ptr()) }
  }

  /// Composites a group's `content`, recorded in device space, with `paint`
  /// through a layer the size of what `content` draws, opened under the
  /// group's `transform`.
  pub fn composite_group(&mut self, content: &SkPicture, paint: &Paint, transform: &Matrix) {
    unsafe { effing_canvas_composite_group(self.0, content.0, paint.0, transform.0) }
  }
}

impl Canvas {
  /// `SkCanvas::saveLayer` for a compositing group: everything drawn until the
  /// matching `restore()` is composited as one with `paint`'s alpha, blend
  /// mode and image filter. Without a `paint` it is a plain `save()`, for a
  /// group that composites nothing. A `backdrop` filter starts the group from
  /// the filtered content behind it, and `bounds` (x, y, w, h in local space)
  /// hints the group's size and clips its content. Owes one `restore()`.
  pub fn save_group(
    &mut self,
    paint: Option<&Paint>,
    backdrop: Option<&ImageFilter>,
    bounds: Option<[f32; 4]>,
  ) {
    unsafe {
      effing_canvas_save_group(
        self.0,
        paint.map_or(std::ptr::null_mut(), |p| p.0),
        backdrop.map_or(std::ptr::null_mut(), |f| f.0),
        bounds.as_ref().map_or(std::ptr::null(), |b| b.as_ptr()),
      );
    }
  }
}

/// An open group's layer, kept so a recording that resumes mid-group (after
/// its pixels were read) can open the layer again, and so a group recorded on
/// its own can be composited when it ends.
pub struct GroupLayer {
  /// `None` for a group that composites nothing: a plain save.
  pub paint: Option<Paint>,
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
    self.restore_opening_state(canvas);
    canvas.save_group(self.paint.as_ref(), None, self.bounds);
  }

  /// Like `reopen` for a group drawn on its own (see `begin_content`): the
  /// clip, then the plain save its composite goes into when it ends.
  pub fn reopen_save(&self, canvas: &mut Canvas) {
    self.restore_opening_state(canvas);
    canvas.save();
  }

  fn restore_opening_state(&self, canvas: &mut Canvas) {
    canvas.reset_transform();
    if let Some(ref clip) = self.clip {
      canvas.set_clip_path(clip);
    }
    canvas.set_transform(&self.transform);
  }

  /// The device-space region to record the group's content in, for a canvas
  /// of `width` x `height`: as much as the layer an up-front `saveLayer`
  /// would have opened can hold.
  pub fn content_bounds(&self, width: f32, height: f32) -> [f32; 4] {
    let mut bounds = [0.0; 4];
    let Some(ref paint) = self.paint else {
      return [0.0, 0.0, width, height];
    };
    let clip = self.clip.as_ref().map(|clip| {
      let (left, top, right, bottom) = clip.get_bounds();
      [left, top, right, bottom]
    });
    unsafe {
      effing_group_content_bounds(
        paint.0,
        self.transform.0,
        clip.as_ref().map_or(std::ptr::null(), |clip| clip.as_ptr()),
        width,
        height,
        bounds.as_mut_ptr(),
      )
    };
    bounds
  }

  /// Sets up a new recording of the group's content, `canvas`, in device
  /// space: the transform the group opened with and its `bounds` clip. The
  /// clip it opened under is applied when the content is played into the
  /// layer, which takes it from the canvas; applying it here too would
  /// darken anti-aliased clip edges, since intersecting coverage multiplies.
  pub fn begin_content(&self, canvas: &mut Canvas) {
    canvas.set_transform(&self.transform);
    if let Some(bounds) = self.bounds {
      canvas.clip_bounds(bounds);
    }
  }
}
