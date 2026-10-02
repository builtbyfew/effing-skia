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
  bool keep_trailing_whitespace = false;
  float line_height = 0;
  float ascent = 0;
  float descent = 0;
  // The primary font's x-height, for middle-aligned placeholders.
  float x_height = 0;
  // Each placeholder, in order, with the paragraph it went into (SIZE_MAX if
  // its line was dropped) and its UTF-16 index in that paragraph's text.
  struct Placeholder {
    effing_paragraph_placeholder spec;
    size_t paragraph = SIZE_MAX;
    size_t index = 0;
  };
  std::vector<Placeholder> placeholders;
  // Filled by layout, per line, indices relative to the whole text.
  std::vector<LineMetrics> lines;
  // Trailing whitespace included where it is kept.
  std::vector<float> line_widths;
  // The width of each line's kept trailing whitespace, which in RTL lies
  // left of its glyphs.
  std::vector<float> kept_whitespace;
  // Where effing puts each line's glyphs: their left edge and baseline.
  std::vector<SkPoint> line_origins;
  // The index in `lines` of each paragraph's first line.
  std::vector<size_t> first_lines;
  // The UTF-16 index of each hard break in the whole text.
  std::vector<size_t> hard_breaks;
  // Where each placeholder landed.
  std::vector<effing_paragraph_placeholder_box> placeholder_boxes;
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

// The length of a hard line break at `text[i]`, in bytes, or 0 if there is
// none. These are SkParagraph's: LF, VT, FF, CRLF, LS and PS (ICU's
// LINE_FEED and MANDATORY_BREAK classes); a lone CR and NEL are not.
size_t hard_break_at(const char* text, size_t len, size_t i) {
  const auto c = static_cast<unsigned char>(text[i]);
  if (c == '\r') {
    // A lone CR is not a break to SkParagraph.
    return i + 1 < len && text[i + 1] == '\n' ? 2 : 0;
  }
  if (c >= '\n' && c <= '\f') {
    return 1;
  }
  const auto byte = [&](size_t k) {
    return i + k < len ? static_cast<unsigned char>(text[i + k]) : 0;
  };
  if (c == 0xE2 && byte(1) == 0x80 && (byte(2) == 0xA8 || byte(2) == 0xA9)) {
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

// Adds text[start, end) to `builder` with the placeholders in it: those from
// `*next` on whose offset is at most `end`, each where its offset puts it.
// Advances `*next` past them, and reports each one's index in `placeholders`
// and its UTF-16 index from `start`, where Skia's U+FFFC for it lands, to
// `placed`.
template <typename Placed>
void add_content(ParagraphBuilder* builder,
                 const char* text,
                 size_t start,
                 size_t end,
                 const effing_paragraph_placeholder* placeholders,
                 size_t placeholder_count,
                 size_t* next,
                 Placed placed) {
  size_t at = start;
  size_t index = 0;
  for (; *next < placeholder_count && placeholders[*next].offset <= end;
       ++*next) {
    const auto& spec = placeholders[*next];
    const size_t offset = std::max(spec.offset, at);
    if (offset > at) {
      builder->addText(text + at, offset - at);
      index += utf16_length(text + at, offset - at);
      at = offset;
    }
    // Its height and alignment only matter to Skia for line heights, which
    // the forced strut fixes; effing places it vertically itself. Skia loses
    // track of a placeholder with no width and no height, so it always gets
    // one.
    const float height = std::max(spec.height, 1.f);
    builder->addPlaceholder(
        PlaceholderStyle(spec.width, height, PlaceholderAlignment::kBaseline,
                         TextBaseline::kAlphabetic, height));
    placed(*next, index++);
  }
  if (end > at) {
    builder->addText(text + at, end - at);
  }
}

// The UTF-16 index (each placeholder taking one unit) of every hard line
// break in the text, in order.
std::vector<size_t> hard_break_indices(
    const char* text,
    size_t len,
    const effing_paragraph_placeholder* placeholders,
    size_t placeholder_count) {
  std::vector<size_t> breaks;
  size_t units = 0;
  size_t next = 0;
  for (size_t i = 0; i < len;) {
    // A placeholder at a break's offset comes before it.
    while (next < placeholder_count && placeholders[next].offset <= i) {
      next++;
    }
    const size_t brk = hard_break_at(text, len, i);
    const size_t step = brk > 0 ? brk : 1;
    if (brk > 0) {
      breaks.push_back(units + next);
    }
    units += utf16_length(text + i, step);
    i += step;
  }
  return breaks;
}

// The font's x-height in px, as CSS `vertical-align: middle` uses it: from
// the OS/2 table, or else the height of the glyph 'x'.
float x_height(const sk_sp<SkTypeface>& typeface, float font_size) {
  SkFont font(typeface, font_size);
  font.setHinting(SkFontHinting::kNone);
  SkFontMetrics m;
  font.getMetrics(&m);
  if (m.fXHeight != 0) {
    return std::abs(m.fXHeight);
  }
  const SkGlyphID x = font.unicharToGlyph('x');
  return std::max(0.f, -font.getBounds(x, nullptr).fTop);
}

// The top of a placeholder of `spec` on a line whose box starts at `top`,
// `line_height` tall, with its baseline at `baseline`.
float placeholder_top(const effing_paragraph* p,
                      const effing_paragraph_placeholder& spec,
                      float top,
                      float baseline) {
  switch (spec.align) {
    case EFFING_PLACEHOLDER_MIDDLE:
      return baseline - p->x_height / 2 - spec.height / 2;
    case EFFING_PLACEHOLDER_TOP:
      return top;
    case EFFING_PLACEHOLDER_BOTTOM:
      return top + p->line_height - spec.height;
    case EFFING_PLACEHOLDER_TEXT_TOP:
      return baseline - p->ascent;
    case EFFING_PLACEHOLDER_TEXT_BOTTOM:
      return baseline + p->descent - spec.height;
    default:
      return baseline - spec.baseline_offset;
  }
}

}  // namespace

extern "C" {

effing_paragraph* effing_paragraph_create(
    const char* text,
    size_t text_len,
    skiac_font_collection* c_collection,
    const char* font_family,
    const effing_paragraph_style* s,
    const effing_paragraph_placeholder* placeholders,
    size_t placeholder_count) {
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
  out->keep_trailing_whitespace = s->keep_trailing_whitespace;
  // Only max_lines and nowrap truncate; Skia would otherwise stop at the
  // first line.
  out->ellipsized = s->ellipsis_len > 0 && (s->max_lines > 0 || s->nowrap);

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
      s->line_height >= 0 ? s->line_height : out->ascent + out->descent;
  out->x_height = placeholder_count > 0 ? x_height(primary, s->font_size) : 0;

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
  // Only justify is Skia's job, and only for text that wraps: every line of
  // nowrap text ends in a hard break or the text, which CSS never justifies,
  // and Skia would right-align them in RTL at the unbounded width, where
  // floats are too coarse for sub-pixel positions. The alignments are
  // applied per line at layout time, relative to the layout width.
  paragraph_style.setTextAlign(out->align == TextAlign::kJustify && !out->nowrap
                                   ? TextAlign::kJustify
                                   : TextAlign::kLeft);
  paragraph_style.setApplyRoundingHack(false);
  paragraph_style.setReplaceTabCharacters(true);
  if (out->ellipsized) {
    paragraph_style.setEllipsis(SkString(s->ellipsis, s->ellipsis_len));
  }

  out->hard_breaks =
      hard_break_indices(text, text_len, placeholders, placeholder_count);
  out->placeholders.reserve(placeholder_count);
  for (size_t i = 0; i < placeholder_count; i++) {
    out->placeholders.push_back({placeholders[i]});
  }
  // The next placeholder to place; each takes one UTF-16 unit (U+FFFC).
  size_t next = 0;
  const auto unicode = SkUnicodes::ICU::Make();
  // Builds a paragraph of text[start, end), with the placeholders up to `end`
  // in it.
  const auto add = [&](size_t start, size_t end) {
    ParagraphBuilderImpl builder(paragraph_style, font_collection, unicode);
    out->offsets.push_back(utf16_length(text, start) + next);
    const size_t k = out->paragraphs.size();
    add_content(&builder, text, start, end, placeholders, placeholder_count,
                &next, [&](size_t placeholder, size_t index) {
                  out->placeholders[placeholder].paragraph = k;
                  out->placeholders[placeholder].index = index;
                });
    out->paragraphs.push_back(builder.Build());
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
  p->kept_whitespace.clear();
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
      // Skia counts a hard break that ends the text in the line before it;
      // the line's text stops at its first hard break.
      const auto brk = std::lower_bound(
          p->hard_breaks.begin(), p->hard_breaks.end(), line.fStartIndex);
      if (brk != p->hard_breaks.end()) {
        line.fEndIndex = std::max(line.fEndExcludingWhitespaces,
                                  std::min(line.fEndIndex, *brk));
      }
      // Whitespace before a hard break or the end of the text is kept as
      // white-space: pre and pre-wrap keep it; Skia lets it hang. Spaces
      // draw nothing, so their width is all there is to add.
      float kept = 0;
      if (p->keep_trailing_whitespace && line.fHardBreak &&
          line.fEndIndex > line.fEndExcludingWhitespaces) {
        for (const auto& box : paragraph->getRectsForRange(
                 line.fEndExcludingWhitespaces - offset,
                 line.fEndIndex - offset, RectHeightStyle::kTight,
                 RectWidthStyle::kTight)) {
          kept += box.rect.width();
        }
      }
      line.fLineNumber = p->lines.size();
      p->lines.push_back(line);
      p->line_widths.push_back(static_cast<float>(line.fWidth) + kept);
      p->kept_whitespace.push_back(kept);
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
        line_width =
            std::max(line_width, right + p->kept_whitespace[first + line]);
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
    if (w >= kUnbounded) {
      // No width to align to.
    } else if (slack < 0) {
      // A line wider than the box is start-aligned and overflows the box's
      // end edge, as in CSS.
      left = p->rtl ? slack : 0;
    } else if (p->align == TextAlign::kRight) {
      left = slack;
    } else if (p->align == TextAlign::kCenter) {
      left = slack / 2;
    } else if (p->align == TextAlign::kJustify) {
      // Skia spread the lines it could justify over the whole width, so
      // they have no slack; the others start-align. Skia's own left edge is
      // not used: it includes half the letter spacing, which the painter
      // cancels for every other alignment.
      left = p->rtl ? slack : 0;
    }
    // Kept whitespace ends the line, which in RTL is its left end.
    if (p->rtl) {
      left += p->kept_whitespace[i];
    }
    p->line_origins[i] = {left, i * p->line_height + baseline_in_box};
  }

  // Skia puts each placeholder in its line; effing moves it with the line,
  // and places it vertically by its alignment in effing's line box.
  p->placeholder_boxes.assign(p->placeholders.size(), {});
  for (size_t j = 0; j < p->placeholders.size(); j++) {
    const auto& placeholder = p->placeholders[j];
    const size_t k = placeholder.paragraph;
    if (k >= p->paragraphs.size()) {
      continue;
    }
    // Its line, unless max_lines or an ellipsis cut it off.
    const size_t index = p->offsets[k] + placeholder.index;
    const size_t end =
        k + 1 < p->first_lines.size() ? p->first_lines[k + 1] : n;
    size_t i = p->first_lines[k];
    while (i < end && !(p->lines[i].fStartIndex <= index &&
                        index < p->lines[i].fEndIndex)) {
      i++;
    }
    if (i == end) {
      continue;
    }
    const auto rects = p->paragraphs[k]->getRectsForRange(
        placeholder.index, placeholder.index + 1, RectHeightStyle::kTight,
        RectWidthStyle::kTight);
    if (rects.empty()) {
      continue;
    }
    const SkPoint origin = p->line_origins[i];
    const auto& spec = placeholder.spec;
    auto& box = p->placeholder_boxes[j];
    box.visible = true;
    box.x = origin.fX + rects.front().rect.fLeft -
            static_cast<float>(p->lines[i].fLeft);
    box.y = placeholder_top(p, spec, i * p->line_height, origin.fY);
    box.width = spec.width;
    box.height = spec.height;
    box.line = static_cast<int>(i);
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
  // Skia's longest line leaves trailing whitespace out, even where it is
  // kept.
  // Skia's longest line includes an ellipsis but leaves trailing whitespace
  // out even where it is kept, so add that to each line's own width (which
  // leaves the ellipsis out; a truncated line has no trailing whitespace).
  if (p->keep_trailing_whitespace) {
    for (size_t i = 0; i < p->lines.size(); i++) {
      m->longest_line =
          std::max(m->longest_line, static_cast<float>(p->lines[i].fWidth) +
                                        p->kept_whitespace[i]);
    }
  }
  for (const auto& paragraph : p->paragraphs) {
    m->longest_line = std::max(m->longest_line, paragraph->getLongestLine());
    m->min_intrinsic_width =
        std::max(m->min_intrinsic_width, paragraph->getMinIntrinsicWidth());
    m->max_intrinsic_width =
        std::max(m->max_intrinsic_width, paragraph->getMaxIntrinsicWidth());
  }
  // Skia's minimum is the widest word, which nowrap text cannot shrink to:
  // its min-content width is its max-content width, as in CSS.
  if (p->nowrap) {
    m->min_intrinsic_width = m->max_intrinsic_width;
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
    const bool kept = p->keep_trailing_whitespace && line.fHardBreak;
    out[i].left = p->line_origins[i].fX - (p->rtl ? p->kept_whitespace[i] : 0);
    out[i].width = p->line_widths[i];
    out[i].baseline = p->line_origins[i].fY;
    out[i].start_index = line.fStartIndex;
    out[i].end_index = kept ? line.fEndIndex : line.fEndExcludingWhitespaces;
    out[i].hard_break = line.fHardBreak;
  }
}

void effing_paragraph_get_placeholders(effing_paragraph* p,
                                       effing_paragraph_placeholder_box* out,
                                       int count) {
  const int n =
      std::min(count, static_cast<int>(p->placeholder_boxes.size()));
  std::copy_n(p->placeholder_boxes.begin(), std::max(n, 0), out);
}

void effing_paragraph_paint(effing_paragraph* p,
                            skiac_canvas* c_canvas,
                            skiac_paint* c_paint,
                            float x,
                            float y,
                            effing_painted* painted) {
  *painted = {};
  // Nowhere to put the lines until effing_paragraph_layout has run.
  if (p->first_lines.size() != p->paragraphs.size()) {
    return;
  }
  effing::Painted drawn;
  for (size_t k = 0; k < p->paragraphs.size(); k++) {
    effing::paint_paragraph_unsnapped(
        p->paragraphs[k].get(), reinterpret_cast<SkCanvas*>(c_canvas), x, y,
        *reinterpret_cast<SkPaint*>(c_paint),
        p->line_origins.data() + p->first_lines[k], &drawn);
  }
  drawn.export_to(painted);
}

void effing_paragraph_destroy(effing_paragraph* p) {
  delete p;
}

}  // extern "C"
