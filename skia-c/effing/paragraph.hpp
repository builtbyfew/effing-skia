// Effing's paragraph primitive: one native object that lays out a
// single-style paragraph, reports its lines, and paints it unsnapped.
#ifndef EFFING_PARAGRAPH_HPP
#define EFFING_PARAGRAPH_HPP

#include <cstddef>

#include "../skia_c.hpp"
#include "text.hpp"

struct effing_paragraph;

struct effing_paragraph_style {
  float font_size;
  int weight;
  // An SkFontStyle::Slant.
  int slant;
  float letter_spacing;
  // Line box height in px; 0 means `normal` (hhea ascender + descender).
  float line_height;
  // A skia::textlayout::TextAlign; start and end follow `direction`.
  int align;
  // A skia::textlayout::TextDirection.
  int direction;
  // Only break at hard breaks (white-space: nowrap / pre).
  bool nowrap;
  // 0 means unlimited.
  int max_lines;
  // UTF-8 string appended where max_lines or nowrap truncates the text, or
  // empty for none. Not NUL-terminated.
  const char* ellipsis;
  size_t ellipsis_len;
};

// How a placeholder sits on its line: CSS vertical-align keywords.
enum effing_placeholder_align {
  // The placeholder's own baseline, `baseline_offset` below its top, on the
  // line's baseline.
  EFFING_PLACEHOLDER_BASELINE = 0,
  // Its middle half the primary font's x-height above the baseline.
  EFFING_PLACEHOLDER_MIDDLE = 1,
  // Its top or bottom on the line box's top or bottom.
  EFFING_PLACEHOLDER_TOP = 2,
  EFFING_PLACEHOLDER_BOTTOM = 3,
  // Its top or bottom on the primary font's ascent or descent.
  EFFING_PLACEHOLDER_TEXT_TOP = 4,
  EFFING_PLACEHOLDER_TEXT_BOTTOM = 5,
};

// An inline box in the text, which takes `width` on its line and draws
// nothing. Placeholders never change a line box's height.
struct effing_paragraph_placeholder {
  // Where it sits in the text, in UTF-8 bytes. Placeholders are in order.
  size_t offset;
  float width;
  float height;
  // An effing_placeholder_align.
  int align;
  // For EFFING_PLACEHOLDER_BASELINE: its baseline's distance from its top.
  float baseline_offset;
};

// Where layout put a placeholder, from the top-left corner of the paragraph.
struct effing_paragraph_placeholder_box {
  // False when the placeholder was truncated away by max_lines or an
  // ellipsis; the other fields are then 0.
  bool visible;
  float x;
  float y;
  float width;
  float height;
  int line;
};

struct effing_paragraph_metrics {
  float height;
  float longest_line;
  float min_intrinsic_width;
  float max_intrinsic_width;
  bool did_exceed_max_lines;
  int line_count;
  float line_height;
  // The primary font's hhea ascender and descender, in px.
  float ascent;
  float descent;
};

struct effing_paragraph_line {
  // Left edge of the line, alignment included.
  float left;
  // Advance width without trailing whitespace, letter spacing included.
  float width;
  // Baseline, from the top of the paragraph.
  float baseline;
  // UTF-16 offsets of the line's text (JS string indices), trailing whitespace
  // excluded.
  size_t start_index;
  size_t end_index;
  bool hard_break;
};

extern "C" {
// `font_family` is a comma-separated list of family names, unquoted. Each of
// the `placeholder_count` placeholders takes one UTF-16 unit (U+FFFC) of the
// text, as far as line indices go.
effing_paragraph* effing_paragraph_create(
    const char* text,
    size_t text_len,
    skiac_font_collection* collection,
    const char* font_family,
    const effing_paragraph_style* style,
    const effing_paragraph_placeholder* placeholders,
    size_t placeholder_count);
// Lays the text out in `width` px; a non-positive or non-finite width means
// unbounded. Must precede the calls below.
void effing_paragraph_layout(effing_paragraph* p, float width);
void effing_paragraph_get_metrics(effing_paragraph* p,
                                  effing_paragraph_metrics* metrics);
// Fills `lines` with up to `count` lines, in order.
void effing_paragraph_get_lines(effing_paragraph* p,
                                effing_paragraph_line* lines,
                                int count);
// Fills `boxes` with up to `count` placeholder boxes, in the order the
// placeholders were given.
void effing_paragraph_get_placeholders(effing_paragraph* p,
                                       effing_paragraph_placeholder_box* boxes,
                                       int count);
// Paints the glyphs with `paint`, the paragraph's top-left corner at (x, y),
// and reports what it drew in `painted`.
void effing_paragraph_paint(effing_paragraph* p,
                            skiac_canvas* canvas,
                            skiac_paint* paint,
                            float x,
                            float y,
                            effing_painted* painted);
void effing_paragraph_destroy(effing_paragraph* p);
}

#endif  // EFFING_PARAGRAPH_HPP
