#include "text.hpp"

#include <algorithm>
#include <cstring>
#include <iterator>
#include <vector>

#include "include/core/SkFont.h"
#include "include/core/SkPath.h"
#include "include/core/SkPathBuilder.h"
#include "include/core/SkTextBlob.h"
#include "modules/skparagraph/src/ParagraphImpl.h"

namespace effing {

namespace {

using skia::textlayout::Cluster;
using skia::textlayout::ClusterIndex;
using skia::textlayout::ClusterRange;
using skia::textlayout::LineMetrics;
using skia::textlayout::Paragraph;
using skia::textlayout::ParagraphBuilder;
using skia::textlayout::ParagraphImpl;
using skia::textlayout::TextStyle;

// The code point that starts at text[i], of valid UTF-8, and its length in
// bytes.
char32_t decode_utf8(const char* text, size_t len, size_t i, size_t* n) {
  const auto byte = [&](size_t k) {
    return i + k < len ? static_cast<uint8_t>(text[i + k]) : 0;
  };
  const uint8_t lead = byte(0);
  *n = lead < 0xC0 ? 1 : lead < 0xE0 ? 2 : lead < 0xF0 ? 3 : 4;
  char32_t c = *n == 1 ? lead : lead & (0x7F >> *n);
  for (size_t k = 1; k < *n; k++) {
    c = (c << 6) | (byte(k) & 0x3F);
  }
  *n = std::min(*n, len - i);
  return c;
}

// Whether Chrome adds no letter spacing after `c`: Blink's
// Character::TreatAsZeroWidthSpace, which is a soft hyphen, the other
// default-ignorable code points from U+0100 on, U+FFFC, a form feed and a
// carriage return. A form feed is a hard break in a Paragraph, and Chrome's
// canvas draws both as spaces, which it spaces. Blink tests the UTF-16 unit
// that starts each of HarfBuzz's clusters, a surrogate for a code point past
// the BMP, so of those only the ones HarfBuzz merges into the cluster before
// them, the tags and the variation selectors of plane 14, go without.
bool unspaced(char32_t c, TextKind kind) {
  if (c < 0x100) {
    return c == 0xAD || (kind == TextKind::kCss && c == '\r');
  }
  if (c < 0x10000) {
    return c == 0x034F || c == 0x061C || (c >= 0x115F && c <= 0x1160) ||
           (c >= 0x17B4 && c <= 0x17B5) || (c >= 0x180B && c <= 0x180F) ||
           (c >= 0x200B && c <= 0x200F) || (c >= 0x202A && c <= 0x202E) ||
           (c >= 0x2060 && c <= 0x206F) || c == 0x3164 ||
           (c >= 0xFE00 && c <= 0xFE0F) || c == 0xFEFF || c == 0xFFA0 ||
           (c >= 0xFFF0 && c <= 0xFFF8) || c == 0xFFFC;
  }
  return (c >= 0xE0020 && c <= 0xE007F) || (c >= 0xE0100 && c <= 0xE01EF);
}

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
                       const SkPaint& paint,
                       Painted* painted) {
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
    if (painted != nullptr) {
      painted->bytes += run.count * (sizeof(SkGlyphID) + sizeof(SkPoint));
      painted->ops++;
      if (const SkTypeface* typeface = font.getTypeface()) {
        const SkTypefaceID id = typeface->uniqueID();
        if (std::find(painted->typefaces.begin(), painted->typefaces.end(),
                      id) == painted->typefaces.end()) {
          painted->typefaces.push_back(id);
        }
      }
    }
    return;
  }
  SkPaint path_paint(paint);
  path_paint.setAntiAlias(true);
  const SkPath path = builder.detach().makeOffset(x, y);
  canvas->drawPath(path, path_paint);
  if (painted != nullptr) {
    painted->bytes += path.countPoints() * 16 + path.countVerbs() * 8;
    painted->ops++;
  }
}

// What paint_text_unsnapped drew on this thread, until
// effing_take_text_painted reports it.
thread_local Painted text_painted;

}  // namespace

void Painted::export_to(effing_painted* out) const {
  *out = {};
  out->bytes = bytes;
  out->ops = ops;
  out->typeface_count = typefaces.size();
  std::copy_n(typefaces.begin(),
              std::min(typefaces.size(), std::size(out->typefaces)),
              out->typefaces);
}

void make_unhinted(skia::textlayout::TextStyle* text_style,
                   skia::textlayout::StrutStyle* strut_style) {
  text_style->setFontHinting(SkFontHinting::kNone);
  // SkParagraph caches shaped runs, fonts included, under a key that leaves
  // hinting out, so the same text and style drawn hinted and unhinted would
  // share an entry and whichever came second would get the other's advances
  // and outlines. The key does compare the strut style, and nothing reads the
  // font families of a disabled strut: name the unhinted ones apart there.
  strut_style->setFontFamilies({SkString("effing-unhinted")});
}

void add_text(ParagraphBuilder* builder,
              const char* text,
              size_t len,
              TextKind kind) {
  TextStyle without = builder->peekStyle();
  if (without.getLetterSpacing() == 0) {
    builder->addText(text, len);
    return;
  }
  without.setLetterSpacing(0);
  size_t added = 0;
  for (size_t i = 0; i < len;) {
    size_t n;
    if (!unspaced(decode_utf8(text, len, i, &n), kind)) {
      i += n;
      continue;
    }
    size_t end = i + n;
    while (end < len && unspaced(decode_utf8(text, len, end, &n), kind)) {
      end += n;
    }
    if (i > added) {
      builder->addText(text + added, i - added);
    }
    builder->pushStyle(without);
    builder->addText(text + i, end - i);
    builder->pop();
    added = i = end;
  }
  if (len > added) {
    builder->addText(text + added, len - added);
  }
}

SkScalar leading_half_letter_spacing(Paragraph* paragraph) {
  auto* impl = static_cast<ParagraphImpl*>(paragraph);
  if (impl->lines().empty()) {
    return 0;
  }
  // As TextLine's constructor finds it.
  const ClusterRange clusters = impl->lines().front().clustersWithSpaces();
  for (ClusterIndex i = clusters.start; i < clusters.end; i++) {
    const Cluster& cluster = impl->cluster(i);
    if (!cluster.run().isPlaceholder() && !cluster.run().isCursiveScript()) {
      return cluster.getHalfLetterSpacing();
    }
  }
  return 0;
}

void paint_paragraph_unsnapped(Paragraph* paragraph,
                               SkCanvas* canvas,
                               SkScalar x,
                               SkScalar y,
                               const SkPaint& paint,
                               const SkPoint* line_origins,
                               Painted* painted) {
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
    draw_run_as_paths(canvas, *run, run_x, run_y, paint, painted);
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
  paint_paragraph_unsnapped(paragraph, canvas, x, y, paint, origins.data(),
                            &text_painted);
}

}  // namespace effing

extern "C" {

void effing_take_text_painted(effing_painted* painted) {
  effing::text_painted.export_to(painted);
  effing::text_painted = {};
}
}
