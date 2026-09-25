#include "text.hpp"

#include <cstring>
#include <vector>

#include "include/core/SkFont.h"
#include "include/core/SkPath.h"
#include "include/core/SkPathBuilder.h"
#include "include/core/SkTextBlob.h"

namespace effing {

namespace {

using skia::textlayout::LineMetrics;
using skia::textlayout::Paragraph;

struct GlyphPathContext {
  SkPathBuilder* builder;
  const SkPoint* positions;
  int index;
  bool missing;
};

// Appends each glyph's outline at its position. Returns false if a glyph has
// no outline (a bitmap or color glyph), in which case the run needs masks.
bool append_glyph_paths(const SkFont& font,
                        const SkGlyphID* glyphs,
                        const SkPoint* positions,
                        int count,
                        SkPathBuilder* builder) {
  GlyphPathContext ctx{builder, positions, 0, false};
  font.getPaths(
      {glyphs, static_cast<size_t>(count)},
      [](const SkPath* path, const SkMatrix& mx, void* c) {
        auto* ctx = static_cast<GlyphPathContext*>(c);
        const SkPoint pos = ctx->positions[ctx->index++];
        if (path == nullptr) {
          ctx->missing = true;
          return;
        }
        SkMatrix m = mx;
        m.postTranslate(pos.fX, pos.fY);
        ctx->builder->addPath(*path, m);
      },
      &ctx);
  return !ctx.missing;
}

// Glyph masks are cached at quarter-pixel offsets and their coverage depends
// on the device size, which moves text by up to half a pixel between scales.
// Filling the outlines places text as precisely as any other path.
void draw_run_as_paths(SkCanvas* canvas,
                       const Paragraph::VisitorInfo& run,
                       SkScalar x,
                       SkScalar y,
                       const SkPaint& paint) {
  SkPathBuilder builder;
  if (!append_glyph_paths(run.font, run.glyphs, run.positions, run.count,
                          &builder)) {
    SkFont font = run.font;
    font.setBaselineSnap(false);
    SkTextBlobBuilder blob;
    const auto& buffer = blob.allocRunPos(font, run.count);
    std::memcpy(buffer.glyphs, run.glyphs, run.count * sizeof(SkGlyphID));
    std::memcpy(buffer.pos, run.positions, run.count * sizeof(SkPoint));
    canvas->drawTextBlob(blob.make(), x, y, paint);
    return;
  }
  SkPaint path_paint(paint);
  path_paint.setAntiAlias(true);
  canvas->drawPath(builder.detach().makeOffset(x, y), path_paint);
}

}  // namespace

void paint_paragraph_unsnapped(Paragraph* paragraph,
                               SkCanvas* canvas,
                               SkScalar x,
                               SkScalar y,
                               const SkPaint& paint,
                               const SkPoint* line_origins) {
  std::vector<LineMetrics> lines;
  paragraph->getLineMetrics(lines);
  paragraph->visit([&](int line, const Paragraph::VisitorInfo* run) {
    if (run == nullptr || run->count == 0 || line < 0 ||
        static_cast<size_t>(line) >= lines.size()) {
      return;
    }
    const LineMetrics& metrics = lines[line];
    // SkParagraph paints each run at floor(baseline + 0.5); the exact
    // baseline is only in the line metrics.
    const SkPoint skia_origin = {static_cast<SkScalar>(metrics.fLeft),
                                 static_cast<SkScalar>(metrics.fBaseline)};
    const SkPoint origin =
        line_origins != nullptr ? line_origins[line] : skia_origin;
    // A run's origin sits at its shift within the line; keep that shift
    // relative to wherever the line goes.
    const SkScalar run_x = x + origin.fX + (run->origin.fX - skia_origin.fX);
    const SkScalar run_y = y + origin.fY;
    draw_run_as_paths(canvas, *run, run_x, run_y, paint);
  });
}

void paint_text_unsnapped(Paragraph* paragraph,
                          SkCanvas* canvas,
                          SkScalar x,
                          SkScalar y,
                          const SkPaint& paint) {
  std::vector<LineMetrics> lines;
  paragraph->getLineMetrics(lines);
  if (lines.empty()) {
    return;
  }
  const SkScalar shift = paragraph->getAlphabeticBaseline() -
                         static_cast<SkScalar>(lines[0].fBaseline);
  std::vector<SkPoint> origins;
  origins.reserve(lines.size());
  for (const LineMetrics& line : lines) {
    origins.push_back({static_cast<SkScalar>(line.fLeft),
                       static_cast<SkScalar>(line.fBaseline) + shift});
  }
  paint_paragraph_unsnapped(paragraph, canvas, x, y, paint, origins.data());
}

}  // namespace effing
