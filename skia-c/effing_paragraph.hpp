// Effing paragraph primitive: one native object that lays out a single-style
// paragraph, reports its line metrics, and paints it.
#ifndef EFFING_PARAGRAPH_HPP
#define EFFING_PARAGRAPH_HPP

#include <cstddef>

#include "skia_c.hpp"

struct effing_paragraph;

struct effing_paragraph_style {
  float font_size;
  int weight;
  int slant;
  float letter_spacing;
  // Line box height in px; 0 means `normal` (hhea ascender + descender).
  float line_height;
  // 0 left, 1 right, 2 center, 3 justify.
  int align;
  bool rtl;
  // Only break at hard breaks (white-space: nowrap / pre).
  bool nowrap;
  // 0 means unlimited.
  int max_lines;
  // UTF-8 string appended where text is truncated, or null for none.
  const char* ellipsis;
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
  // Left edge of the line's ink box, alignment included.
  float left;
  // Advance width without trailing whitespace, letter spacing included.
  float width;
  float baseline;
  float ascent;
  float descent;
  float height;
  size_t start_index;
  size_t end_index;
  bool hard_break;
};

extern "C" {
effing_paragraph* effing_paragraph_create(const char* text,
                                          size_t text_len,
                                          skiac_font_collection* collection,
                                          const char* font_family,
                                          const effing_paragraph_style* style);
void effing_paragraph_layout(effing_paragraph* p, float width);
void effing_paragraph_get_metrics(effing_paragraph* p,
                                  effing_paragraph_metrics* metrics);
void effing_paragraph_get_lines(effing_paragraph* p,
                                effing_paragraph_line* lines,
                                int count);
void effing_paragraph_paint(effing_paragraph* p,
                            skiac_canvas* canvas,
                            skiac_paint* paint,
                            float x,
                            float y);
void effing_paragraph_destroy(effing_paragraph* p);
}

#endif  // EFFING_PARAGRAPH_HPP
