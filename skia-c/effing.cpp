#include "effing.hpp"

#include <cstdlib>
#include <cstring>
#include <vector>

#include "include/core/SkFont.h"
#include "include/core/SkPath.h"
#include "include/core/SkPathBuilder.h"
#include "include/core/SkTextBlob.h"

namespace effing {

namespace {

// Glyph masks are cached at quarter-pixel offsets and their coverage depends
// on the device size, which moves text by up to half a pixel between scales.
// Filling the outlines instead places text as precisely as any other path.
// EFFING_GP_TEXT=mask restores cached masks, for comparison.
bool use_paths() {
  static const bool value = [] {
    const char* v = std::getenv("EFFING_GP_TEXT");
    return v == nullptr || std::strcmp(v, "mask") != 0;
  }();
  return value;
}

struct PathCtx {
  SkPathBuilder* builder;
  const SkPoint* positions;
  int index;
  bool missing;
};

// Appends each glyph outline at its position. Glyphs without an outline
// (bitmap or color glyphs) mark the run so it falls back to masks.
bool append_glyph_paths(const SkFont& font,
                        const SkGlyphID* glyphs,
                        const SkPoint* positions,
                        int count,
                        SkPathBuilder* builder) {
  PathCtx ctx{builder, positions, 0, false};
  font.getPaths(
      {glyphs, static_cast<size_t>(count)},
      [](const SkPath* path, const SkMatrix& mx, void* c) {
        auto* ctx = static_cast<PathCtx*>(c);
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

}  // namespace

void paint_paragraph_unsnapped(skia::textlayout::Paragraph* paragraph,
                               SkCanvas* canvas,
                               SkScalar x,
                               SkScalar y,
                               const SkPaint& paint) {
  const bool paths = use_paths();
  paragraph->visit(
      [&](int, const skia::textlayout::Paragraph::VisitorInfo* info) {
        if (info == nullptr || info->count == 0) {
          return;
        }
        const SkScalar ox = x + info->origin.fX;
        const SkScalar oy = y + info->origin.fY;
        if (paths) {
          SkPathBuilder builder;
          if (append_glyph_paths(info->font, info->glyphs, info->positions,
                                 info->count, &builder)) {
            SkPaint path_paint(paint);
            path_paint.setAntiAlias(true);
            canvas->drawPath(builder.detach().makeOffset(ox, oy), path_paint);
            return;
          }
        }
        SkFont font = info->font;
        font.setBaselineSnap(false);
        SkTextBlobBuilder builder;
        const auto& run = builder.allocRunPos(font, info->count);
        std::memcpy(run.glyphs, info->glyphs, info->count * sizeof(SkGlyphID));
        std::memcpy(run.pos, info->positions, info->count * sizeof(SkPoint));
        canvas->drawTextBlob(builder.make(), ox, oy, paint);
      });
}

}  // namespace effing
