//! Effing paragraph primitive: `new Paragraph(text, style)` lays out a
//! single-style paragraph natively, `layout(width)` reports its line metrics,
//! and `ctx.fillParagraph` / `ctx.strokeParagraph` paint it with the context's
//! current paint, shadow, filter, clip and transform.

use std::result;

use napi::bindgen_prelude::*;

use super::{CanvasRenderingContext2D, Context, DrawContent, ShadowSource};
use crate::error::SkError;
use crate::global_fonts::get_font;
use crate::sk::Paint;
use crate::sk::effing::{EffingParagraph, ParagraphOptions};

#[napi(object)]
pub struct ParagraphStyle {
  /// CSS font-family list, e.g. `"Inter", sans-serif`.
  pub font_family: String,
  pub font_size: f64,
  pub font_weight: Option<u32>,
  /// `normal`, `italic` or `oblique`.
  pub font_style: Option<String>,
  pub letter_spacing: Option<f64>,
  /// Line box height in px; omitted or 0 for `normal` (hhea ascent + descent).
  pub line_height: Option<f64>,
  /// `left`, `right`, `center` or `justify` (`start`/`end` follow `direction`).
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
  pub ascent: f64,
  pub descent: f64,
  pub height: f64,
  /// UTF-8 byte offsets of the line's text, trailing whitespace excluded.
  pub start_index: u32,
  pub end_index: u32,
  pub hard_break: bool,
}

#[napi(object)]
pub struct ParagraphLayout {
  pub height: f64,
  pub longest_line: f64,
  pub min_intrinsic_width: f64,
  pub max_intrinsic_width: f64,
  pub did_exceed_max_lines: bool,
  pub line_height: f64,
  /// The primary font's hhea ascender and descender in px.
  pub ascent: f64,
  pub descent: f64,
  pub lines: Vec<ParagraphLine>,
}

#[napi]
pub struct Paragraph {
  inner: EffingParagraph,
}

fn parse_align(align: Option<&str>, rtl: bool) -> Result<i32> {
  Ok(match align.unwrap_or("left") {
    "left" => 0,
    "right" => 1,
    "center" => 2,
    "justify" => 3,
    "start" => i32::from(rtl),
    "end" => i32::from(!rtl),
    other => {
      return Err(Error::new(
        Status::InvalidArg,
        format!("[{other}] is not a valid textAlign"),
      ));
    }
  })
}

#[napi]
impl Paragraph {
  #[napi(constructor)]
  pub fn new(text: String, style: ParagraphStyle) -> Result<Self> {
    let rtl = style.direction.as_deref() == Some("rtl");
    let slant = match style.font_style.as_deref() {
      Some("italic") => 1,
      Some("oblique") => 2,
      _ => 0,
    };
    let options = ParagraphOptions {
      font_size: style.font_size as f32,
      weight: style.font_weight.unwrap_or(400) as i32,
      slant,
      letter_spacing: style.letter_spacing.unwrap_or(0.0) as f32,
      line_height: style.line_height.unwrap_or(0.0) as f32,
      align: parse_align(style.text_align.as_deref(), rtl)?,
      rtl,
      nowrap: style.no_wrap.unwrap_or(false),
      max_lines: style.max_lines.unwrap_or(0) as i32,
      ellipsis: style.ellipsis.as_deref(),
    };
    let font = get_font().map_err(SkError::from)?;
    let inner = EffingParagraph::new(&text, &style.font_family, &font, &options)
      .map_err(|e| Error::new(Status::InvalidArg, format!("{e}")))?;
    Ok(Paragraph { inner })
  }

  /// Lays the paragraph out at `width` (non-finite or ≤ 0 means unbounded).
  #[napi]
  pub fn layout(&mut self, width: f64) -> Result<ParagraphLayout> {
    // Shaping resolves fonts, and fallback, from the shared collection.
    let _font = get_font().map_err(SkError::from)?;
    self.inner.layout(width as f32);
    let m = self.inner.metrics();
    let lines = self
      .inner
      .lines(m.line_count.max(0) as usize)
      .into_iter()
      .map(|l| ParagraphLine {
        left: l.left as f64,
        width: l.width as f64,
        baseline: l.baseline as f64,
        ascent: l.ascent as f64,
        descent: l.descent as f64,
        height: l.height as f64,
        start_index: l.start_index as u32,
        end_index: l.end_index as u32,
        hard_break: l.hard_break,
      })
      .collect();
    Ok(ParagraphLayout {
      height: m.height as f64,
      longest_line: m.longest_line as f64,
      min_intrinsic_width: m.min_intrinsic_width as f64,
      max_intrinsic_width: m.max_intrinsic_width as f64,
      did_exceed_max_lines: m.did_exceed_max_lines,
      line_height: m.line_height as f64,
      ascent: m.ascent as f64,
      descent: m.descent as f64,
      lines,
    })
  }
}

impl Context {
  fn draw_paragraph(
    &mut self,
    paragraph: &EffingParagraph,
    x: f32,
    y: f32,
    paint: &Paint,
    source: ShadowSource,
  ) -> result::Result<(), SkError> {
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
        shadow_canvas.draw_effing_paragraph(paragraph, x, y, shadow_paint);
        shadow_canvas.restore();
        Ok(())
      },
      |canvas, paint| {
        canvas.draw_effing_paragraph(paragraph, x, y, paint);
        Ok(())
      },
    )
  }
}

#[napi]
impl CanvasRenderingContext2D {
  /// Paints a laid-out paragraph with its top-left corner at (x, y), using the
  /// current fill style.
  #[napi]
  pub fn fill_paragraph(&mut self, paragraph: &Paragraph, x: f64, y: f64) -> Result<()> {
    let paint = self.context.fill_paint()?;
    self
      .context
      .draw_paragraph(&paragraph.inner, x as f32, y as f32, &paint, ShadowSource::Fill)?;
    Ok(())
  }

  /// Strokes a laid-out paragraph's glyph outlines with its top-left corner at
  /// (x, y), using the current stroke style and line settings.
  #[napi]
  pub fn stroke_paragraph(&mut self, paragraph: &Paragraph, x: f64, y: f64) -> Result<()> {
    let paint = self.context.stroke_paint()?;
    self.context.draw_paragraph(
      &paragraph.inner,
      x as f32,
      y as f32,
      &paint,
      ShadowSource::Stroke,
    )?;
    Ok(())
  }
}
