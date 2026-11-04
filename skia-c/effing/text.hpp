// Effing's text painter: glyphs placed exactly where layout put them, with no
// pixel-grid snapping. Used by the paragraph primitive and, under
// textRendering geometricPrecision, by fillText/strokeText.
#ifndef EFFING_TEXT_HPP
#define EFFING_TEXT_HPP

#include <cstddef>
#include <cstdint>
#include <vector>

#include "include/core/SkCanvas.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPoint.h"
#include "include/core/SkTypeface.h"
#include "modules/skparagraph/include/Paragraph.h"
#include "modules/skparagraph/include/ParagraphBuilder.h"
#include "modules/skparagraph/include/ParagraphStyle.h"
#include "modules/skparagraph/include/TextStyle.h"

// What the painter drew, for a recording's byte budget; see effing::Painted.
struct effing_painted {
  size_t bytes;
  size_t ops;
  // The unique IDs of the typefaces text-blob runs keep alive. Only the
  // first 16 are listed; `typeface_count` counts them all.
  uint32_t typefaces[16];
  size_t typeface_count;
};

extern "C" {
// Reports what paint_glyphs_unsnapped drew on this thread since the last
// call, and starts the tally over. fillText/strokeText under
// geometricPrecision reach it through upstream's skiac_text_draw, whose
// signature stays upstream's.
void effing_take_text_painted(effing_painted* painted);
}

namespace effing {

// The `text_rendering` value text.cpp receives for geometricPrecision; it
// mirrors `TextRendering` in src/sk.rs.
constexpr int kTextRenderingGeometricPrecision = 3;

// The font size Chrome lays text out at, for a CSS or canvas font size of
// `size` px: Blink's FontDescription::EffectiveFontSize, the size floored to
// 1/100px (FontCacheKey's precision multiplier) in float arithmetic, as Blink
// computes it, so 17.3 (17.2999992 as a float) is 17.29. Metrics and advances
// then are those of the font at that size. A size that floors to 0 or that
// overflows stays as it is.
float effective_font_size(float size);

// The size to give Skia for text laid out at `size` px, an
// effective_font_size: the nearest 1/64px. Skia's FreeType sets a face's
// size in 1/64px, truncated (SkScalarToFDot6), and takes its advances and
// outlines at that size, up to 1/64px smaller than the one asked for, where
// Chrome on macOS, effing's reference, takes them from CoreText at the exact
// size. The nearest 1/64px comes closest to that. (Chrome on Linux truncates
// as FreeType does.) Metrics computed from the font's tables stay at `size`.
// A size that rounds to 0 stays as it is.
float freetype_font_size(float size);

// Adds a Paragraph's `text` to `builder` in the builder's current style,
// giving the code points Chrome adds no letter spacing after a style of their
// own without it. Blink skips the letter spacing of a character it treats as
// a zero-width space: a default-ignorable code point (ZWSP, ZWJ, ZWNJ, WJ,
// the bidi controls, variation selectors, a soft hyphen, ...), U+FFFC and, in
// CSS text, a carriage return. (fillText's text gets the same from upstream's
// text.cpp, NoLetterSpacingRanges.) SkParagraph spaces every glyph, so a ZWSP
// between two letters would add a third gap to their two. A style that differs
// only in letter spacing doesn't split SkParagraph's shaping runs, so ZWJ and
// ZWNJ still join or break ligatures, emoji sequences and conjuncts as before.
// Text without such code points, or a style without letter spacing, is added
// as it is.
void add_text(skia::textlayout::ParagraphBuilder* builder,
              const char* text,
              size_t len);

// What the painter drew, for a recording's byte budget.
struct Painted {
  // The outline paths and text blobs drawn, estimated the way the canvas
  // estimates paths: 16 B per point and 8 B per verb, and 10 B per glyph of
  // a blob.
  size_t bytes = 0;
  // Draw calls made, one per run.
  size_t ops = 0;
  // The typefaces that text-blob runs keep alive, each listed once. Outline
  // paths keep none alive.
  std::vector<SkTypefaceID> typefaces;

  // Copies the tally into its C form.
  void export_to(effing_painted* out) const;
};

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
// and exact, unrounded `fBaseline`). What was drawn is added to `painted`
// when it is not null.
void paint_paragraph_unsnapped(skia::textlayout::Paragraph* paragraph,
                               SkCanvas* canvas,
                               SkScalar x,
                               SkScalar y,
                               const SkPaint& paint,
                               const SkPoint* line_origins = nullptr,
                               Painted* painted = nullptr);

// The fillText/strokeText flavour, for one run of a line upstream's text.cpp
// laid out: paints `count` glyphs of `font` at `positions`, relative to
// (x, y), as paint_paragraph_unsnapped paints a run. What was drawn is added
// to this thread's tally, which effing_take_text_painted reports.
void paint_glyphs_unsnapped(SkCanvas* canvas,
                            const SkFont& font,
                            const SkGlyphID* glyphs,
                            const SkPoint* positions,
                            int count,
                            SkScalar x,
                            SkScalar y,
                            const SkPaint& paint);

}  // namespace effing

#endif  // EFFING_TEXT_HPP
