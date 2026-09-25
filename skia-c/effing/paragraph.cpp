// Lays out a single-style paragraph with SkParagraph and paints it unsnapped.
// Skia breaks the lines and shapes them; effing places them. Line boxes follow
// effing's (and satori's) CSS model: every line is exactly `line_height` tall,
// with the baseline placed by half-leading around the primary font's hhea
// ascender and descender.
#include "paragraph.hpp"

#include <algorithm>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include "include/core/SkFontMetrics.h"
#include "include/core/SkTypeface.h"
#include "text.hpp"

using namespace skia::textlayout;

struct effing_paragraph {
  std::unique_ptr<Paragraph> paragraph;
  TextAlign align = TextAlign::kLeft;
  bool nowrap = false;
  bool ellipsized = false;
  float line_height = 0;
  float ascent = 0;
  float descent = 0;
  // Filled by layout, per line.
  std::vector<LineMetrics> lines;
  std::vector<float> line_widths;
  // Where effing puts each line's left edge and baseline.
  std::vector<SkPoint> line_origins;
};

namespace {

// Wide enough for any real layout, small enough to stay exact in float.
constexpr float kUnbounded = 1e7f;

std::vector<SkString> split_families(const char* font_family) {
  std::vector<SkString> families;
  const std::string list(font_family);
  size_t start = 0;
  while (start <= list.size()) {
    size_t end = list.find(',', start);
    if (end == std::string::npos) {
      end = list.size();
    }
    if (end > start) {
      families.emplace_back(list.data() + start, end - start);
    }
    start = end + 1;
  }
  return families;
}

int16_t read_be_i16(const uint8_t* p) {
  return static_cast<int16_t>((p[0] << 8) | p[1]);
}

// The font's hhea ascender and descender in px, which effing (like satori,
// through opentype.js) uses for line boxes. Skia's own metrics prefer the
// OS/2 typo values when USE_TYPO_METRICS is set, so read the table directly.
bool hhea_metrics(const sk_sp<SkTypeface>& typeface,
                  float font_size,
                  float* ascent,
                  float* descent) {
  uint8_t buf[4];
  if (!typeface ||
      typeface->getTableData(SkSetFourByteTag('h', 'h', 'e', 'a'), 4, 4,
                             buf) != 4) {
    return false;
  }
  const int upem = typeface->getUnitsPerEm();
  if (upem <= 0) {
    return false;
  }
  *ascent = read_be_i16(buf) / static_cast<float>(upem) * font_size;
  *descent = -read_be_i16(buf + 2) / static_cast<float>(upem) * font_size;
  return true;
}

// Resolves start and end against the direction; every other value is itself.
TextAlign resolve_align(TextAlign align, TextDirection direction) {
  const bool rtl = direction == TextDirection::kRtl;
  switch (align) {
    case TextAlign::kStart:
      return rtl ? TextAlign::kRight : TextAlign::kLeft;
    case TextAlign::kEnd:
      return rtl ? TextAlign::kLeft : TextAlign::kRight;
    default:
      return align;
  }
}

}  // namespace

extern "C" {

effing_paragraph* effing_paragraph_create(const char* text,
                                          size_t text_len,
                                          skiac_font_collection* c_collection,
                                          const char* font_family,
                                          const effing_paragraph_style* s) {
  c_collection->flushCachesIfDirty();
  auto font_collection = c_collection->collection;
  const auto families = split_families(font_family);
  const auto font_style =
      SkFontStyle(s->weight, SkFontStyle::kNormal_Width,
                  static_cast<SkFontStyle::Slant>(s->slant));
  const auto direction = static_cast<TextDirection>(s->direction);

  auto* out = new effing_paragraph();
  out->align = resolve_align(static_cast<TextAlign>(s->align), direction);
  out->nowrap = s->nowrap;
  out->ellipsized = s->ellipsis != nullptr && s->ellipsis[0] != '\0';

  const auto typefaces =
      font_collection->findTypefaces(families, font_style, std::nullopt);
  const sk_sp<SkTypeface> primary =
      typefaces.empty() ? nullptr : typefaces.front();
  if (!hhea_metrics(primary, s->font_size, &out->ascent, &out->descent)) {
    SkFont font(primary, s->font_size);
    SkFontMetrics m;
    font.getMetrics(&m);
    out->ascent = -m.fAscent;
    out->descent = m.fDescent;
  }
  out->line_height =
      s->line_height > 0 ? s->line_height : out->ascent + out->descent;

  TextStyle text_style;
  text_style.setFontFamilies(families);
  text_style.setFontSize(s->font_size);
  text_style.setFontStyle(font_style);
  text_style.setLetterSpacing(s->letter_spacing);
  // Unhinted outlines, so layout and placement don't depend on the device.
  text_style.setFontHinting(SkFontHinting::kNone);
  text_style.setTextBaseline(TextBaseline::kAlphabetic);

  // A forced strut makes every line exactly line_height tall (fallback fonts
  // can't grow it), with CSS half-leading around the primary font's metrics.
  StrutStyle strut;
  strut.setStrutEnabled(true);
  strut.setForceStrutHeight(true);
  strut.setFontFamilies(families);
  strut.setFontStyle(font_style);
  strut.setFontSize(s->font_size);
  strut.setHeight(out->line_height / s->font_size);
  strut.setHeightOverride(true);
  strut.setHalfLeading(true);
  strut.setLeading(0);

  ParagraphStyle paragraph_style;
  paragraph_style.setTextStyle(text_style);
  paragraph_style.setStrutStyle(strut);
  paragraph_style.setTextDirection(direction);
  // Only justify is Skia's job. The other alignments are applied per line at
  // layout time, relative to the layout width, so nowrap lines wider than the
  // box align like CSS.
  paragraph_style.setTextAlign(out->align == TextAlign::kJustify
                                   ? TextAlign::kJustify
                                   : TextAlign::kLeft);
  paragraph_style.setApplyRoundingHack(false);
  paragraph_style.setReplaceTabCharacters(true);
  if (s->max_lines > 0) {
    paragraph_style.setMaxLines(s->max_lines);
  } else if (out->nowrap && out->ellipsized) {
    paragraph_style.setMaxLines(1);
  }
  if (out->ellipsized) {
    paragraph_style.setEllipsis(SkString(s->ellipsis));
  }

  ParagraphBuilderImpl builder(paragraph_style, font_collection,
                               SkUnicodes::ICU::Make());
  builder.addText(text, text_len);
  out->paragraph = builder.Build();
  return out;
}

void effing_paragraph_layout(effing_paragraph* p, float width) {
  const float w = std::isfinite(width) && width > 0
                      ? std::min(width, kUnbounded)
                      : kUnbounded;
  // nowrap text only breaks at hard breaks, unless it is truncated with an
  // ellipsis, which needs the real width to know where to cut.
  const bool unbounded = p->nowrap && !p->ellipsized;
  p->paragraph->layout(unbounded ? kUnbounded : w);

  p->lines.clear();
  p->paragraph->getLineMetrics(p->lines);
  const size_t n = p->lines.size();

  p->line_widths.assign(n, 0.0f);
  for (size_t i = 0; i < n; i++) {
    p->line_widths[i] = static_cast<float>(p->lines[i].fWidth);
  }
  if (p->ellipsized) {
    // A line's metrics leave out an ellipsis Skia appended to it; the painted
    // runs include it.
    p->paragraph->visit([&](int line, const Paragraph::VisitorInfo* run) {
      if (run == nullptr || line < 0 || static_cast<size_t>(line) >= n) {
        return;
      }
      const float right =
          run->advanceX - static_cast<float>(p->lines[line].fLeft);
      p->line_widths[line] = std::max(p->line_widths[line], right);
    });
  }

  // CSS half-leading: each line box is exactly line_height tall, with the
  // baseline centred by the font's ascent and descent. Skia rounds line
  // heights to whole pixels and measures the strut with hinted metrics, so
  // its own baselines drift from this.
  const float baseline_in_box = (p->line_height + p->ascent - p->descent) / 2;
  p->line_origins.assign(n, {0, 0});
  for (size_t i = 0; i < n; i++) {
    const float slack = w - p->line_widths[i];
    float left = 0;
    if (w < kUnbounded && p->align == TextAlign::kRight) {
      left = slack;
    } else if (w < kUnbounded && p->align == TextAlign::kCenter) {
      left = slack / 2;
    }
    p->line_origins[i] = {left, i * p->line_height + baseline_in_box};
  }
}

void effing_paragraph_get_metrics(effing_paragraph* p,
                                  effing_paragraph_metrics* m) {
  m->line_count = static_cast<int>(p->lines.size());
  m->height = m->line_count * p->line_height;
  m->longest_line = p->paragraph->getLongestLine();
  m->min_intrinsic_width = p->paragraph->getMinIntrinsicWidth();
  m->max_intrinsic_width = p->paragraph->getMaxIntrinsicWidth();
  m->did_exceed_max_lines = p->paragraph->didExceedMaxLines();
  m->line_height = p->line_height;
  m->ascent = p->ascent;
  m->descent = p->descent;
}

void effing_paragraph_get_lines(effing_paragraph* p,
                                effing_paragraph_line* out,
                                int count) {
  const int n = std::min(count, static_cast<int>(p->lines.size()));
  for (int i = 0; i < n; i++) {
    const LineMetrics& line = p->lines[i];
    out[i].left = p->line_origins[i].fX;
    out[i].width = p->line_widths[i];
    out[i].baseline = p->line_origins[i].fY;
    out[i].start_index = line.fStartIndex;
    out[i].end_index = line.fEndExcludingWhitespaces;
    out[i].hard_break = line.fHardBreak;
  }
}

void effing_paragraph_paint(effing_paragraph* p,
                            skiac_canvas* c_canvas,
                            skiac_paint* c_paint,
                            float x,
                            float y) {
  effing::paint_paragraph_unsnapped(
      p->paragraph.get(), reinterpret_cast<SkCanvas*>(c_canvas), x, y,
      *reinterpret_cast<SkPaint*>(c_paint), p->line_origins.data());
}

void effing_paragraph_destroy(effing_paragraph* p) {
  delete p;
}

}  // extern "C"
