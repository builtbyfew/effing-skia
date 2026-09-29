// Lays out a single-style paragraph with SkParagraph and paints it unsnapped.
// Skia breaks the lines and shapes them; effing places them. Line boxes follow
// effing's (and satori's) CSS model: every line is exactly `line_height` tall,
// with the baseline placed by half-leading around the primary font's hhea
// ascender and descender.
#include "paragraph.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "include/core/SkFontMetrics.h"
#include "include/core/SkTypeface.h"
#include "text.hpp"

using namespace skia::textlayout;

struct effing_paragraph {
  // One paragraph, except for nowrap text with an ellipsis: that gets one per
  // hard-broken line, each truncated on its own, since Skia stops laying out
  // at the first line it ellipsizes.
  std::vector<std::unique_ptr<Paragraph>> paragraphs;
  // Where each paragraph's text starts in the whole text, in UTF-16 units.
  std::vector<size_t> offsets;
  // Whether hard-broken lines past max_lines were left out.
  bool dropped_lines = false;
  TextAlign align = TextAlign::kLeft;
  bool rtl = false;
  bool nowrap = false;
  bool ellipsized = false;
  float line_height = 0;
  float ascent = 0;
  float descent = 0;
  // Filled by layout, per line, indices relative to the whole text.
  std::vector<LineMetrics> lines;
  std::vector<float> line_widths;
  // Where effing puts each line's left edge and baseline.
  std::vector<SkPoint> line_origins;
  // The index in `lines` of each paragraph's first line.
  std::vector<size_t> first_lines;
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
  if (!typeface || typeface->getTableData(SkSetFourByteTag('h', 'h', 'e', 'a'),
                                          4, 4, buf) != 4) {
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

// The length of a hard line break (LF, VT, FF, CR, CRLF, NEL, LS or PS) at
// `text[i]`, in bytes, or 0 if there is none.
size_t hard_break_at(const char* text, size_t len, size_t i) {
  const auto c = static_cast<unsigned char>(text[i]);
  if (c == '\r') {
    return i + 1 < len && text[i + 1] == '\n' ? 2 : 1;
  }
  if (c >= '\n' && c <= '\f') {
    return 1;
  }
  const auto next = [&](size_t k) {
    return i + k < len ? static_cast<unsigned char>(text[i + k]) : 0;
  };
  if (c == 0xC2 && next(1) == 0x85) {
    return 2;
  }
  if (c == 0xE2 && next(1) == 0x80 && (next(2) == 0xA8 || next(2) == 0xA9)) {
    return 3;
  }
  return 0;
}

// The number of UTF-16 code units in `len` bytes of UTF-8.
size_t utf16_length(const char* text, size_t len) {
  size_t units = 0;
  for (size_t i = 0; i < len; i++) {
    const auto c = static_cast<unsigned char>(text[i]);
    if ((c & 0xC0) != 0x80) {
      units += c >= 0xF0 ? 2 : 1;
    }
  }
  return units;
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
  out->rtl = direction == TextDirection::kRtl;
  out->nowrap = s->nowrap;
  // Only max_lines and nowrap truncate; Skia would otherwise stop at the
  // first line.
  out->ellipsized = s->ellipsis != nullptr && s->ellipsis[0] != '\0' &&
                    (s->max_lines > 0 || s->nowrap);

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
  if (out->ellipsized) {
    paragraph_style.setEllipsis(SkString(s->ellipsis));
  }

  const auto unicode = SkUnicodes::ICU::Make();
  const auto add = [&](size_t start, size_t end) {
    ParagraphBuilderImpl builder(paragraph_style, font_collection, unicode);
    builder.addText(text + start, end - start);
    out->paragraphs.push_back(builder.Build());
    out->offsets.push_back(utf16_length(text, start));
  };
  if (!(out->nowrap && out->ellipsized)) {
    if (s->max_lines > 0) {
      paragraph_style.setMaxLines(s->max_lines);
    }
    add(0, text_len);
    return out;
  }
  // One line per hard break, each truncated to the width.
  paragraph_style.setMaxLines(1);
  const size_t max_lines =
      s->max_lines > 0 ? static_cast<size_t>(s->max_lines) : SIZE_MAX;
  size_t start = 0;
  for (size_t i = 0; i <= text_len;) {
    const size_t brk = i < text_len ? hard_break_at(text, text_len, i) : 0;
    if (brk == 0 && i < text_len) {
      i++;
      continue;
    }
    if (out->paragraphs.size() == max_lines) {
      out->dropped_lines = true;
      break;
    }
    add(start, i);
    if (brk == 0) {
      break;
    }
    i += brk;
    start = i;
  }
  return out;
}

void effing_paragraph_layout(effing_paragraph* p, float width) {
  const float w = std::isfinite(width) && width > 0
                      ? std::min(width, kUnbounded)
                      : kUnbounded;
  // nowrap text only breaks at hard breaks, unless it is truncated with an
  // ellipsis, which needs the real width to know where to cut.
  const bool unbounded = p->nowrap && !p->ellipsized;

  p->lines.clear();
  p->line_widths.clear();
  p->first_lines.clear();
  for (size_t k = 0; k < p->paragraphs.size(); k++) {
    Paragraph* paragraph = p->paragraphs[k].get();
    paragraph->layout(unbounded ? kUnbounded : w);
    const size_t first = p->lines.size();
    p->first_lines.push_back(first);
    std::vector<LineMetrics> lines;
    paragraph->getLineMetrics(lines);
    if (lines.empty() && p->paragraphs.size() > 1) {
      // An empty hard-broken line still takes a line box, as it does when
      // Skia lays out the whole text.
      lines.emplace_back();
      lines.back().fHardBreak = true;
    }
    for (LineMetrics& line : lines) {
      const size_t offset = p->offsets[k];
      line.fStartIndex += offset;
      line.fEndIndex += offset;
      line.fEndExcludingWhitespaces += offset;
      line.fEndIncludingNewline += offset;
      line.fLineNumber = p->lines.size();
      p->lines.push_back(line);
      p->line_widths.push_back(static_cast<float>(line.fWidth));
    }
    if (p->ellipsized) {
      // A line's metrics leave out an ellipsis Skia appended to it; the
      // painted runs include it.
      const size_t n = lines.size();
      paragraph->visit([&](int line, const Paragraph::VisitorInfo* run) {
        if (run == nullptr || line < 0 || static_cast<size_t>(line) >= n) {
          return;
        }
        const float right =
            run->advanceX - static_cast<float>(lines[line].fLeft);
        float& line_width = p->line_widths[first + line];
        line_width = std::max(line_width, right);
      });
    }
  }
  const size_t n = p->lines.size();

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
    } else if (w < kUnbounded && p->align == TextAlign::kJustify) {
      // Skia justifies the lines itself, and right-aligns the ones it
      // doesn't justify in RTL text; keep its shift. Unbounded nowrap lines
      // all end in hard breaks, so they start-align.
      left = !unbounded ? static_cast<float>(p->lines[i].fLeft)
             : p->rtl   ? slack
                        : 0;
    }
    p->line_origins[i] = {left, i * p->line_height + baseline_in_box};
  }
}

void effing_paragraph_get_metrics(effing_paragraph* p,
                                  effing_paragraph_metrics* m) {
  m->line_count = static_cast<int>(p->lines.size());
  m->height = m->line_count * p->line_height;
  m->longest_line = 0;
  m->min_intrinsic_width = 0;
  m->max_intrinsic_width = 0;
  m->did_exceed_max_lines = p->dropped_lines;
  for (const auto& paragraph : p->paragraphs) {
    m->longest_line = std::max(m->longest_line, paragraph->getLongestLine());
    m->min_intrinsic_width =
        std::max(m->min_intrinsic_width, paragraph->getMinIntrinsicWidth());
    m->max_intrinsic_width =
        std::max(m->max_intrinsic_width, paragraph->getMaxIntrinsicWidth());
  }
  // Each line of nowrap text with an ellipsis is its own one-line paragraph,
  // which "exceeds" its one line whenever it is truncated to the width.
  if (!(p->nowrap && p->ellipsized)) {
    m->did_exceed_max_lines = p->paragraphs.front()->didExceedMaxLines();
  }
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
  for (size_t k = 0; k < p->paragraphs.size(); k++) {
    effing::paint_paragraph_unsnapped(
        p->paragraphs[k].get(), reinterpret_cast<SkCanvas*>(c_canvas), x, y,
        *reinterpret_cast<SkPaint*>(c_paint),
        p->line_origins.data() + p->first_lines[k]);
  }
}

void effing_paragraph_destroy(effing_paragraph* p) {
  delete p;
}

}  // extern "C"
