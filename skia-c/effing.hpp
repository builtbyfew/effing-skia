// Effing-specific additions to the Skia bridge. Kept out of skia_c.cpp so
// upstream bumps merge cleanly.
#ifndef EFFING_HPP
#define EFFING_HPP

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
// Only glyphs are drawn: backgrounds, shadows and decorations, which the
// Canvas 2D text path never sets, are ignored.
void paint_paragraph_unsnapped(skia::textlayout::Paragraph* paragraph,
                               SkCanvas* canvas,
                               SkScalar x,
                               SkScalar y,
                               const SkPaint& paint);

}  // namespace effing

#endif  // EFFING_HPP
