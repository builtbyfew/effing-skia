// Effing-specific additions to the Skia bridge. Kept out of skia_c.cpp so
// upstream bumps merge cleanly.
#ifndef EFFING_HPP
#define EFFING_HPP

#include <vector>

#include "include/core/SkCanvas.h"
#include "include/core/SkPaint.h"
#include "modules/skparagraph/include/Paragraph.h"

namespace effing {

// Paints a laid-out paragraph without snapping glyphs to the pixel grid: glyph
// outlines are filled as paths at their exact positions, so together with
// unhinted outlines, text lands in the same place whether it is rasterized at
// 1x or at any other scale. Runs containing glyphs without an outline (color
// or bitmap glyphs) are drawn as masks with baseline snapping turned off.
//
// Only glyphs are drawn, with `paint`: the paragraph's own foreground,
// backgrounds, shadows and decorations are ignored. `line_offsets`, if given,
// moves each line by its entry.
void paint_paragraph_unsnapped(
    skia::textlayout::Paragraph* paragraph,
    SkCanvas* canvas,
    SkScalar x,
    SkScalar y,
    const SkPaint& paint,
    const std::vector<SkVector>* line_offsets = nullptr);

}  // namespace effing

#endif  // EFFING_HPP
