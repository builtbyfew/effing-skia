// Effing's text painter: glyphs placed exactly where layout put them, with no
// pixel-grid snapping. Used by the paragraph primitive and, under
// textRendering geometricPrecision, by fillText/strokeText.
#ifndef EFFING_TEXT_HPP
#define EFFING_TEXT_HPP

#include "include/core/SkCanvas.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPoint.h"
#include "modules/skparagraph/include/Paragraph.h"

namespace effing {

// The `text_rendering` value skia_c.cpp receives for geometricPrecision; it
// mirrors `TextRendering` in src/sk.rs.
constexpr int kTextRenderingGeometricPrecision = 3;

// Paints a laid-out paragraph's glyphs with `paint`, without snapping them to
// the pixel grid: outlines are filled as paths at their exact positions, so
// with unhinted outlines the text lands in the same place at any raster
// scale. A run with glyphs that have no outline (color or bitmap glyphs) is
// drawn as glyph masks with baseline snapping off instead.
//
// Only glyphs are painted: the paragraph's own foreground, backgrounds,
// shadows and decorations are ignored. Line `i` is painted with its left edge
// and baseline at `line_origins[i]`, relative to (x, y); when `line_origins`
// is null, each line stays where SkParagraph put it (its `LineMetrics::fLeft`
// and exact, unrounded `fBaseline`).
void paint_paragraph_unsnapped(skia::textlayout::Paragraph* paragraph,
                               SkCanvas* canvas,
                               SkScalar x,
                               SkScalar y,
                               const SkPaint& paint,
                               const SkPoint* line_origins = nullptr);

// The fillText/strokeText flavour: paints the paragraph with its first line's
// alphabetic baseline exactly at y + getAlphabeticBaseline(), the value the
// Canvas 2D textBaseline offsets are computed from.
void paint_text_unsnapped(skia::textlayout::Paragraph* paragraph,
                          SkCanvas* canvas,
                          SkScalar x,
                          SkScalar y,
                          const SkPaint& paint);

}  // namespace effing

#endif  // EFFING_TEXT_HPP
