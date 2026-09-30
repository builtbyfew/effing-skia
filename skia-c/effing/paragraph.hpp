// Effing's paragraph primitive: one native object that lays out a
// single-style paragraph, reports its lines, and paints it unsnapped.
#ifndef EFFING_PARAGRAPH_HPP
#define EFFING_PARAGRAPH_HPP

#include <cstddef>

#include "../skia_c.hpp"

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
// `font_family` is a comma-separated list of family names, unquoted.
effing_paragraph* effing_paragraph_create(const char* text,
                                          size_t text_len,
                                          skiac_font_collection* collection,
                                          const char* font_family,
                                          const effing_paragraph_style* style);
// Lays the text out in `width` px; a non-positive or non-finite width means
// unbounded. Must precede the calls below.
void effing_paragraph_layout(effing_paragraph* p, float width);
void effing_paragraph_get_metrics(effing_paragraph* p,
                                  effing_paragraph_metrics* metrics);
// Fills `lines` with up to `count` lines, in order.
void effing_paragraph_get_lines(effing_paragraph* p,
                                effing_paragraph_line* lines,
                                int count);
// Paints the glyphs with `paint`, the paragraph's top-left corner at (x, y).
void effing_paragraph_paint(effing_paragraph* p,
                            skiac_canvas* canvas,
                            skiac_paint* paint,
                            float x,
                            float y);
void effing_paragraph_destroy(effing_paragraph* p);
}

#endif  // EFFING_PARAGRAPH_HPP
