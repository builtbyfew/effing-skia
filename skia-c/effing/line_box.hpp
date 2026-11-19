// The CSS line model effing's paragraphs share, whichever engine lays them
// out (paragraph.cpp, paragraph_blink.cpp): the primary font's metrics and
// where a line box puts its baseline, as Chrome computes them.
#ifndef EFFING_LINE_BOX_HPP
#define EFFING_LINE_BOX_HPP

#include <vector>

#include "include/core/SkRefCnt.h"
#include "include/core/SkString.h"
#include "include/core/SkTypeface.h"

namespace effing {

// A paragraph's comma-separated list of family names, unquoted.
std::vector<SkString> split_families(const char* font_family);

// The font's hhea ascender, descender and line gap in px, which effing (like
// satori, through opentype.js) uses for line boxes, as Chrome on macOS
// (CoreText) does. Skia's own metrics prefer the OS/2 typo values when
// USE_TYPO_METRICS is set, so read the table directly. A negative line gap is
// 0, as in Chrome.
bool hhea_metrics(const sk_sp<SkTypeface>& typeface,
                  float font_size,
                  float* ascent,
                  float* descent,
                  float* line_gap);

// A length in px as Chrome lays it out: in LayoutUnits of 1/64px, to which
// Blink rounds a px line height (ComputedLineHeightAsFixed).
float to_layout_units(float px);

// A font's ascent or descent as Chrome's content area has it: rounded half up
// to whole pixels (FontMetrics::AscentDescentWithHacks).
float round_metric(float px);

// The baseline's distance from the top of a line box `line_height` tall, by
// Chrome's half-leading (CalculateLeadingSpace in Blink's inline layout): the
// leading is the line height less the content area, and the half above it is
// floored to whole pixels, the odd pixel and any fraction going below. The
// leading can be negative (a line height smaller than the content area), and
// is floored the same way. Blink halves in LayoutUnits, truncating towards 0.
float baseline_in_line_box(float line_height,
                           float content_ascent,
                           float content_descent);

// The font's x-height in px, as CSS `vertical-align: middle` uses it: from
// the OS/2 table, or else the height of the glyph 'x'.
float x_height(const sk_sp<SkTypeface>& typeface, float font_size);

}  // namespace effing

#endif  // EFFING_LINE_BOX_HPP
