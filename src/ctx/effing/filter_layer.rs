//! `ctx.filter` and image-filter shadows through a layer the size of what
//! the draw paints, rather than one the size of the canvas.
//!
//! Upstream's `composited_filter_layer` opens the layer a filtered draw goes
//! through at the device identity, so that the filter's lengths are device
//! pixels, and without bounds, so Skia sizes it to the clip, and a filter
//! such as a blur then runs over the whole canvas for a line of text. Here
//! the draw is recorded first, in the layer's space, and the layer is given
//! what the recording draws as its bounds, the way SkCanvas bounds the layer
//! of a draw whose own paint carries the filter. Skia still sizes the layer
//! to what the filter needs to fill the clip, so a blur keeps taking in what
//! is drawn past the clip's edge; the bounds only leave out the transparent
//! rest, which the filter would turn into nothing.
//!
//! The pixels are those of the unbounded layer, up to rounding: where a
//! layer starts moves the rounding of what is drawn into it and of the
//! filter, by a level or so in a few pixels, mostly under a scale, rotation
//! or skew. An image drawn with `imageSmoothingEnabled = false` at a
//! fractional scale and position can also pick the other of two equally near
//! source pixels, a whole row or column apart; both are valid, and a group's
//! content-sized buffer picks the same way (`docs/effing.md`, filtered
//! draws). The layer still covers the clip where bounds could change more or
//! would save next to nothing:
//!
//! - for a blend mode or a filter that changes what is behind the layer
//!   where it is transparent (`clear`, `modulate`, or a filter that affects
//!   transparent black; see `Paint::group_fits_content`). `copy`,
//!   `source-in` and the like reach the layer as `source-over`, inside the
//!   isolation layer `render_canvas` gives them;
//! - under a singular transform, where the layer has no device space;
//! - for content that covers the clip, such as a background, or that Skia
//!   can't bound, such as `drawPaint`.

use super::super::Context;
use crate::error::SkError;
use crate::sk::{Canvas, Matrix, Paint, SkPictureRecorder};

impl Context {
  /// The `composited_filter_layer` hook. With `canvas` at the device
  /// identity, draws `f` through a layer composited with `layer_paint` and
  /// the size of what `f` draws, under `device_ctm`. `None`, with nothing
  /// drawn, when `layer_paint` needs the layer to cover the clip, for
  /// upstream's unbounded layer to draw it.
  pub(crate) fn draw_fitted_filter_layer<F>(
    canvas: &mut Canvas,
    device_ctm: &Matrix,
    layer_paint: &Paint,
    paint: &Paint,
    f: F,
  ) -> Option<Result<(), SkError>>
  where
    F: Fn(&mut Canvas, &Paint) -> Result<(), SkError>,
  {
    // The layer opens at the device identity, so no rotation or skew of the
    // draw resamples it, and only the blend mode and the filter can stop it
    // fitting. Strictly the layer's matrix is `ctm * ctm^-1`, a float epsilon
    // off the identity under a rotation or skew, but that is the matrix the
    // unbounded layer opens under too, so checking at the identity is right.
    if !layer_paint.group_fits_content(&Matrix::identity()) {
      return None;
    }
    let recorder = SkPictureRecorder::new();
    recorder.begin_filter_layer_content();
    let mut content = recorder.get_recording_canvas()?;
    content.concat(device_ctm);
    // What `f` drew before an error is drawn all the same, as on the
    // unbounded layer.
    let result = f(&mut content, paint);
    // SkPictureRecorder::finishRecordingAsPicture always returns a picture,
    // an empty one when nothing was drawn, so this can't drop the draw.
    // Running `f` again instead would charge what it draws to the recording
    // twice.
    let picture = recorder.finish_recording_as_picture();
    debug_assert!(
      picture.is_some(),
      "finishRecordingAsPicture returns a picture"
    );
    if let Some(picture) = picture {
      canvas.draw_filter_layer(&picture, layer_paint);
    }
    Some(result)
  }
}
