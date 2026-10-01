//! The paragraph primitive: `skia-c/effing/paragraph.cpp`.

use std::ffi::{CString, NulError};

use super::super::{Canvas, FontCollection, Paint, TextAlign, TextDirection};
use crate::font::FontStyle;

#[allow(non_camel_case_types)]
mod ffi {
  use std::ffi::c_char;

  use super::{ParagraphLine, ParagraphMetrics};
  use crate::sk::ffi::{skiac_canvas, skiac_font_collection, skiac_paint};

  #[repr(C)]
  pub struct effing_paragraph {
    _unused: [u8; 0],
  }

  #[repr(C)]
  pub struct effing_paragraph_style {
    pub font_size: f32,
    pub weight: i32,
    pub slant: i32,
    pub letter_spacing: f32,
    pub line_height: f32,
    pub align: i32,
    pub direction: i32,
    pub nowrap: bool,
    pub max_lines: i32,
    pub ellipsis: *const c_char,
    pub ellipsis_len: usize,
  }

  unsafe extern "C" {
    pub fn effing_paragraph_create(
      text: *const c_char,
      text_len: usize,
      collection: *mut skiac_font_collection,
      font_family: *const c_char,
      style: *const effing_paragraph_style,
    ) -> *mut effing_paragraph;
    pub fn effing_paragraph_layout(p: *mut effing_paragraph, width: f32);
    pub fn effing_paragraph_get_metrics(p: *mut effing_paragraph, metrics: *mut ParagraphMetrics);
    pub fn effing_paragraph_get_lines(
      p: *mut effing_paragraph,
      lines: *mut ParagraphLine,
      count: i32,
    );
    pub fn effing_paragraph_paint(
      p: *mut effing_paragraph,
      canvas: *mut skiac_canvas,
      paint: *mut skiac_paint,
      x: f32,
      y: f32,
    );
    pub fn effing_paragraph_destroy(p: *mut effing_paragraph);
  }
}

/// A paragraph's style: everything but its text and font family.
#[derive(Debug, Clone, Copy)]
pub struct ParagraphOptions<'a> {
  pub font_size: f32,
  pub weight: u32,
  pub style: FontStyle,
  pub letter_spacing: f32,
  /// Line box height in px; 0 for `normal` (hhea ascender + descender).
  pub line_height: f32,
  /// `Start` and `End` follow `direction`.
  pub align: TextAlign,
  pub direction: TextDirection,
  /// Only break at hard breaks.
  pub nowrap: bool,
  /// 0 for unlimited.
  pub max_lines: u32,
  /// Appended where text is truncated.
  pub ellipsis: Option<&'a str>,
}

/// Mirrors `effing_paragraph_metrics`.
#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
pub struct ParagraphMetrics {
  pub height: f32,
  pub longest_line: f32,
  pub min_intrinsic_width: f32,
  pub max_intrinsic_width: f32,
  pub did_exceed_max_lines: bool,
  pub line_count: i32,
  pub line_height: f32,
  /// The primary font's hhea ascender and descender, in px.
  pub ascent: f32,
  pub descent: f32,
}

/// Mirrors `effing_paragraph_line`.
#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
pub struct ParagraphLine {
  /// Left edge of the line, alignment included.
  pub left: f32,
  /// Advance width without trailing whitespace, letter spacing included.
  pub width: f32,
  /// Baseline, from the top of the paragraph.
  pub baseline: f32,
  /// UTF-16 offsets of the line's text (JS string indices), trailing whitespace excluded.
  pub start_index: usize,
  pub end_index: usize,
  pub hard_break: bool,
}

/// A single-style paragraph laid out by SkParagraph. Line boxes are exactly
/// `line_height` tall with the baseline placed by CSS half-leading, and the
/// glyphs are painted unsnapped.
pub struct Paragraph {
  ptr: *mut ffi::effing_paragraph,
  laid_out: bool,
}

impl Paragraph {
  /// `font_family` is a comma-separated list of family names, unquoted.
  pub fn new(
    text: &str,
    font_family: &str,
    collection: &FontCollection,
    options: &ParagraphOptions,
  ) -> Result<Self, NulError> {
    let c_family = CString::new(font_family)?;
    // The text and ellipsis go by length, so they may contain NUL.
    let ellipsis = options.ellipsis.unwrap_or("");
    let style = ffi::effing_paragraph_style {
      font_size: options.font_size,
      weight: options.weight as i32,
      slant: options.style as i32,
      letter_spacing: options.letter_spacing,
      line_height: options.line_height,
      align: options.align as i32,
      direction: options.direction.as_sk_direction(),
      nowrap: options.nowrap,
      max_lines: options.max_lines as i32,
      ellipsis: ellipsis.as_ptr().cast(),
      ellipsis_len: ellipsis.len(),
    };
    let ptr = unsafe {
      ffi::effing_paragraph_create(
        text.as_ptr().cast(),
        text.len(),
        collection.0,
        c_family.as_ptr(),
        &style,
      )
    };
    Ok(Paragraph {
      ptr,
      laid_out: false,
    })
  }

  /// Lays the text out in `width` px; non-positive or non-finite means
  /// unbounded. Must precede `metrics`, `lines` and painting.
  pub fn layout(&mut self, width: f32) {
    unsafe { ffi::effing_paragraph_layout(self.ptr, width) }
    self.laid_out = true;
  }

  /// Whether `layout` has run, which painting requires.
  pub fn is_laid_out(&self) -> bool {
    self.laid_out
  }

  pub fn metrics(&self) -> ParagraphMetrics {
    let mut metrics = ParagraphMetrics::default();
    unsafe { ffi::effing_paragraph_get_metrics(self.ptr, &mut metrics) };
    metrics
  }

  pub fn lines(&self) -> Vec<ParagraphLine> {
    let count = self.metrics().line_count.max(0) as usize;
    let mut lines = vec![ParagraphLine::default(); count];
    unsafe { ffi::effing_paragraph_get_lines(self.ptr, lines.as_mut_ptr(), count as i32) };
    lines
  }
}

impl Drop for Paragraph {
  fn drop(&mut self) {
    unsafe { ffi::effing_paragraph_destroy(self.ptr) }
  }
}

impl Canvas {
  /// Paints a laid-out paragraph's glyphs with `paint`, its top-left corner
  /// at (x, y).
  pub fn draw_paragraph(&mut self, paragraph: &Paragraph, x: f32, y: f32, paint: &Paint) {
    unsafe { ffi::effing_paragraph_paint(paragraph.ptr, self.0, paint.0, x, y) }
  }
}
