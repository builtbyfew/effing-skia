//! Unsnapped text, `textRendering = 'geometricPrecision'`: what it records
//! counts toward the recording's byte budget (upstream #1342).
//!
//! Upstream's `draw_text` charges a text blob per draw and the typeface it
//! keeps alive. Unsnapped text records glyph outline paths instead (only
//! color and bitmap glyphs stay text), so it is also charged with what the
//! painter reports drawing, from the hook at the end of `draw_text`.

use super::super::Context;
use crate::page_recorder::{BYTES_PER_RECORDED_OP, RasterKey};
use crate::sk::effing::text::{Painted, take_text_painted};

/// What a typeface a recording keeps alive is charged, as `draw_text` does.
const TYPEFACE_BYTES: usize = 1024 * 1024;

impl Context {
  /// Charges the recording with what the painter drew: each draw op and
  /// outline path, and, once per window, each typeface a text-blob run keeps
  /// alive. Outline paths keep no typeface alive.
  pub(super) fn account_painted(&self, painted: &Painted) {
    self.account_recorded_bytes(painted.bytes + painted.ops * BYTES_PER_RECORDED_OP);
    let listed = painted.listed_typefaces();
    for &id in listed {
      self.account_raster_resource(
        RasterKey::Typeface {
          key: typeface_key(id),
        },
        TYPEFACE_BYTES,
      );
    }
    // Ones past the listed few can't be told apart: charge them every time.
    self.account_raster_bytes((painted.typeface_count - listed.len()) * TYPEFACE_BYTES);
  }

  /// The `draw_text` hook: charges what `fillText`/`strokeText` drew under
  /// `geometricPrecision`, on top of upstream's text-blob charge, which stays
  /// as a bound. Other text draws leave nothing to charge.
  pub(crate) fn account_unsnapped_text(&self) {
    let painted = take_text_painted();
    if painted.ops > 0 {
      self.account_painted(&painted);
    }
  }
}

/// A `RasterKey::Typeface` key for a typeface's SkTypeface::uniqueID(). The
/// keys `draw_text` charges hash a font descriptor instead; the two can alias
/// only by a hash collision.
fn typeface_key(id: u32) -> u64 {
  use std::hash::{Hash, Hasher};
  let mut hasher = std::collections::hash_map::DefaultHasher::new();
  "effing typeface".hash(&mut hasher);
  id.hash(&mut hasher);
  hasher.finish()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::global_fonts::get_font;
  use crate::sk::{ColorSpace, TextRendering};

  const MAX_WIDTH: f32 = 100_000.0;

  fn ctx(font: &str, text_rendering: TextRendering) -> Context {
    {
      let fonts = get_font().unwrap();
      fonts.register_from_path::<String>("__test__/fonts/Lato-Regular.ttf", None);
      fonts.register_from_path("__test__/fonts/COLR-v1.ttf", Some("Colrv1".to_owned()));
    }
    let mut ctx = Context::new(64, 64, ColorSpace::default()).expect("raster context");
    ctx.set_font(font.to_owned()).unwrap();
    ctx.state.text_rendering = text_rendering;
    ctx
  }

  fn pending(ctx: &Context) -> usize {
    ctx.page_recorder.as_ref().unwrap().borrow().pending_bytes()
  }

  /// What one fillText of `text` charges.
  fn fill_text_charge(ctx: &mut Context, text: &str) -> usize {
    let before = pending(ctx);
    ctx.fill_text(text, 0.0, 16.0, MAX_WIDTH).unwrap();
    pending(ctx) - before
  }

  // Under geometricPrecision the glyphs are recorded as outline paths, which
  // the text-blob charge alone doesn't cover.
  #[test]
  fn geometric_precision_text_charges_its_outline_paths() {
    let mut hinted = ctx("16px Lato", TextRendering::Auto);
    let mut unsnapped = ctx("16px Lato", TextRendering::GeometricPrecision);
    for _ in 0..2 {
      let hinted_charge = fill_text_charge(&mut hinted, "hello");
      let unsnapped_charge = fill_text_charge(&mut unsnapped, "hello");
      // Five glyph outlines: well over a point per glyph at 16 B each.
      assert!(unsnapped_charge > hinted_charge + BYTES_PER_RECORDED_OP + 5 * 16);
    }
    // The hook took the tally; nothing is left over for the next draw.
    assert_eq!(take_text_painted().ops, 0);
  }

  // Color glyphs stay text blobs, which keep their typeface alive: charged
  // once per window by the typeface's ID.
  #[test]
  fn geometric_precision_text_charges_a_text_blob_typeface_once() {
    let mut ctx = ctx("100px Colrv1", TextRendering::GeometricPrecision);
    ctx.fill_text("abc", 0.0, 100.0, MAX_WIDTH).unwrap();
    ctx.fill_text("abc", 0.0, 100.0, MAX_WIDTH).unwrap();
    let recorder = ctx.page_recorder.as_ref().unwrap().borrow();
    // draw_text's own descriptor-keyed charge, and the blob typeface's.
    assert_eq!(recorder.retained_raster_count(), 2);
    assert_eq!(recorder.retained_raster_bytes(), 2 * TYPEFACE_BYTES);
  }
}
