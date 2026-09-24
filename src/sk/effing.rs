//! Safe wrapper around the effing paragraph primitive in
//! `skia-c/effing_paragraph.cpp`.

use std::ffi::{CString, NulError, c_char};

use super::{Canvas, FontCollection, Paint, ffi};

#[repr(C)]
pub struct effing_paragraph {
  _unused: [u8; 0],
}

#[repr(C)]
pub struct EffingParagraphStyle {
  pub font_size: f32,
  pub weight: i32,
  pub slant: i32,
  pub letter_spacing: f32,
  pub line_height: f32,
  pub align: i32,
  pub rtl: bool,
  pub nowrap: bool,
  pub max_lines: i32,
  pub ellipsis: *const c_char,
}

#[repr(C)]
#[derive(Default)]
pub struct EffingParagraphMetrics {
  pub height: f32,
  pub longest_line: f32,
  pub min_intrinsic_width: f32,
  pub max_intrinsic_width: f32,
  pub did_exceed_max_lines: bool,
  pub line_count: i32,
  pub line_height: f32,
  pub ascent: f32,
  pub descent: f32,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
pub struct EffingParagraphLine {
  pub left: f32,
  pub width: f32,
  pub baseline: f32,
  pub ascent: f32,
  pub descent: f32,
  pub height: f32,
  pub start_index: usize,
  pub end_index: usize,
  pub hard_break: bool,
}

unsafe extern "C" {
  fn effing_paragraph_create(
    text: *const c_char,
    text_len: usize,
    collection: *mut ffi::skiac_font_collection,
    font_family: *const c_char,
    style: *const EffingParagraphStyle,
  ) -> *mut effing_paragraph;
  fn effing_paragraph_layout(p: *mut effing_paragraph, width: f32);
  fn effing_paragraph_get_metrics(p: *mut effing_paragraph, metrics: *mut EffingParagraphMetrics);
  fn effing_paragraph_get_lines(
    p: *mut effing_paragraph,
    lines: *mut EffingParagraphLine,
    count: i32,
  );
  fn effing_paragraph_paint(
    p: *mut effing_paragraph,
    canvas: *mut ffi::skiac_canvas,
    paint: *mut ffi::skiac_paint,
    x: f32,
    y: f32,
  );
  fn effing_paragraph_destroy(p: *mut effing_paragraph);
}

/// Everything about a paragraph except its text and font family.
pub struct ParagraphOptions<'a> {
  pub font_size: f32,
  pub weight: i32,
  pub slant: i32,
  pub letter_spacing: f32,
  pub line_height: f32,
  pub align: i32,
  pub rtl: bool,
  pub nowrap: bool,
  pub max_lines: i32,
  pub ellipsis: Option<&'a str>,
}

pub struct EffingParagraph(*mut effing_paragraph);

impl EffingParagraph {
  pub fn new(
    text: &str,
    font_family: &str,
    collection: &FontCollection,
    options: &ParagraphOptions,
  ) -> Result<Self, NulError> {
    let c_text = CString::new(text)?;
    let c_family = CString::new(font_family)?;
    let c_ellipsis = options.ellipsis.map(CString::new).transpose()?;
    let style = EffingParagraphStyle {
      font_size: options.font_size,
      weight: options.weight,
      slant: options.slant,
      letter_spacing: options.letter_spacing,
      line_height: options.line_height,
      align: options.align,
      rtl: options.rtl,
      nowrap: options.nowrap,
      max_lines: options.max_lines,
      ellipsis: c_ellipsis.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
    };
    let ptr = unsafe {
      effing_paragraph_create(
        c_text.as_ptr(),
        text.len(),
        collection.0,
        c_family.as_ptr(),
        &style,
      )
    };
    Ok(EffingParagraph(ptr))
  }

  pub fn layout(&mut self, width: f32) {
    unsafe { effing_paragraph_layout(self.0, width) }
  }

  pub fn metrics(&self) -> EffingParagraphMetrics {
    let mut metrics = EffingParagraphMetrics::default();
    unsafe { effing_paragraph_get_metrics(self.0, &mut metrics) };
    metrics
  }

  pub fn lines(&self, count: usize) -> Vec<EffingParagraphLine> {
    let mut lines = vec![EffingParagraphLine::default(); count];
    unsafe { effing_paragraph_get_lines(self.0, lines.as_mut_ptr(), count as i32) };
    lines
  }
}

impl Drop for EffingParagraph {
  fn drop(&mut self) {
    unsafe { effing_paragraph_destroy(self.0) }
  }
}

impl Canvas {
  pub fn draw_effing_paragraph(&mut self, p: &EffingParagraph, x: f32, y: f32, paint: &Paint) {
    unsafe { effing_paragraph_paint(p.0, self.0, paint.0, x, y) }
  }
}
