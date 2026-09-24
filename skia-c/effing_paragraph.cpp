// Lays out a single-style paragraph with SkParagraph and paints it without
// grid snapping. Line boxes follow effing's (and satori's) CSS model: every
// line is exactly `line_height` tall, with the baseline placed by half-leading
// around the primary font's hhea ascender and descender.
#include "effing_paragraph.hpp"

#include <algorithm>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include "effing.hpp"
#include "include/core/SkFontMetrics.h"
#include "include/core/SkTypeface.h"

using namespace skia::textlayout;

struct effing_paragraph {
  std::unique_ptr<Paragraph> paragraph;
  float letter_spacing = 0;
  int align = 0;
  bool nowrap = false;
  bool ellipsized = false;
  float line_height = 0;
  float ascent = 0;
  float descent = 0;
  // Skia breaks lines and shapes them horizontally; effing places them. Per
  // line: the left edge and baseline effing wants, and the offset from where
  // Skia put the line, applied at paint time.
  std::vector<float> line_left;
  std::vector<float> line_baseline;
  std::vector<SkVector> line_offsets;
};

namespace {

// Wide enough for any real layout, small enough to stay exact in float.
constexpr float kUnbounded = 1e7f;

std::vector<SkString> parse_families(const char* font_family) {
  std::vector<SkString> families;
  std::string list(font_family);
  size_t start = 0;
  while (start <= list.size()) {
    size_t end = list.find(',', start);
    if (end == std::string::npos) {
      end = list.size();
    }
    std::string name = list.substr(start, end - start);
    auto first = name.find_first_not_of(" \t\"'");
    auto last = name.find_last_not_of(" \t\"'");
    if (first != std::string::npos) {
      families.emplace_back(name.substr(first, last - first + 1).c_str());
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
  int upem = typeface->getUnitsPerEm();
  if (upem <= 0) {
    return false;
  }
  *ascent = read_be_i16(buf) / static_cast<float>(upem) * font_size;
  *descent = -read_be_i16(buf + 2) / static_cast<float>(upem) * font_size;
  return true;
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
  auto families = parse_families(font_family);
  auto font_style = SkFontStyle(s->weight, SkFontStyle::kNormal_Width,
                                static_cast<SkFontStyle::Slant>(s->slant));

  auto out = new effing_paragraph();
  out->letter_spacing = s->letter_spacing;
  out->align = s->align;
  out->nowrap = s->nowrap;
  out->ellipsized = s->ellipsis != nullptr && s->ellipsis[0] != '\0';

  auto typefaces =
      font_collection->findTypefaces(families, font_style, std::nullopt);
  sk_sp<SkTypeface> primary = typefaces.empty() ? nullptr : typefaces.front();
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
  paragraph_style.setTextDirection(s->rtl ? TextDirection::kRtl
                                          : TextDirection::kLtr);
  // Alignment other than justify is applied per line at paint time, relative
  // to the layout width, so nowrap lines wider than the box align like CSS.
  paragraph_style.setTextAlign(s->align == 3 ? TextAlign::kJustify
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
  float w = std::isfinite(width) && width > 0 ? std::min(width, kUnbounded)
                                              : kUnbounded;
  // nowrap text only breaks at hard breaks, unless it is truncated with an
  // ellipsis, which needs the real width to know where to cut.
  bool unbounded = p->nowrap && !p->ellipsized;
  p->paragraph->layout(unbounded ? kUnbounded : w);

  std::vector<LineMetrics> lines;
  p->paragraph->getLineMetrics(lines);
  const size_t n = lines.size();
  p->line_left.assign(n, 0.0f);
  p->line_baseline.assign(n, 0.0f);
  p->line_offsets.assign(n, {0, 0});
  // CSS half-leading: each line box is exactly line_height tall, with the
  // baseline centred by the font's ascent and descent. Skia rounds line
  // heights to whole pixels and measures the strut with hinted metrics, so
  // its own baselines drift from this.
  const float baseline_in_box =
      (p->line_height + p->ascent - p->descent) / 2;
  for (size_t i = 0; i < n; i++) {
    // fLeft is where the line's first glyph sits; with letter spacing Skia
    // puts half of it before that glyph, where CSS puts all of it after.
    const float skia_left = static_cast<float>(lines[i].fLeft);
    const float slack = w - static_cast<float>(lines[i].fWidth);
    float left = 0;
    if (w < kUnbounded && p->align == 1) {
      left = slack;
    } else if (w < kUnbounded && p->align == 2) {
      left = slack / 2;
    }
    const float baseline = i * p->line_height + baseline_in_box;
    p->line_left[i] = left;
    p->line_baseline[i] = baseline;
    p->line_offsets[i] = {left - skia_left,
                          baseline - static_cast<float>(lines[i].fBaseline)};
  }
}

void effing_paragraph_get_metrics(effing_paragraph* p,
                                  effing_paragraph_metrics* m) {
  m->line_count = static_cast<int>(p->line_offsets.size());
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
  std::vector<LineMetrics> lines;
  p->paragraph->getLineMetrics(lines);
  int n = std::min(count, static_cast<int>(lines.size()));
  for (int i = 0; i < n; i++) {
    const auto& l = lines[i];
    out[i].left = p->line_left[i];
    out[i].width = l.fWidth;
    out[i].baseline = p->line_baseline[i];
    out[i].ascent = p->ascent;
    out[i].descent = p->descent;
    out[i].height = p->line_height;
    out[i].start_index = l.fStartIndex;
    out[i].end_index = l.fEndExcludingWhitespaces;
    out[i].hard_break = l.fHardBreak;
  }
}

void effing_paragraph_paint(effing_paragraph* p,
                            skiac_canvas* c_canvas,
                            skiac_paint* c_paint,
                            float x,
                            float y) {
  effing::paint_paragraph_unsnapped(
      p->paragraph.get(), reinterpret_cast<SkCanvas*>(c_canvas), x, y,
      *reinterpret_cast<SkPaint*>(c_paint), &p->line_offsets);
}

void effing_paragraph_destroy(effing_paragraph* p) {
  delete p;
}

}  // extern "C"
