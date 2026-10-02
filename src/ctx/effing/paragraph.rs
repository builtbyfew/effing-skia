//! The paragraph primitive: `new Paragraph(text, style)` lays out a
//! single-style paragraph natively, with inline placeholder boxes where the
//! text is an array, `layout(width)` reports its lines, and
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
use crate::sk::effing::paragraph::{
  Paragraph as SkParagraph, ParagraphOptions, Placeholder, PlaceholderAlign,
};
use crate::sk::effing::text::Painted;
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
  /// Line box height in px, where 0 collapses the line boxes; omitted or null
  /// for `normal` (hhea ascent + descent).
  pub line_height: Option<Either<f64, Null>>,
  /// `left`, `right`, `center`, `justify`, or `start` / `end`, which follow
  /// `direction`.
  pub text_align: Option<String>,
  /// `ltr` or `rtl`.
  pub direction: Option<String>,
  /// Break only at hard line breaks.
  pub no_wrap: Option<bool>,
  /// A whole number of lines; omitted or 0 for unlimited.
  pub max_lines: Option<f64>,
  /// Appended where text is truncated by `maxLines` or `noWrap`, e.g. `…`.
  pub ellipsis: Option<String>,
  /// Count spaces and tabs before a hard break or the end of the text in the
  /// line's width and alignment instead of hanging them, as CSS
  /// `white-space: pre` and `pre-wrap` do. Spaces at a soft wrap still hang.
  pub keep_trailing_whitespace: Option<bool>,
}

/// An inline box in a paragraph's text, e.g. for an image: it takes `width`
/// on its line, can break from the text on either side, and draws nothing.
#[napi(object)]
pub struct ParagraphPlaceholder {
  pub width: f64,
  pub height: f64,
  /// A CSS `vertical-align` keyword: `baseline` (the default), `middle`,
  /// `top`, `bottom`, `text-top` or `text-bottom`.
  pub vertical_align: Option<String>,
  /// For `baseline`: the distance from the box's top down to its own
  /// baseline, which sits on the text's. Defaults to `height`, the bottom
  /// edge, as for an image.
  pub baseline_offset: Option<f64>,
}

/// Where layout put a placeholder, from the paragraph's top-left corner.
#[napi(object)]
pub struct ParagraphPlaceholderBox {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
  /// The index of its line in `lines`.
  pub line: u32,
}

#[napi(object)]
pub struct ParagraphLine {
  /// Left edge of the line, alignment included.
  pub left: f64,
  /// Advance width without trailing whitespace unless it is kept, letter
  /// spacing included.
  pub width: f64,
  /// Baseline, from the top of the paragraph.
  pub baseline: f64,
  /// UTF-16 offsets of the line's text (JS string indices), trailing whitespace
  /// excluded unless it is kept.
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
  /// One per placeholder, in order; null for one that `maxLines` or an
  /// ellipsis cut off.
  pub placeholders: Vec<Option<ParagraphPlaceholderBox>>,
}

impl FromStr for PlaceholderAlign {
  type Err = SkError;

  fn from_str(value: &str) -> result::Result<Self, SkError> {
    match value {
      "baseline" => Ok(Self::Baseline),
      "middle" => Ok(Self::Middle),
      "top" => Ok(Self::Top),
      "bottom" => Ok(Self::Bottom),
      "text-top" => Ok(Self::TextTop),
      "text-bottom" => Ok(Self::TextBottom),
      _ => Err(SkError::Generic(format!(
        "{value} is not a valid placeholder verticalAlign"
      ))),
    }
  }
}

/// A finite px value that stays finite as the f32 the bridge takes.
fn finite_f32(value: f64) -> Option<f32> {
  let narrowed = value as f32;
  narrowed.is_finite().then_some(narrowed)
}

fn invalid(message: String) -> Error {
  Error::new(Status::InvalidArg, message)
}

/// A JS type's name as `typeof` would put it, near enough.
fn type_name(value_type: ValueType) -> String {
  value_type.to_string().to_lowercase()
}

/// Checks `spec` and places it at `offset`, a UTF-8 offset in the text.
fn placeholder_at(offset: usize, spec: &ParagraphPlaceholder) -> Result<Placeholder> {
  let size = |name: &str, value: f64| match finite_f32(value) {
    Some(size) if size >= 0.0 => Ok(size),
    _ => Err(invalid(format!(
      "A placeholder's {name} must be a finite number ≥ 0, not {value}"
    ))),
  };
  let width = size("width", spec.width)?;
  let height = size("height", spec.height)?;
  let baseline_offset = match spec.baseline_offset {
    None => height,
    Some(value) => finite_f32(value).ok_or_else(|| {
      invalid(format!(
        "A placeholder's baselineOffset must be a finite number, not {value}"
      ))
    })?,
  };
  Ok(Placeholder {
    offset,
    width,
    height,
    align: spec
      .vertical_align
      .as_deref()
      .map_or(Ok(PlaceholderAlign::Baseline), PlaceholderAlign::from_str)?,
    baseline_offset,
  })
}

/// A part of a paragraph's content: a run of text or a placeholder.
pub enum ContentPart {
  Text(String),
  Placeholder(ParagraphPlaceholder),
}

/// A paragraph's content as its text and the placeholders in it, each at the
/// UTF-8 offset where it sits.
fn split_content(parts: Vec<ContentPart>) -> Result<(String, Vec<Placeholder>)> {
  let mut text = String::new();
  let mut placeholders = Vec::new();
  for (i, part) in parts.into_iter().enumerate() {
    match part {
      ContentPart::Text(run) => text.push_str(&run),
      ContentPart::Placeholder(spec) => placeholders.push(
        placeholder_at(text.len(), &spec)
          .map_err(|err| invalid(format!("Paragraph text item {i}: {}", err.reason)))?,
      ),
    }
  }
  Ok((text, placeholders))
}

/// A property of a placeholder object, where `undefined` and `null` are
/// `None`.
fn optional_property<T: FromNapiValue>(
  object: &Object,
  name: &str,
  expected: (ValueType, &str),
) -> Result<Option<T>> {
  let value: Unknown = object.get_named_property(name)?;
  match value.get_type()? {
    ValueType::Undefined | ValueType::Null => Ok(None),
    found if found == expected.0 => Ok(Some(unsafe { value.cast::<T>() }?)),
    found => Err(invalid(format!(
      "A placeholder's {name} must be {}, not {}",
      expected.1,
      type_name(found)
    ))),
  }
}

/// Reads a placeholder object, with a message naming whatever is wrong.
fn read_placeholder(object: &Object) -> Result<ParagraphPlaceholder> {
  const NUMBER: (ValueType, &str) = (ValueType::Number, "a number");
  const STRING: (ValueType, &str) = (ValueType::String, "a string");
  let required = |name: &str| {
    optional_property::<f64>(object, name, NUMBER)?
      .ok_or_else(|| invalid(format!("A placeholder needs a {name}")))
  };
  Ok(ParagraphPlaceholder {
    width: required("width")?,
    height: required("height")?,
    vertical_align: optional_property(object, "verticalAlign", STRING)?,
    baseline_offset: optional_property(object, "baselineOffset", NUMBER)?,
  })
}

/// Reads a paragraph's content from JS: a string, or an array of strings and
/// placeholder objects. Read by hand rather than as an `Either`, whose error
/// would hide which part is wrong.
fn read_content(value: Unknown) -> Result<Vec<ContentPart>> {
  let not_content = |found: &str| {
    invalid(format!(
      "A Paragraph's text must be a string or an array of strings and placeholders, not {found}"
    ))
  };
  match value.get_type()? {
    ValueType::String => return Ok(vec![ContentPart::Text(unsafe { value.cast()? })]),
    ValueType::Object => {}
    found => return Err(not_content(&type_name(found))),
  }
  let array: Object = unsafe { value.cast()? };
  if !array.is_array()? {
    return Err(not_content("an object"));
  }
  let mut parts = Vec::new();
  for i in 0..array.get_array_length()? {
    let item: Unknown = array.get_element(i)?;
    let part = match item.get_type()? {
      ValueType::String => ContentPart::Text(unsafe { item.cast()? }),
      ValueType::Object => {
        let object: Object = unsafe { item.cast()? };
        if object.is_array()? {
          return Err(invalid(format!(
            "Paragraph text item {i} is an array; nested arrays are not allowed"
          )));
        }
        ContentPart::Placeholder(
          read_placeholder(&object)
            .map_err(|err| invalid(format!("Paragraph text item {i}: {}", err.reason)))?,
        )
      }
      found => {
        return Err(invalid(format!(
          "Paragraph text item {i} must be a string or a placeholder, not {}",
          type_name(found)
        )));
      }
    };
    parts.push(part);
  }
  Ok(parts)
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
  /// `text` is a string, or an array of strings and placeholders.
  #[napi(
    constructor,
    ts_args_type = "text: string | Array<string | ParagraphPlaceholder>, style: ParagraphStyle"
  )]
  pub fn new(text: Unknown, style: ParagraphStyle) -> Result<Self> {
    Self::with_content(read_content(text)?, style)
  }

  fn with_content(content: Vec<ContentPart>, style: ParagraphStyle) -> Result<Self> {
    let (text, placeholders) = split_content(content)?;
    let font_size = match finite_f32(style.font_size) {
      Some(size) if size > 0.0 => size,
      _ => {
        return Err(invalid(format!(
          "fontSize must be a finite number > 0, not {}",
          style.font_size
        )));
      }
    };
    let letter_spacing = style.letter_spacing.unwrap_or(0.0);
    let letter_spacing = finite_f32(letter_spacing).ok_or_else(|| {
      invalid(format!(
        "letterSpacing must be a finite number, not {letter_spacing}"
      ))
    })?;
    // Read as a double: napi would wrap a negative or huge number into a u32,
    // which could come out as 0, unlimited.
    let max_lines = style.max_lines.unwrap_or(0.0);
    if !(max_lines >= 0.0 && max_lines <= i32::MAX as f64 && max_lines.fract() == 0.0) {
      return Err(invalid(format!(
        "maxLines must be a whole number from 0 to {}, not {max_lines}",
        i32::MAX
      )));
    }
    let max_lines = max_lines as u32;
    let options = ParagraphOptions {
      font_size,
      weight: style.font_weight.unwrap_or(400),
      style: style
        .font_style
        .as_deref()
        .map_or(Ok(FontStyle::Normal), FontStyle::from_str)?,
      letter_spacing,
      line_height: match style.line_height {
        Some(Either::A(height)) => match finite_f32(height) {
          Some(height) if height >= 0.0 => Some(height),
          _ => {
            return Err(invalid(format!(
              "lineHeight must be a finite number ≥ 0, not {height}"
            )));
          }
        },
        Some(Either::B(Null)) | None => None,
      },
      align: style
        .text_align
        .as_deref()
        .map_or(Ok(TextAlign::Left), TextAlign::from_str)?,
      direction: style
        .direction
        .as_deref()
        .map_or(Ok(TextDirection::Ltr), TextDirection::from_str)?,
      nowrap: style.no_wrap.unwrap_or(false),
      max_lines,
      ellipsis: style.ellipsis.as_deref(),
      keep_trailing_whitespace: style.keep_trailing_whitespace.unwrap_or(false),
    };
    // Font lookup goes through the shared collection, which font registration
    // mutates under the same lock.
    let collection = get_font().map_err(SkError::from)?;
    let inner = SkParagraph::new(
      &text,
      &placeholders,
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
    let placeholders = self
      .inner
      .placeholders()
      .into_iter()
      .map(|placeholder| {
        placeholder.visible.then(|| ParagraphPlaceholderBox {
          x: placeholder.x as f64,
          y: placeholder.y as f64,
          width: placeholder.width as f64,
          height: placeholder.height as f64,
          line: placeholder.line.max(0) as u32,
        })
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
      placeholders,
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
  /// a paragraph drew: the paint's resources, unless nothing was drawn, and
  /// what each pass drew (see `account_painted`).
  fn account_paragraph_passes(&self, passes: &[Painted], source: ShadowSource) {
    if passes.iter().all(|pass| pass.ops == 0) {
      return;
    }
    match source {
      ShadowSource::Fill => self.account_paint_resources(&self.state.fill_style),
      ShadowSource::Stroke => self.account_paint_resources(&self.state.stroke_style),
      ShadowSource::Image => unreachable!("draw_paragraph is only reached via fill/stroke"),
    }
    for pass in passes {
      self.account_painted(pass);
    }
  }
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
  use crate::page_recorder::BYTES_PER_RECORDED_OP;
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
      keep_trailing_whitespace: None,
    }
  }

  fn laid_out_paragraph(text: &str) -> Paragraph {
    {
      let fonts = get_font().unwrap();
      fonts.register_from_path::<String>("__test__/fonts/Lato-Regular.ttf", None);
    }
    let content = vec![ContentPart::Text(text.to_owned())];
    let mut paragraph = Paragraph::with_content(content, style("Lato")).unwrap();
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
    let content = vec![ContentPart::Text("abc".to_owned())];
    let mut paragraph = Paragraph::with_content(content, style("Colrv1")).unwrap();
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

  // A placeholder draws nothing, so a paragraph of placeholders alone
  // charges no more than an empty one.
  #[test]
  fn draw_paragraph_of_placeholders_charges_nothing() {
    laid_out_paragraph("");
    let placeholder = || {
      ContentPart::Placeholder(ParagraphPlaceholder {
        width: 16.0,
        height: 16.0,
        vertical_align: None,
        baseline_offset: None,
      })
    };
    let content = vec![placeholder(), placeholder()];
    let mut paragraph = Paragraph::with_content(content, style("Lato")).unwrap();
    let layout = paragraph.layout(64.0).unwrap();
    assert_eq!(layout.placeholders.iter().flatten().count(), 2);
    let mut ctx = Context::new(64, 64, ColorSpace::default()).expect("raster context");
    let pending0 = recorder(&ctx).pending_bytes();
    fill(&mut ctx, &paragraph);
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
