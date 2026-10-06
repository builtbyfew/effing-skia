//! The paragraph primitive: `skia-c/effing/paragraph.cpp`.

use std::ffi::{CString, NulError};
use std::str::FromStr;

use super::super::{Canvas, FontCollection, Paint, TextAlign, TextDirection};
use super::text::Painted;
use crate::error::SkError;
use crate::font::FontStyle;

#[allow(non_camel_case_types)]
mod ffi {
  use std::ffi::c_char;

  use super::{Painted, ParagraphLine, ParagraphMetrics, PlaceholderBox};
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
    pub keep_trailing_whitespace: bool,
    pub word_break: i32,
    pub overflow_wrap: i32,
  }

  #[repr(C)]
  pub struct effing_paragraph_placeholder {
    pub offset: usize,
    pub width: f32,
    pub height: f32,
    pub align: i32,
    pub baseline_offset: f32,
    pub line_break: i32,
  }

  unsafe extern "C" {
    pub fn effing_paragraph_create(
      text: *const c_char,
      text_len: usize,
      collection: *mut skiac_font_collection,
      font_family: *const c_char,
      style: *const effing_paragraph_style,
      placeholders: *const effing_paragraph_placeholder,
      placeholder_count: usize,
    ) -> *mut effing_paragraph;
    pub fn effing_paragraph_layout(p: *mut effing_paragraph, width: f32);
    pub fn effing_paragraph_get_metrics(p: *mut effing_paragraph, metrics: *mut ParagraphMetrics);
    pub fn effing_paragraph_get_lines(
      p: *mut effing_paragraph,
      lines: *mut ParagraphLine,
      count: i32,
    );
    pub fn effing_paragraph_get_placeholders(
      p: *mut effing_paragraph,
      boxes: *mut PlaceholderBox,
      count: i32,
    );
    pub fn effing_paragraph_paint(
      p: *mut effing_paragraph,
      canvas: *mut skiac_canvas,
      paint: *mut skiac_paint,
      x: f32,
      y: f32,
      painted: *mut Painted,
    );
    pub fn effing_paragraph_destroy(p: *mut effing_paragraph);
  }
}

/// Where lines may break between letters: CSS `word-break`. Mirrors
/// `effing::WordBreak` in `skia-c/effing/word_break.hpp`.
#[repr(i32)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum WordBreak {
  /// Between words.
  #[default]
  Normal = 0,
  /// Between any two letters too.
  BreakAll = 1,
  /// Never between two letters where one is CJK.
  KeepAll = 2,
}

impl FromStr for WordBreak {
  type Err = SkError;

  fn from_str(s: &str) -> Result<WordBreak, SkError> {
    match s {
      "normal" => Ok(WordBreak::Normal),
      "break-all" => Ok(WordBreak::BreakAll),
      "keep-all" => Ok(WordBreak::KeepAll),
      _ => Err(SkError::Generic(format!(
        "[`{s}`] is not valid wordBreak value"
      ))),
    }
  }
}

/// What happens to a word wider than the line: CSS `overflow-wrap`. Mirrors
/// `effing::OverflowWrap` in `skia-c/effing/word_break.hpp`.
#[repr(i32)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum OverflowWrap {
  /// It overflows the line, on a line of its own.
  #[default]
  Normal = 0,
  /// It starts a line of its own and is broken where that line is full.
  BreakWord = 1,
}

impl FromStr for OverflowWrap {
  type Err = SkError;

  fn from_str(s: &str) -> Result<OverflowWrap, SkError> {
    match s {
      "normal" => Ok(OverflowWrap::Normal),
      "break-word" => Ok(OverflowWrap::BreakWord),
      _ => Err(SkError::Generic(format!(
        "[`{s}`] is not valid overflowWrap value"
      ))),
    }
  }
}

/// A paragraph's style: everything but its text and font family.
#[derive(Debug, Clone, Copy)]
pub struct ParagraphOptions<'a> {
  pub font_size: f32,
  pub weight: u32,
  pub style: FontStyle,
  pub letter_spacing: f32,
  /// Line box height in px, 0 included; `None` for `normal` (hhea ascender +
  /// descender).
  pub line_height: Option<f32>,
  /// `Start` and `End` follow `direction`.
  pub align: TextAlign,
  pub direction: TextDirection,
  /// Only break at hard breaks.
  pub nowrap: bool,
  /// 0 for unlimited.
  pub max_lines: u32,
  /// Appended where text is truncated.
  pub ellipsis: Option<&'a str>,
  /// Count whitespace before a hard break or the end of the text in its
  /// line's width and alignment instead of hanging it.
  pub keep_trailing_whitespace: bool,
  pub word_break: WordBreak,
  pub overflow_wrap: OverflowWrap,
}

/// How a placeholder sits on its line: CSS `vertical-align` keywords.
/// Mirrors `effing_placeholder_align`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaceholderAlign {
  /// Its own baseline, `baseline_offset` below its top, on the line's.
  Baseline = 0,
  /// Its middle half the primary font's x-height above the baseline.
  Middle = 1,
  /// Its top on the line box's top.
  Top = 2,
  /// Its bottom on the line box's bottom.
  Bottom = 3,
  /// Its top on the primary font's ascent.
  TextTop = 4,
  /// Its bottom on the primary font's descent.
  TextBottom = 5,
}

/// How lines break around a placeholder. Mirrors
/// `effing_placeholder_line_break`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PlaceholderLineBreak {
  /// As around a CSS inline-block or image: on either side of it.
  #[default]
  Box = 0,
  /// As around an emoji: not between it and the punctuation next to it.
  Emoji = 1,
}

/// An inline box in a paragraph's text: it takes `width` on its line and
/// draws nothing.
#[derive(Debug, Clone, Copy)]
pub struct Placeholder {
  /// Where it sits in the text, in UTF-8 bytes.
  pub offset: usize,
  pub width: f32,
  pub height: f32,
  pub align: PlaceholderAlign,
  /// For `Baseline`: its baseline's distance from its top.
  pub baseline_offset: f32,
  pub line_break: PlaceholderLineBreak,
}

/// Mirrors `effing_paragraph_placeholder_box`.
#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
pub struct PlaceholderBox {
  /// False when `max_lines` or an ellipsis cut the placeholder off.
  pub visible: bool,
  pub x: f32,
  pub y: f32,
  pub width: f32,
  pub height: f32,
  pub line: i32,
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
  /// The primary font's hhea ascender, descender and line gap (≥ 0), in px.
  pub ascent: f32,
  pub descent: f32,
  pub line_gap: f32,
}

/// Mirrors `effing_paragraph_line`.
#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
pub struct ParagraphLine {
  /// Left edge of the line, alignment included.
  pub left: f32,
  /// Advance width without trailing whitespace unless it is kept, letter
  /// spacing included.
  pub width: f32,
  /// Baseline, from the top of the paragraph.
  pub baseline: f32,
  /// UTF-16 offsets of the line's text (JS string indices), trailing whitespace
  /// excluded unless it is kept.
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
  placeholder_count: usize,
}

impl Paragraph {
  /// `font_family` is a comma-separated list of family names, unquoted.
  /// `placeholders` are in order of their offsets, which must be char
  /// boundaries of `text`; each takes one UTF-16 unit (U+FFFC) in line
  /// indices.
  pub fn new(
    text: &str,
    placeholders: &[Placeholder],
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
      line_height: options.line_height.unwrap_or(-1.0),
      align: options.align as i32,
      direction: options.direction.as_sk_direction(),
      nowrap: options.nowrap,
      max_lines: options.max_lines as i32,
      ellipsis: ellipsis.as_ptr().cast(),
      ellipsis_len: ellipsis.len(),
      keep_trailing_whitespace: options.keep_trailing_whitespace,
      word_break: options.word_break as i32,
      overflow_wrap: options.overflow_wrap as i32,
    };
    let placeholders: Vec<_> = placeholders
      .iter()
      .map(|p| ffi::effing_paragraph_placeholder {
        offset: p.offset.min(text.len()),
        width: p.width,
        height: p.height,
        align: p.align as i32,
        baseline_offset: p.baseline_offset,
        line_break: p.line_break as i32,
      })
      .collect();
    let ptr = unsafe {
      ffi::effing_paragraph_create(
        text.as_ptr().cast(),
        text.len(),
        collection.0,
        c_family.as_ptr(),
        &style,
        placeholders.as_ptr(),
        placeholders.len(),
      )
    };
    Ok(Paragraph {
      ptr,
      laid_out: false,
      placeholder_count: placeholders.len(),
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

  /// Where layout put each placeholder, in the order they were given.
  pub fn placeholders(&self) -> Vec<PlaceholderBox> {
    let mut boxes = vec![PlaceholderBox::default(); self.placeholder_count];
    unsafe {
      ffi::effing_paragraph_get_placeholders(self.ptr, boxes.as_mut_ptr(), boxes.len() as i32)
    };
    boxes
  }
}

impl Drop for Paragraph {
  fn drop(&mut self) {
    unsafe { ffi::effing_paragraph_destroy(self.ptr) }
  }
}

impl Canvas {
  /// Paints a laid-out paragraph's glyphs with `paint`, its top-left corner
  /// at (x, y), and reports what it drew.
  pub fn draw_paragraph(
    &mut self,
    paragraph: &Paragraph,
    x: f32,
    y: f32,
    paint: &Paint,
  ) -> Painted {
    let mut painted = Painted::default();
    unsafe { ffi::effing_paragraph_paint(paragraph.ptr, self.0, paint.0, x, y, &mut painted) };
    painted
  }
}
