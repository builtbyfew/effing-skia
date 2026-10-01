//! The paragraph primitive: `new Paragraph(text, style)` lays out a
//! single-style paragraph natively, `layout(width)` reports its lines, and
//! `fillParagraph(ctx, …)` / `strokeParagraph(ctx, …)` from `extensions.js`
//! paint it with the context's current paint, shadow, filter, clip and
//! transform.

use std::cell::RefCell;
use std::result;
use std::str::FromStr;

use napi::bindgen_prelude::*;

use super::super::{CanvasRenderingContext2D, Context, DrawContent, ShadowSource};
use crate::error::SkError;
use crate::font::FontStyle;
use crate::global_fonts::get_font;
use crate::page_recorder::{BYTES_PER_RECORDED_OP, RasterKey};
use crate::sk::effing::paragraph::{Paragraph as SkParagraph, ParagraphOptions, ParagraphPainted};
use crate::sk::{Paint, TextAlign, TextDirection};

#[napi(object)]
pub struct ParagraphStyle {
  /// CSS font-family list, e.g. `"Inter", sans-serif`.
  pub font_family: String,
  pub font_size: f64,
  /// Defaults to 400.
  pub font_weight: Option<u32>,
  /// `normal`, `italic` or `oblique`.
  pub font_style: Option<String>,
  pub letter_spacing: Option<f64>,
  /// Line box height in px; omitted or 0 for `normal` (hhea ascent + descent).
  pub line_height: Option<f64>,
  /// `left`, `right`, `center`, `justify`, or `start` / `end`, which follow
  /// `direction`.
  pub text_align: Option<String>,
  /// `ltr` or `rtl`.
  pub direction: Option<String>,
  /// Break only at hard line breaks.
  pub no_wrap: Option<bool>,
  pub max_lines: Option<u32>,
  /// Appended where text is truncated by `maxLines` or `noWrap`, e.g. `…`.
  pub ellipsis: Option<String>,
}

#[napi(object)]
pub struct ParagraphLine {
  /// Left edge of the line, alignment included.
  pub left: f64,
  /// Advance width without trailing whitespace, letter spacing included.
  pub width: f64,
  /// Baseline, from the top of the paragraph.
  pub baseline: f64,
  /// UTF-16 offsets of the line's text (JS string indices), trailing whitespace excluded.
  pub start_index: u32,
  pub end_index: u32,
  pub hard_break: bool,
}

#[napi(object)]
pub struct ParagraphLayout {
  /// `lines.length * lineHeight`.
  pub height: f64,
  pub longest_line: f64,
  pub min_intrinsic_width: f64,
  pub max_intrinsic_width: f64,
  pub did_exceed_max_lines: bool,
  /// Every line box is exactly this tall.
  pub line_height: f64,
  /// The primary font's hhea ascender and descender in px.
  pub ascent: f64,
  pub descent: f64,
  pub lines: Vec<ParagraphLine>,
}

/// A CSS font-family list as the comma-separated, unquoted names the bridge
/// takes, the way `ctx.font` families are normalized.
fn normalize_font_family(list: &str) -> String {
  list
    .split(',')
    .map(str::trim)
    .map(|name| name.trim_matches(|c| c == '"' || c == '\''))
    .filter(|name| !name.is_empty())
    .collect::<Vec<_>>()
    .join(",")
}

#[napi]
pub struct Paragraph {
  inner: SkParagraph,
}

#[napi]
impl Paragraph {
  #[napi(constructor)]
  pub fn new(text: String, style: ParagraphStyle) -> Result<Self> {
    let options = ParagraphOptions {
      font_size: style.font_size as f32,
      weight: style.font_weight.unwrap_or(400),
      style: style
        .font_style
        .as_deref()
        .map_or(Ok(FontStyle::Normal), FontStyle::from_str)?,
      letter_spacing: style.letter_spacing.unwrap_or(0.0) as f32,
      line_height: style.line_height.unwrap_or(0.0) as f32,
      align: style
        .text_align
        .as_deref()
        .map_or(Ok(TextAlign::Left), TextAlign::from_str)?,
      direction: style
        .direction
        .as_deref()
        .map_or(Ok(TextDirection::Ltr), TextDirection::from_str)?,
      nowrap: style.no_wrap.unwrap_or(false),
      max_lines: style.max_lines.unwrap_or(0),
      ellipsis: style.ellipsis.as_deref(),
    };
    // Font lookup goes through the shared collection, which font registration
    // mutates under the same lock.
    let collection = get_font().map_err(SkError::from)?;
    let inner = SkParagraph::new(
      &text,
      &normalize_font_family(&style.font_family),
      &collection,
      &options,
    )
    .map_err(SkError::from)?;
    Ok(Paragraph { inner })
  }

  /// Lays the paragraph out in `width` px (non-finite or ≤ 0 for unbounded)
  /// and reports its lines.
  #[napi]
  pub fn layout(&mut self, width: f64) -> Result<ParagraphLayout> {
    // Shaping resolves fonts and fallback from the shared collection; hold its
    // lock so a concurrent registration can't mutate it meanwhile.
    let _collection = get_font().map_err(SkError::from)?;
    self.inner.layout(width as f32);
    let metrics = self.inner.metrics();
    let lines = self
      .inner
      .lines()
      .into_iter()
      .map(|line| ParagraphLine {
        left: line.left as f64,
        width: line.width as f64,
        baseline: line.baseline as f64,
        start_index: line.start_index as u32,
        end_index: line.end_index as u32,
        hard_break: line.hard_break,
      })
      .collect();
    Ok(ParagraphLayout {
      height: metrics.height as f64,
      longest_line: metrics.longest_line as f64,
      min_intrinsic_width: metrics.min_intrinsic_width as f64,
      max_intrinsic_width: metrics.max_intrinsic_width as f64,
      did_exceed_max_lines: metrics.did_exceed_max_lines,
      line_height: metrics.line_height as f64,
      ascent: metrics.ascent as f64,
      descent: metrics.descent as f64,
      lines,
    })
  }
}

impl Context {
  fn draw_paragraph(
    &mut self,
    paragraph: &SkParagraph,
    x: f32,
    y: f32,
    paint: &Paint,
    source: ShadowSource,
  ) -> result::Result<(), SkError> {
    // What each pass drew, charged to the recording once they are done.
    let passes = RefCell::new(Vec::new());
    let shadow_paint = self.shadow_paint(paint, source, DrawContent::Glyphs);
    let (shadow_offset_x, shadow_offset_y) = self.canvas_shadow_offset(source, DrawContent::Glyphs);
    self.with_shadowed_render_canvas(
      paint,
      DrawContent::Glyphs,
      shadow_paint.as_ref(),
      |shadow_canvas, shadow_paint, device_ctm| {
        shadow_canvas.save();
        Self::apply_shadow_offset_matrix_to_canvas(
          shadow_canvas,
          device_ctm,
          shadow_offset_x,
          shadow_offset_y,
        )?;
        let painted = shadow_canvas.draw_paragraph(paragraph, x, y, shadow_paint);
        passes.borrow_mut().push(painted);
        shadow_canvas.restore();
        Ok(())
      },
      |canvas, paint| {
        let painted = canvas.draw_paragraph(paragraph, x, y, paint);
        passes.borrow_mut().push(painted);
        Ok(())
      },
    )?;
    self.account_paragraph_passes(&passes.into_inner(), source);
    self.flush_if_recording_limit_exceeded();
    Ok(())
  }

  /// Charges the recording's byte budget (upstream #1342) with what painting
  /// a paragraph drew: the paint's resources, unless nothing was drawn; each
  /// draw op and outline path; and 1 MiB, once per window, for each typeface
  /// a text-blob run (color or bitmap glyphs) keeps alive. Outline paths keep
  /// no typeface alive.
  fn account_paragraph_passes(&self, passes: &[ParagraphPainted], source: ShadowSource) {
    if passes.iter().all(|pass| pass.ops == 0) {
      return;
    }
    match source {
      ShadowSource::Fill => self.account_paint_resources(&self.state.fill_style),
      ShadowSource::Stroke => self.account_paint_resources(&self.state.stroke_style),
      ShadowSource::Image => unreachable!("draw_paragraph is only reached via fill/stroke"),
    }
    const TYPEFACE_BYTES: usize = 1024 * 1024;
    for pass in passes {
      self.account_recorded_bytes(pass.bytes + pass.ops * BYTES_PER_RECORDED_OP);
      let listed = pass.listed_typefaces();
      for &id in listed {
        self.account_raster_resource(
          RasterKey::Typeface {
            key: typeface_key(id),
          },
          TYPEFACE_BYTES,
        );
      }
      // Ones past the listed few can't be told apart: charge them every time.
      self.account_raster_bytes((pass.typeface_count - listed.len()) * TYPEFACE_BYTES);
    }
  }
}

/// A `RasterKey::Typeface` key for a typeface's SkTypeface::uniqueID(). The
/// keys `fillText` charges hash a font descriptor instead; the two can alias
/// only by a hash collision.
fn typeface_key(id: u32) -> u64 {
  use std::hash::{Hash, Hasher};
  let mut hasher = std::collections::hash_map::DefaultHasher::new();
  "effing typeface".hash(&mut hasher);
  id.hash(&mut hasher);
  hasher.finish()
}

/// The paragraph to paint, or an error naming `function` when `layout` has
/// not run yet: the native side has no lines to place until it has.
fn laid_out<'a>(paragraph: &'a Paragraph, function: &str) -> Result<&'a SkParagraph> {
  if !paragraph.inner.is_laid_out() {
    return Err(Error::new(
      Status::GenericFailure,
      format!("{function}() needs a laid-out Paragraph: call layout(width) first"),
    ));
  }
  Ok(&paragraph.inner)
}

// Exposed as functions taking the context rather than as methods on it, so the
// context's own surface stays identical to upstream's; see extensions.js.

/// Fills a laid-out paragraph's glyphs on `ctx` with its current fill style,
/// the paragraph's top-left corner at (x, y).
#[napi]
pub fn fill_paragraph(
  ctx: &mut CanvasRenderingContext2D,
  paragraph: &Paragraph,
  x: f64,
  y: f64,
) -> Result<()> {
  let paragraph = laid_out(paragraph, "fillParagraph")?;
  ctx.context.flush_if_recording_limit_exceeded();
  let paint = ctx.context.fill_paint()?;
  ctx
    .context
    .draw_paragraph(paragraph, x as f32, y as f32, &paint, ShadowSource::Fill)?;
  Ok(())
}

/// Strokes a laid-out paragraph's glyph outlines on `ctx` with its current
/// stroke style and line settings, the paragraph's top-left corner at (x, y).
#[napi]
pub fn stroke_paragraph(
  ctx: &mut CanvasRenderingContext2D,
  paragraph: &Paragraph,
  x: f64,
  y: f64,
) -> Result<()> {
  let paragraph = laid_out(paragraph, "strokeParagraph")?;
  ctx.context.flush_if_recording_limit_exceeded();
  let paint = ctx.context.stroke_paint()?;
  ctx
    .context
    .draw_paragraph(paragraph, x as f32, y as f32, &paint, ShadowSource::Stroke)?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::sk::ColorSpace;

  fn style(font_family: &str) -> ParagraphStyle {
    ParagraphStyle {
      font_family: font_family.to_owned(),
      font_size: 16.0,
      font_weight: None,
      font_style: None,
      letter_spacing: None,
      line_height: None,
      text_align: None,
      direction: None,
      no_wrap: None,
      max_lines: None,
      ellipsis: None,
    }
  }

  fn laid_out_paragraph(text: &str) -> Paragraph {
    {
      let fonts = get_font().unwrap();
      fonts.register_from_path::<String>("__test__/fonts/Lato-Regular.ttf", None);
    }
    let mut paragraph = Paragraph::new(text.to_owned(), style("Lato")).unwrap();
    paragraph.layout(64.0).unwrap();
    paragraph
  }

  fn recorder(ctx: &Context) -> std::cell::Ref<'_, crate::page_recorder::PageRecorder> {
    ctx.page_recorder.as_ref().unwrap().borrow()
  }

  fn fill(ctx: &mut Context, paragraph: &Paragraph) {
    let paint = ctx.fill_paint().unwrap();
    ctx
      .draw_paragraph(&paragraph.inner, 0.0, 0.0, &paint, ShadowSource::Fill)
      .unwrap();
  }

  // Lato's glyphs have outlines, so each paint records outline paths, which
  // keep no typeface alive.
  #[test]
  fn draw_paragraph_charges_its_outline_paths() {
    let paragraph = laid_out_paragraph("hello");
    let mut ctx = Context::new(64, 64, ColorSpace::default()).expect("raster context");
    let pending0 = recorder(&ctx).pending_bytes();
    fill(&mut ctx, &paragraph);
    let pending1 = recorder(&ctx).pending_bytes();
    fill(&mut ctx, &paragraph);
    let pending2 = recorder(&ctx).pending_bytes();
    // Five glyph outlines: well over a point per glyph at 16 B each.
    assert!(pending1 - pending0 > BYTES_PER_RECORDED_OP + 5 * 16);
    assert_eq!(pending2 - pending1, pending1 - pending0);
    assert_eq!(recorder(&ctx).retained_raster_count(), 0);
  }

  // Color glyphs have no outline and are drawn as text blobs, which keep
  // their typeface alive: charged once per window, like fillText's.
  #[test]
  fn draw_paragraph_charges_a_text_blob_typeface_once() {
    {
      let fonts = get_font().unwrap();
      fonts.register_from_path("__test__/fonts/COLR-v1.ttf", Some("Colrv1".to_owned()));
    }
    let mut paragraph = Paragraph::new("abc".to_owned(), style("Colrv1")).unwrap();
    paragraph.layout(400.0).unwrap();
    let mut ctx = Context::new(64, 64, ColorSpace::default()).expect("raster context");
    fill(&mut ctx, &paragraph);
    fill(&mut ctx, &paragraph);
    assert_eq!(recorder(&ctx).retained_raster_count(), 1);
    assert_eq!(recorder(&ctx).retained_raster_bytes(), 1024 * 1024);
  }

  #[test]
  fn draw_paragraph_of_nothing_charges_no_paint_resources() {
    let paragraph = laid_out_paragraph("");
    let mut ctx = Context::new(64, 64, ColorSpace::default()).expect("raster context");
    let pending0 = recorder(&ctx).pending_bytes();
    fill(&mut ctx, &paragraph);
    // Only the base charge of touching the recording canvas.
    assert!(recorder(&ctx).pending_bytes() - pending0 <= BYTES_PER_RECORDED_OP);
  }

  // A paint whose own charge crosses the cap flushes right away, like the
  // other draws do, rather than at the next op.
  #[test]
  fn draw_paragraph_flushes_once_over_the_cap() {
    let paragraph = laid_out_paragraph("hello");
    let mut ctx = Context::new(64, 64, ColorSpace::default()).expect("raster context");
    ctx
      .page_recorder
      .as_ref()
      .unwrap()
      .borrow_mut()
      .set_recording_limit(1);
    fill(&mut ctx, &paragraph);
    assert_eq!(recorder(&ctx).consolidations(), 1);
  }
}
