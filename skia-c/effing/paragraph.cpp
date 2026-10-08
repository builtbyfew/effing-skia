// Lays out a single-style paragraph with SkParagraph and paints it unsnapped.
// Skia breaks the lines and shapes them; effing places them. Line boxes follow
// effing's (and satori's) CSS model: every line is exactly `line_height` tall,
// with the baseline placed by half-leading around the primary font's hhea
// ascender and descender, rounded as Chrome rounds them.
#include "paragraph.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "include/core/SkFontMetrics.h"
#include "include/core/SkTypeface.h"
#include "modules/skunicode/include/SkUnicode_icu.h"
#include "text.hpp"
#include "word_break.hpp"

using namespace skia::textlayout;

struct effing_paragraph {
  // One paragraph, except for nowrap text with an ellipsis: that gets one per
  // hard-broken line, each truncated on its own, since Skia stops laying out
  // at the first line it ellipsizes.
  std::vector<std::unique_ptr<Paragraph>> paragraphs;
  // Where each paragraph's text starts in the whole text, in UTF-16 units.
  std::vector<size_t> offsets;
  // What each paragraph is built from: its text in `text`, and the
  // placeholders [first, last).
  struct Source {
    size_t start;
    size_t end;
    size_t first;
    size_t last;
  };
  std::vector<Source> sources;
  // Whether hard-broken lines past max_lines were left out.
  bool dropped_lines = false;
  // When they were, in nowrap text with an ellipsis, the last line kept has
  // the ellipsis after its text, as CSS line-clamp has it: where that text
  // ends, in UTF-16 units of the whole text. SIZE_MAX otherwise.
  size_t clamped_end = SIZE_MAX;
  TextAlign align = TextAlign::kLeft;
  bool rtl = false;
  bool nowrap = false;
  bool ellipsized = false;
  bool keep_trailing_whitespace = false;
  float line_height = 0;
  float ascent = 0;
  float descent = 0;
  float line_gap = 0;
  // The ascent and descent rounded to whole pixels, as Chrome's content area
  // has them: what the half-leading and text-top/text-bottom go from.
  float content_ascent = 0;
  float content_descent = 0;
  // The primary font's x-height, for middle-aligned placeholders.
  float x_height = 0;
  // Where `text` has the U+2063 that stands for each lone CR (hide_lone_crs),
  // by UTF-8 offset, in order.
  std::vector<size_t> lone_crs;
  // The hyphen a line that breaks at a soft hyphen (U+00AD) ends with, as
  // CSS hyphens: manual has it (soft_hyphen_end): U+2010 if the primary font
  // has it, else "-", as Chrome picks it. Empty when no line can break at a
  // soft hyphen. Its width once measured (hyphen_width), or negative.
  std::string hyphen;
  float hyphen_width = -1;
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
  // The whole text's length in UTF-16 units, and whether a hard break ends
  // it, which makes an empty last line.
  size_t length = 0;
  bool ends_in_hard_break = false;
  // Where each placeholder landed.
  std::vector<effing_paragraph_placeholder_box> placeholder_boxes;

  // Word breaking (word_break.hpp). What the paragraphs are built from, kept
  // so that layout can build the pieces a word too wide for its line splits
  // the text into.
  effing::WordBreak word_break = effing::WordBreak::kNormal;
  effing::OverflowWrap overflow_wrap = effing::OverflowWrap::kNormal;
  int max_lines = 0;
  std::string text;
  std::vector<effing_paragraph_placeholder> placeholder_specs;
  ParagraphStyle paragraph_style;
  std::vector<SkString> strut_families;
  sk_sp<FontCollection> font_collection;
  // The words of wrapping text, what lies between two line-break
  // opportunities, by offset in the Skia text of `paragraphs.front()` (UTF-8,
  // U+FFFC for each placeholder), with their width without trailing
  // whitespace at the start of a line. Measured on the first layout.
  struct Word {
    size_t start;
    size_t end;
    // Where its trailing whitespace starts.
    size_t content_end;
    float width;
  };
  std::vector<Word> words;
  // The same for each grapheme cluster; a space's content ends at its start.
  std::vector<Word> graphemes;
  bool measured = false;
  float widest_word = 0;
  // The line-break opportunities in that Skia text, by offset, when it has
  // placeholders (SkParagraph's flags have one around each); empty
  // otherwise.
  std::vector<bool> opportunities;
  // Where that text has no opportunity beside a placeholder, sorted: where
  // SkParagraph may end a line it shouldn't (misplaced_break).
  std::vector<size_t> glued;
  // Where a line of that text may start at a glyph kerned against the space
  // before it, sorted (kerned_line_start).
  std::vector<size_t> kerned;
  // The runs of spaces and tabs that start a line of that Skia text, at its
  // start or after a hard break, [first, second), where whitespace isn't
  // kept: white-space: normal collapses them away. Not those that end it.
  std::vector<std::pair<size_t, size_t>> collapsed;
  // The bidi levels of that Skia text, which the pieces it is split into
  // take, or empty when they are all the paragraph's own.
  std::vector<SkUnicode::BidiRegion> bidi;
  // CSS max-content: the widest hard line of the whole text, measured on the
  // first layout (measure_max_content), or negative before it.
  float max_content = -1;
  // That Skia text's UTF-8 offset at each UTF-16 offset.
  std::vector<size_t> utf8_offsets;
  // Laid out and painted in place of `paragraphs` when a word too wide for
  // its line splits the text, or when SkParagraph emptied a line it was to
  // truncate with the ellipsis; empty otherwise.
  enum class PieceKind { kWrapped, kUnbounded, kBreakFirstWord };
  struct Piece {
    std::unique_ptr<Paragraph> paragraph;
    // Its text in the Skia text, without a hard break that ends it.
    size_t start;
    size_t end;
    PieceKind kind;
    // Where its text starts in the whole text, in UTF-16 units.
    size_t offset;
    // Whether a hard break that ends it was left out of its text.
    bool hard_break;
    // Where its last line's text ends, in UTF-16 units of the whole text,
    // when Skia's line metrics say otherwise: before an ellipsis it was given
    // as text, or after a hard break its text ends in, where the line is
    // empty; SIZE_MAX otherwise.
    size_t line_end;
    bool empty_last_line;
    // The placeholders in it: their index in `placeholders` and in its text.
    std::vector<std::pair<size_t, size_t>> placed;
    // The line limit it was built with (0 for none), and whether text was
    // added after it.
    int max_lines;
    bool suffixed;
    // Whether its last line ends where `hard_break` says, rather than where
    // Skia does: Skia takes the end of a piece's text for a hard break.
    bool override_hard_break;
    // When its text ends at a soft break, the number of lines it lays out
    // in, which a sentinel after it keeps from being the last; 0 otherwise.
    int soft_lines;
    // Whether its text ends at a soft hyphen where its last line breaks, with
    // the hyphen after it.
    bool hyphen;
    // Where the spaces that hang after that hyphen end, in UTF-16 units of
    // the whole text: they are left out of its text, but are its last
    // line's, as a line's hanging spaces are. 0 otherwise.
    size_t hanging_end;
  };
  std::vector<Piece> pieces;
  bool pieces_exceeded_max_lines = false;
  // The width the last layout was at, or negative.
  float laid_out_width = -1;
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

// The font's hhea ascender, descender and line gap in px, which effing (like
// satori, through opentype.js) uses for line boxes, as Chrome on macOS
// (CoreText) does. Skia's own metrics prefer the OS/2 typo values when
// USE_TYPO_METRICS is set, so read the table directly. A negative line gap is
// 0, as in Chrome.
bool hhea_metrics(const sk_sp<SkTypeface>& typeface,
                  float font_size,
                  float* ascent,
                  float* descent,
                  float* line_gap) {
  uint8_t buf[6];
  if (!typeface || typeface->getTableData(SkSetFourByteTag('h', 'h', 'e', 'a'),
                                          4, 6, buf) != 6) {
    return false;
  }
  const int upem = typeface->getUnitsPerEm();
  if (upem <= 0) {
    return false;
  }
  *ascent = read_be_i16(buf) / static_cast<float>(upem) * font_size;
  *descent = -read_be_i16(buf + 2) / static_cast<float>(upem) * font_size;
  *line_gap = std::max(
      read_be_i16(buf + 4) / static_cast<float>(upem) * font_size, 0.f);
  return true;
}

// A length in px as Chrome lays it out: in LayoutUnits of 1/64px, to which
// Blink rounds a px line height (ComputedLineHeightAsFixed).
float to_layout_units(float px) {
  const float rounded = std::round(px * 64) / 64;
  return std::isfinite(rounded) ? rounded : px;
}

// A font's ascent or descent as Chrome's content area has it: rounded half up
// to whole pixels (FontMetrics::AscentDescentWithHacks).
float round_metric(float px) {
  return std::floor(px + 0.5f);
}

// The baseline's distance from the top of a line box `line_height` tall, by
// Chrome's half-leading (CalculateLeadingSpace in Blink's inline layout): the
// leading is the line height less the content area, and the half above it is
// floored to whole pixels, the odd pixel and any fraction going below. The
// leading can be negative (a line height smaller than the content area), and
// is floored the same way. Blink halves in LayoutUnits, truncating towards 0.
float baseline_in_line_box(float line_height,
                           float content_ascent,
                           float content_descent) {
  // In LayoutUnits: line_height is a whole number of them (to_layout_units),
  // so the leading is too, and halving it truncates as Blink's integer
  // division does.
  const double leading = static_cast<double>(line_height) * 64 -
                         (content_ascent + content_descent) * 64.0;
  const double above = std::floor(std::trunc(leading / 2) / 64);
  return content_ascent + static_cast<float>(above);
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

// Whether one of the `count` placeholders, which are in order, sits at
// `offset`.
bool placeholder_at(const effing_paragraph_placeholder* placeholders,
                    size_t count,
                    size_t offset) {
  const auto* end = placeholders + count;
  const auto* it =
      std::lower_bound(placeholders, end, offset,
                       [](const effing_paragraph_placeholder& placeholder,
                          size_t at) { return placeholder.offset < at; });
  return it != end && it->offset == offset;
}

// The length of a hard line break at `text[i]`, in bytes, or 0 if there is
// none. These are SkParagraph's: LF, VT, FF, CRLF, LS and PS (ICU's
// LINE_FEED and MANDATORY_BREAK classes); a lone CR and NEL are not. A CR
// and an LF with a placeholder between them are a lone CR and an LF.
size_t hard_break_at(const char* text,
                     size_t len,
                     size_t i,
                     const effing_paragraph_placeholder* placeholders,
                     size_t placeholder_count) {
  const auto c = static_cast<unsigned char>(text[i]);
  if (c == '\r') {
    return i + 1 < len && text[i + 1] == '\n' &&
                   !placeholder_at(placeholders, placeholder_count, i + 1)
               ? 2
               : 0;
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

// Replaces each lone CR in the text, one that is not part of a CRLF, with
// U+2063 INVISIBLE SEPARATOR, into `out_text`, moving the placeholders after
// it into `out_placeholders`; false, leaving both alone, when there is none.
// Chrome lays a lone CR out under white-space: pre and pre-wrap as nothing:
// zero-width, with no letter spacing, and no line-break opportunity before it
// but after spaces, nor after it. SkParagraph would shape it, drawing the
// font's .notdef where the font maps no glyph to it, and break lines after
// it. U+2063 is default-ignorable, which HarfBuzz hides, and to the line
// breaker a letter (UAX #14 class AL), and it is a grapheme cluster of its
// own and one UTF-16 unit, as CR is, so indices don't move. Where it is in
// `out_text` goes to `positions`. Unlike CR, U+2063 is transparent to
// shaping and bidi, which add_content and compute_bidi make up for.
bool hide_lone_crs(const char* text,
                   size_t len,
                   const effing_paragraph_placeholder* placeholders,
                   size_t placeholder_count,
                   std::string* out_text,
                   std::vector<effing_paragraph_placeholder>* out_placeholders,
                   std::vector<size_t>* positions) {
  const auto lone = [&](size_t i) {
    return text[i] == '\r' &&
           hard_break_at(text, len, i, placeholders, placeholder_count) == 0;
  };
  size_t i = 0;
  while (i < len && !lone(i)) {
    i++;
  }
  if (i == len) {
    return false;
  }
  out_text->assign(text, i);
  out_placeholders->assign(placeholders, placeholders + placeholder_count);
  // The next placeholder to move: those at a lone CR's offset come before
  // it, and stay.
  size_t next = 0;
  for (; i < len; i++) {
    if (!lone(i)) {
      out_text->push_back(text[i]);
      continue;
    }
    for (; next < placeholder_count && placeholders[next].offset <= i; next++) {
      (*out_placeholders)[next].offset += out_text->size() - i;
    }
    positions->push_back(out_text->size());
    out_text->append("\xE2\x81\xA3");
  }
  for (; next < placeholder_count; next++) {
    (*out_placeholders)[next].offset += out_text->size() - len;
  }
  return true;
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

// SkParagraph's line breaker: whether a run `width` wide is too wide for a
// line `max_width` wide (TextWrapper's LineBreakerWithLittleRounding, without
// the rounding hack).
bool too_wide(float width, float max_width) {
  if (width < max_width - 0.25f) {
    return false;
  }
  if (width > max_width + 0.25f) {
    return true;
  }
  const float val = std::fabs(width);
  const float rounded = val < 10000    ? std::floor(width * 100) / 100
                        : val < 100000 ? std::floor(width * 10) / 10
                                       : std::floor(width);
  return rounded > max_width;
}

// Where `text[start, end)` ends without the hard break it ends in, or `end`
// if it doesn't: as a paragraph's last character, a hard break makes an empty
// line of its own.
size_t without_hard_break(const char* text,
                          size_t len,
                          size_t start,
                          size_t end) {
  for (size_t i = end - std::min<size_t>(end - start, 3); i < end; i++) {
    // Placeholders are U+FFFC in the Skia text, not offsets.
    if (i + hard_break_at(text, len, i, nullptr, 0) == end) {
      return i;
    }
  }
  return end;
}

// Where the text of a line that ends at `at` in `text` (UTF-8) ends, when the
// line breaks at a soft hyphen (U+00AD) and so ends with a hyphen, as CSS
// hyphens: manual has it: right after the soft hyphen, the spaces and tabs
// between it and `at` hanging. 0 when the line doesn't end so, or ends the
// text or at a hard break, where Chrome draws no hyphen.
size_t soft_hyphen_end(const char* text, size_t len, size_t at) {
  size_t end = at;
  while (end > 0 && (text[end - 1] == ' ' || text[end - 1] == '\t')) {
    end--;
  }
  size_t next = at;
  while (next < len && (text[next] == ' ' || text[next] == '\t')) {
    next++;
  }
  const bool soft_hyphen =
      end >= 2 && text[end - 2] == '\xC2' && text[end - 1] == '\xAD';
  return soft_hyphen && next < len &&
                 hard_break_at(text, len, next, nullptr, 0) == 0
             ? end
             : 0;
}

// Adds text[start, end) to `builder` with the placeholders in it: those from
// `*next` on whose offset is at most `end`, each where its offset puts it.
// Advances `*next` past them, and reports each one's index in `placeholders`
// and its UTF-16 index from `start`, where Skia's U+FFFC for it lands, to
// `placed`. The text goes in through effing::add_text, which leaves out the
// letter spacing Chrome doesn't add.
// The U+2063 at each of `lone_crs` (offsets in `text`, sorted) gets
// `cr_style`, which ends the shaping run before it and starts another after
// it, as a CR ends one in Chrome: HarfBuzz sees through U+2063, and would
// kern, ligate and join the letters on either side of it.
template <typename Placed>
void add_content(ParagraphBuilder* builder,
                 const char* text,
                 size_t start,
                 size_t end,
                 const effing_paragraph_placeholder* placeholders,
                 size_t placeholder_count,
                 size_t* next,
                 Placed placed,
                 const std::vector<size_t>& lone_crs = {},
                 const TextStyle* cr_style = nullptr) {
  const auto add_run = [&](size_t from, size_t to) {
    auto cr = std::lower_bound(lone_crs.begin(), lone_crs.end(), from);
    for (; cr != lone_crs.end() && *cr < to && cr_style != nullptr; ++cr) {
      if (*cr > from) {
        effing::add_text(builder, text + from, *cr - from,
                         effing::TextKind::kCss);
      }
      builder->pushStyle(*cr_style);
      effing::add_text(builder, text + *cr, 3, effing::TextKind::kCss);
      builder->pop();
      from = *cr + 3;
    }
    if (to > from) {
      effing::add_text(builder, text + from, to - from, effing::TextKind::kCss);
    }
  };
  size_t at = start;
  size_t index = 0;
  for (; *next < placeholder_count && placeholders[*next].offset <= end;
       ++*next) {
    const auto& spec = placeholders[*next];
    const size_t offset = std::max(spec.offset, at);
    if (offset > at) {
      add_run(at, offset);
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
    add_run(at, end);
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
    const size_t brk =
        hard_break_at(text, len, i, placeholders, placeholder_count);
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
      return baseline - p->content_ascent;
    case EFFING_PLACEHOLDER_TEXT_BOTTOM:
      return baseline + p->content_descent - spec.height;
    default:
      return baseline - spec.baseline_offset;
  }
}

using Piece = effing_paragraph::Piece;
using PieceKind = effing_paragraph::PieceKind;

// Whether lines break around a placeholder as around an emoji, rather than
// on either side of it as around an inline-block.
bool breaks_as_emoji(const effing_paragraph_placeholder& placeholder) {
  return placeholder.line_break == EFFING_PLACEHOLDER_BREAK_EMOJI;
}

// A paragraph built from part of the whole paragraph's Skia text, starting at
// `skia_start` in it, rather than from all of it.
struct PieceOf {
  size_t skia_start;
  // Whether a placeholder too wide for any line follows its text, so that
  // its last line, which ends at a soft break, isn't the paragraph's last
  // and is justified as such.
  bool sentinel;
};

// Builds a paragraph of text[start, end) (UTF-8 offsets in p->text) with the
// placeholders [first, last) in it and `suffix` after it, in p's style, with
// at most `max_lines` lines (0 for no limit, and then no ellipsis). Reports
// each placeholder's index and its UTF-16 index in the paragraph's text to
// `placed`.
// - kUnbounded is for one line at the unbounded width, where floats are too
//   coarse for any alignment but the start.
// - kBreakFirstWord lets a line break between any two grapheme clusters of
//   the text's first word.
// A `piece` of the whole paragraph's text gets the bidi levels its text has
// in the whole: alone, the neutral and weak characters at its edges (a
// placeholder, punctuation, digits) would take the paragraph's direction
// rather than that of the text around them. Its suffix (an ellipsis) and
// sentinel take the paragraph's own level.
// With `hyphen`, p->hyphen follows the text, before the sentinel and the
// suffix, shaped on its own and without letter spacing, as Chrome shapes the
// hyphen it draws where a line breaks at a soft hyphen: it doesn't kern with
// the letter before it. It takes the bidi level of the text before it.
std::unique_ptr<Paragraph> build(const effing_paragraph* p,
                                 size_t start,
                                 size_t end,
                                 size_t first,
                                 size_t last,
                                 int max_lines,
                                 PieceKind kind,
                                 const SkString& suffix,
                                 std::vector<std::pair<size_t, size_t>>* placed,
                                 bool ellipsis = true,
                                 const PieceOf* piece = nullptr,
                                 bool hyphen = false) {
  ParagraphStyle style = p->paragraph_style;
  if (max_lines > 0) {
    style.setMaxLines(max_lines);
  }
  if (max_lines <= 0 || !ellipsis) {
    // With no limit, Skia would truncate the first line with it.
    style.setEllipsis(SkString());
  }
  if (kind == PieceKind::kUnbounded) {
    style.setTextAlign(TextAlign::kLeft);
  }
  const bool break_first_word = kind == PieceKind::kBreakFirstWord;
  const bool sentinel = piece != nullptr && piece->sentinel;
  // Where the placeholders that break lines as emoji are in the paragraph's
  // text, each a U+FFFC of 3 bytes (add_content).
  std::vector<size_t> ideographs;
  // Which of them those are, for the cache tag: SkParagraph's cache keys a
  // paragraph on its placeholders, but not on how lines break around them.
  std::string emoji;
  for (size_t k = first; k < last; k++) {
    const auto& spec = p->placeholder_specs[k];
    emoji += breaks_as_emoji(spec) ? '1' : '0';
    if (breaks_as_emoji(spec)) {
      ideographs.push_back(std::max(spec.offset, start) - start +
                           3 * (k - first));
    }
  }
  if (ideographs.empty()) {
    emoji.clear();
  }
  // With lone CRs, every paragraph takes the levels too, which only the
  // whole text with its CRs gives (compute_bidi).
  std::vector<SkUnicode::BidiRegion> bidi;
  if ((piece != nullptr || !p->lone_crs.empty()) && !p->bidi.empty()) {
    const size_t from =
        piece != nullptr ? piece->skia_start : start + 3 * first;
    const size_t to = from + (end - start) + 3 * (last - first);
    for (const auto& region : p->bidi) {
      const size_t a = std::max<size_t>(region.start, from);
      const size_t b = std::min<size_t>(region.end, to);
      if (a < b) {
        bidi.emplace_back(a - from, b - from, region.level);
      }
    }
    const SkUnicode::BidiLevel base = p->rtl ? 1 : 0;
    size_t at = to - from;
    if (hyphen) {
      at += p->hyphen.size();
      if (!bidi.empty()) {
        bidi.back().end = at;
      } else {
        bidi.emplace_back(0, at, base);
      }
    }
    const size_t extra = (sentinel ? 3 : 0) + suffix.size();
    if (extra > 0 && !bidi.empty() && bidi.back().level == base) {
      bidi.back().end += extra;
    } else if (extra > 0) {
      bidi.emplace_back(at, at + extra, base);
    }
  }
  // Paragraphs whose line breaks or bidi levels differ must not share Skia's
  // cache entry.
  StrutStyle strut = style.getStrutStyle();
  auto families = p->strut_families;
  for (const std::string& tag :
       {effing::word_break_cache_tag(p->word_break, break_first_word),
        effing::bidi_cache_tag(bidi),
        emoji.empty() ? std::string() : "effing-emoji: " + emoji}) {
    if (!tag.empty()) {
      families.emplace_back(tag.c_str());
    }
  }
  if (families.size() > p->strut_families.size()) {
    strut.setFontFamilies(families);
    style.setStrutStyle(strut);
  }
  ParagraphBuilderImpl builder(
      style, p->font_collection,
      effing::make_word_break_unicode(p->word_break, break_first_word,
                                      std::move(ideographs), std::move(bidi)));
  size_t next = first;
  // The lone CRs' U+2063 differ from the text around them in an attribute
  // that SkParagraph's shaper splits runs at but that changes nothing they
  // render with: the language they are shaped in ("zxx", no linguistic
  // content).
  TextStyle cr_style = style.getTextStyle();
  cr_style.setLocale(SkString("zxx"));
  add_content(
      &builder, p->text.data(), start, end, p->placeholder_specs.data(), last,
      &next,
      [&](size_t placeholder, size_t index) {
        placed->emplace_back(placeholder, index);
      },
      p->lone_crs, &cr_style);
  if (hyphen) {
    // A text style of its own, which ends the shaping run before it: one with
    // a line height, which SkParagraph's shaper splits runs at but otherwise
    // ignores without a height override. (A language, as the lone CRs' style
    // has, would shape it in that language too.)
    TextStyle hyphen_style = style.getTextStyle();
    hyphen_style.setLetterSpacing(0);
    hyphen_style.setHeight(0);
    builder.pushStyle(hyphen_style);
    builder.addText(p->hyphen.data(), p->hyphen.size());
    builder.pop();
  }
  if (sentinel) {
    builder.addPlaceholder(PlaceholderStyle(kUnbounded, 1,
                                            PlaceholderAlignment::kBaseline,
                                            TextBaseline::kAlphabetic, 1));
  }
  if (!suffix.isEmpty()) {
    builder.addText(suffix.c_str(), suffix.size());
  }
  return builder.Build();
}

// The offset in p->text of `skia`, an offset in the Skia text of a
// paragraph built from `source`, where each placeholder is a U+FFFC of 3
// bytes, and the index of the first placeholder after it.
std::pair<size_t, size_t> to_text(const effing_paragraph* p,
                                  const effing_paragraph::Source& source,
                                  size_t skia) {
  size_t k = source.first;
  while (k < source.last && p->placeholder_specs[k].offset - source.start +
                                    3 * (k - source.first) <
                                skia) {
    k++;
  }
  return {source.start + skia - 3 * (k - source.first), k};
}

// The same for the Skia text of the whole paragraph.
std::pair<size_t, size_t> to_text(const effing_paragraph* p, size_t skia) {
  return to_text(p, {0, p->text.size(), 0, p->placeholder_specs.size()}, skia);
}

// Builds a piece of the whole paragraph's Skia text [start, end), followed
// by the hyphen if `hyphen` and a sentinel if `sentinel`.
std::unique_ptr<Paragraph> build_piece(
    const effing_paragraph* p,
    size_t start,
    size_t end,
    int max_lines,
    PieceKind kind,
    const SkString& suffix,
    std::vector<std::pair<size_t, size_t>>* placed,
    bool sentinel = false,
    bool hyphen = false) {
  const auto [text_start, first] = to_text(p, start);
  const auto [text_end, last] = to_text(p, end);
  const PieceOf piece{start, sentinel};
  // Only the line given an ellipsis as `suffix` may truncate with Skia's.
  return build(p, text_start, text_end, first, last, max_lines, kind, suffix,
               placed, !suffix.isEmpty(), &piece, hyphen);
}

// Whether SkParagraph gave up on the ellipsis of the last line it laid out.
// Its TextLine::createEllipsis takes clusters off the end of the line until
// the ellipsis fits after the rest, but never tries an empty rest: when the
// first cluster and the ellipsis are wider than the line, it empties the
// line and drops the ellipsis, even when all that follows the line is
// whitespace. The line keeps its runs, which end past its now empty cluster
// range, and doesn't end in a hard break, so justify would spread it.
bool ellipsis_failed(Paragraph* paragraph) {
  auto* impl = static_cast<ParagraphImpl*>(paragraph);
  if (!impl->paragraphStyle().ellipsized() || impl->lines().empty()) {
    return false;
  }
  const TextLine& last = impl->lines().back();
  return last.ellipsis() == nullptr && last.clustersWithSpaces().width() == 0 &&
         !last.endsWithHardLineBreak();
}

// The line-break opportunities in `paragraph`'s Skia text, built as a piece
// of `kind` (kWrapped for the whole paragraph) from the whole paragraph's
// Skia text at `offset` on, by offset: SkUnicode's, which SkParagraph
// overrides around a placeholder with one on either side. That stays around
// a placeholder that breaks lines as a box.
std::vector<bool> opportunities(const effing_paragraph* p,
                                Paragraph* paragraph,
                                PieceKind kind,
                                size_t offset) {
  auto* impl = static_cast<ParagraphImpl*>(paragraph);
  const SkSpan<const char> text = impl->text();
  std::string copy(text.data(), text.size());
  skia_private::TArray<SkUnicode::CodeUnitFlags, true> flags;
  // Its placeholders, in order from the first one after `offset`, as
  // build() gave them; a sentinel after them is none of them.
  size_t k = to_text(p, offset).second;
  std::vector<size_t> ideographs;
  std::vector<size_t> boxes;
  for (const Placeholder& placeholder : impl->placeholders()) {
    if (placeholder.fRange.width() == 0) {
      continue;
    }
    const bool emoji = k < p->placeholder_specs.size() &&
                       breaks_as_emoji(p->placeholder_specs[k]);
    (emoji ? ideographs : boxes).push_back(placeholder.fRange.start);
    k++;
  }
  const auto unicode = effing::make_word_break_unicode(
      p->word_break, kind == PieceKind::kBreakFirstWord, std::move(ideographs));
  std::vector<bool> out(text.size() + 1, false);
  if (!unicode ||
      !unicode->computeCodeUnitFlags(copy.data(), static_cast<int>(copy.size()),
                                     true, &flags)) {
    return out;
  }
  for (size_t i = 0; i < out.size() && i < static_cast<size_t>(flags.size());
       i++) {
    out[i] = flags[i] & (SkUnicode::kSoftLineBreakBefore |
                         SkUnicode::kHardLineBreakBefore);
  }
  for (const size_t at : boxes) {
    out[at] = true;
    out[at + 3] = true;
  }
  return out;
}

// SkParagraph's TextWrapper takes a placeholder for a word of its own: it
// ends a line before or after one wherever the line is full, whatever the
// opportunities around it, so an emoji laid out as a placeholder can end a
// line and the "!" after it start the next. Finds where the first line that
// ends so, beside a placeholder and not at an opportunity, should end
// instead: at the last opportunity in it, as an offset in `paragraph`'s
// Skia text (`at`, 0 if no line ends so, or if such a line has no earlier
// opportunity: its text is then a word too wide for the line, which the
// caller lays out as one), and how many lines the text before that takes.
// `paragraph` was built as a piece of `kind`, from the whole paragraph's
// Skia text at `offset` on. Only its lines from `first_line` on count, and
// only those make up `lines`.
struct Misplaced {
  size_t at = 0;
  int lines = 0;
  // Whether that text is one line too wide for the width, which is laid out
  // on its own at the unbounded width (hyphen_break).
  bool overflows = false;
};
Misplaced misplaced_break(const effing_paragraph* p,
                          Paragraph* paragraph,
                          PieceKind kind,
                          size_t offset,
                          int first_line = 0) {
  auto* impl = static_cast<ParagraphImpl*>(paragraph);
  // Only a placeholder that breaks lines as an emoji, beside no opportunity,
  // makes one (measure_words found them); Skia adds a placeholder of its own
  // after the text.
  if (p->glued.empty() || impl->placeholders().size() <= 1) {
    return {};
  }
  int index = -1;
  const size_t size = impl->text().size();
  std::vector<bool> opportunity;
  for (const TextLine& line : impl->lines()) {
    index++;
    const size_t at = line.textWithNewlines().end;
    const size_t start = line.text().start;
    if (index < first_line || line.endsWithHardLineBreak() ||
        line.ellipsis() != nullptr || at >= size || at <= start) {
      continue;
    }
    const ClusterRange clusters = line.clusters();
    const bool before =
        impl->cluster(impl->clusterIndex(at)).run().isPlaceholder();
    // The line may end in spaces after it.
    const bool after = clusters.width() > 0 &&
                       impl->cluster(clusters.end - 1).run().isPlaceholder();
    if (!before && !after) {
      continue;
    }
    // A piece's text is the whole paragraph's, but for the opportunities a
    // piece that may break its first word adds.
    const bool own =
        kind == PieceKind::kBreakFirstWord || p->opportunities.empty();
    if (own && opportunity.empty()) {
      opportunity = opportunities(p, paragraph, kind, offset);
    }
    const auto at_opportunity = [&](size_t i) {
      return own ? opportunity[i] : p->opportunities[offset + i];
    };
    if (at_opportunity(at)) {
      continue;
    }
    for (size_t c = at - 1; c > start; c--) {
      if (at_opportunity(c)) {
        return {c, index + 1 - first_line};
      }
    }
  }
  return {};
}

// The width of p->hyphen, as build() adds it, measured once.
float hyphen_width(effing_paragraph* p) {
  if (p->hyphen_width < 0) {
    std::vector<std::pair<size_t, size_t>> placed;
    auto hyphen = build(p, 0, 0, 0, 0, 0, PieceKind::kUnbounded, SkString(),
                        &placed, false, nullptr, true);
    hyphen->layout(kUnbounded);
    p->hyphen_width = hyphen->getLongestLine();
  }
  return p->hyphen_width;
}

// Whether a line of `paragraph` breaks at a soft hyphen (soft_hyphen_end).
bool breaks_at_soft_hyphen(Paragraph* paragraph) {
  auto* impl = static_cast<ParagraphImpl*>(paragraph);
  const SkSpan<const char> text = impl->text();
  for (const TextLine& line : impl->lines()) {
    if (line.ellipsis() == nullptr && !line.endsWithHardLineBreak() &&
        soft_hyphen_end(text.data(), text.size(), line.textWithNewlines().end) >
            0) {
      return true;
    }
  }
  return false;
}

// SkParagraph breaks lines without the hyphen that a line breaking at a soft
// hyphen ends with, which Chrome fits in the line too, shaping the line's
// text anew with the hyphen after it. Finds the first line of `paragraph`
// that SkParagraph breaks at a soft hyphen, its last line included where the
// text after it in `whole` makes that a break: `paragraph` is built as a
// piece of `kind` from the whole paragraph's Skia text `whole` at `offset` on
// and laid out at `w`, from its line `first_line` on. Says where the text
// should break instead, as misplaced_break does (`at` is 0 if no line breaks
// so):
// - before that line, if it isn't `first_line`: it is then the first line of
//   the next piece, built from its own text as the line will be;
// - else at the last opportunity in it where its text fits, shaped on its
//   own with the hyphen after it where that is a soft hyphen too;
// - else, when none fits, at its first opportunity, where the line overflows
//   the width, as in Chrome.
Misplaced hyphen_break(effing_paragraph* p,
                       Paragraph* paragraph,
                       PieceKind kind,
                       SkSpan<const char> whole,
                       size_t offset,
                       float w,
                       int first_line) {
  auto* impl = static_cast<ParagraphImpl*>(paragraph);
  // Where a line that ends at `c` in the piece's text ends with a hyphen,
  // there, or 0.
  const auto hyphen_end = [&](size_t c) {
    const size_t end = soft_hyphen_end(whole.data(), whole.size(), offset + c);
    return end > offset ? end - offset : 0;
  };
  int index = -1;
  for (const TextLine& line : impl->lines()) {
    index++;
    const size_t at = line.textWithNewlines().end;
    if (index < first_line || line.ellipsis() != nullptr ||
        hyphen_end(at) == 0) {
      continue;
    }
    const size_t start = line.text().start;
    if (index > first_line) {
      return {start, index - first_line};
    }
    // SkParagraph's own opportunities, which have one on either side of
    // every placeholder, are the text's unless a placeholder breaks lines
    // as an emoji (misplaced_break).
    const bool emoji = !p->opportunities.empty();
    const std::vector<bool> opportunity =
        emoji && kind == PieceKind::kBreakFirstWord
            ? opportunities(p, paragraph, kind, offset)
            : std::vector<bool>();
    const auto at_opportunity = [&](size_t c) {
      if (!opportunity.empty()) {
        return static_cast<bool>(opportunity[c]);
      }
      if (emoji) {
        return static_cast<bool>(p->opportunities[offset + c]);
      }
      return impl->codeUnitHasProperty(c, SkUnicode::kSoftLineBreakBefore);
    };
    // The width of the line up to `c`, without the spaces that hang there:
    // as SkParagraph measured it, or shaped on its own with the hyphen after
    // it where it breaks at a soft hyphen.
    const auto width = [&](size_t c) {
      if (const size_t end = hyphen_end(c)) {
        std::vector<std::pair<size_t, size_t>> placed;
        auto hyphenated = build_piece(p, offset + start, offset + end, 0,
                                      PieceKind::kUnbounded, SkString(),
                                      &placed, false, true);
        hyphenated->layout(kUnbounded);
        return hyphenated->getLongestLine();
      }
      float up_to = 0;
      float content = 0;
      const ClusterRange clusters = line.clustersWithSpaces();
      for (size_t k = clusters.start; k < clusters.end; k++) {
        const Cluster& cluster = impl->cluster(k);
        if (cluster.textRange().end > c) {
          break;
        }
        up_to += cluster.width();
        if (!cluster.isWhitespaceBreak()) {
          content = up_to;
        }
      }
      return content;
    };
    size_t first = at;
    for (size_t c = at; c > start; c--) {
      if (c != at && !at_opportunity(c)) {
        continue;
      }
      if (!too_wide(width(c), w)) {
        return {c, 1};
      }
      first = c;
    }
    return {first, 1, /*overflows=*/true};
  }
  return {};
}

// SkParagraph lays a line out as the paragraph's text was shaped, which
// Chrome shapes anew from where a line starts, where the break is not safe
// for HarfBuzz: a line that starts at a letter kerned against the space it
// wraps at (measure_words) keeps a half of that kerning that Chrome drops.
// Finds the first line of `paragraph`, built from the whole paragraph's Skia
// text at `offset` on, but its first, that starts so: where the text should
// break for that line to start a piece of its own, built from its own text,
// and how many lines the text before it takes, as misplaced_break has it
// (`at` is 0 if no line starts so). Only its lines after `first_line`
// count, and only from that line on do they make up `lines`.
Misplaced kerned_line_start(const effing_paragraph* p,
                            Paragraph* paragraph,
                            size_t offset,
                            int first_line = 0) {
  auto* impl = static_cast<ParagraphImpl*>(paragraph);
  int index = 0;
  for (const TextLine& line : impl->lines()) {
    const size_t start = line.text().start;
    if (index > first_line &&
        std::binary_search(p->kerned.begin(), p->kerned.end(),
                           offset + start)) {
      return {start, index - first_line};
    }
    index++;
  }
  return {};
}

// Whether a paragraph or piece of `kind` is justified by SkParagraph.
bool justified(const effing_paragraph* p, PieceKind kind) {
  return p->paragraph_style.getTextAlign() == TextAlign::kJustify &&
         kind != PieceKind::kUnbounded;
}

// Lays `paragraph` out at `width`, justified if `justify`, and says whether
// SkParagraph gave up on its ellipsis (ellipsis_failed). SkParagraph would
// never return from justifying a line it emptied that way when the line has
// runs past its first: TextLine::justify walks each run's clusters in the
// line, and for those runs that range ends before it starts, so the walk
// wraps around the address space. Line breaking and the ellipsis don't
// depend on the alignment, so the paragraph is first laid out start-aligned,
// and justified only when no line was emptied; the caller lays such a line
// out anew.
//
// Justifying also changes the lines in place: it moves each cluster by a
// shift it keeps in the cluster's run, and widens the line to the width.
// SkParagraph never undoes either for lines it keeps: formatted again at the
// same width, a line already as wide as that is left as it is
// (TextLine::format), its shifts gone, so it paints unjustified; and at a new
// width it breaks the lines before it clears the shifts
// (ParagraphImpl::layout calls breakShapedTextIntoLines before
// resetShifts), so its line breaker measures the spaces it trims off a line
// with the old shifts in, and the lines' widths drift from a fresh
// paragraph's (#12). So a justified paragraph has its lines broken anew,
// with no shifts, every time: laid out as a fresh one is, but not shaped
// again.
bool layout_paragraph(Paragraph* paragraph, float width, bool justify) {
  auto* impl = static_cast<ParagraphImpl*>(paragraph);
  if (justify) {
    if (impl->state() > InternalState::kShaped) {
      impl->setState(InternalState::kShaped);
    }
    impl->resetShifts();
  }
  if (!justify || !impl->paragraphStyle().ellipsized()) {
    if (justify) {
      impl->updateTextAlign(TextAlign::kJustify);
    }
    paragraph->layout(width);
    return ellipsis_failed(paragraph);
  }
  impl->updateTextAlign(TextAlign::kLeft);
  paragraph->layout(width);
  if (ellipsis_failed(paragraph)) {
    return true;
  }
  // Keeps the lines, which start-aligning left as they were, and formats
  // them anew.
  impl->updateTextAlign(TextAlign::kJustify);
  paragraph->layout(width);
  return false;
}

// Where the first grapheme cluster in [start, end) of `paragraph`'s Skia
// text that isn't a space ends, or `start` if there is none: what CSS keeps
// of a line it truncates when not even that fits with the ellipsis. Spaces
// before it stay with it.
size_t first_grapheme_end(Paragraph* paragraph, size_t start, size_t end) {
  auto* impl = static_cast<ParagraphImpl*>(paragraph);
  for (size_t i = start; i < end;) {
    const bool space =
        impl->codeUnitHasProperty(i, SkUnicode::kPartOfWhiteSpaceBreak);
    do {
      i++;
    } while (i < end &&
             !impl->codeUnitHasProperty(i, SkUnicode::kGraphemeStart));
    if (!space) {
      return i;
    }
  }
  return start;
}

// The bidi levels of the whole paragraph's Skia text (U+FFFC for each
// placeholder) into p->bidi, from the text as it was given: before
// SkParagraph replaced its tabs with spaces, which bidi treats otherwise
// (segment separators, which reset to the paragraph's level), and with its
// lone CRs, which Chrome takes for paragraph separators (bidi class B), where
// U+2063 in their place is a boundary neutral. Each CR's U+2063 then takes
// the level of the character before it (or after it, at the start), as
// Chrome reorders it: "اد\rرو" stays one run. Left empty
// when the text has no lone CR and all of it has the paragraph's level.
void compute_bidi(effing_paragraph* p) {
  p->bidi.clear();
  auto icu = SkUnicodes::ICU::Make();
  if (!icu) {
    return;
  }
  // The text as given, and where each of its bytes is in the Skia text.
  std::string original;
  std::vector<size_t> skia_at;
  original.reserve(p->text.size() + 3 * p->placeholder_specs.size());
  size_t skia = 0;
  size_t next = 0;
  auto cr = p->lone_crs.begin();
  for (size_t i = 0; i <= p->text.size(); i++) {
    for (; next < p->placeholder_specs.size() &&
           p->placeholder_specs[next].offset == i;
         next++) {
      original.append("\xEF\xBF\xBC");
      for (int k = 0; k < 3; k++) {
        skia_at.push_back(skia++);
      }
    }
    if (i == p->text.size()) {
      break;
    }
    if (cr != p->lone_crs.end() && *cr == i) {
      original.push_back('\r');
      skia_at.push_back(skia);
      skia += 3;
      i += 2;
      ++cr;
      continue;
    }
    original.push_back(p->text[i]);
    skia_at.push_back(skia++);
  }
  std::vector<SkUnicode::BidiRegion> regions;
  if (!icu->getBidiRegions(original.data(), static_cast<int>(original.size()),
                           p->rtl ? SkUnicode::TextDirection::kRTL
                                  : SkUnicode::TextDirection::kLTR,
                           &regions)) {
    return;
  }
  const SkUnicode::BidiLevel base = p->rtl ? 1 : 0;
  std::vector<SkUnicode::BidiLevel> levels(skia, base);
  for (const auto& region : regions) {
    for (size_t j = region.start; j < region.end && j < skia_at.size(); j++) {
      levels[skia_at[j]] = region.level;
    }
  }
  // The U+2063 of each lone CR, at the Skia offset of its first byte.
  next = 0;
  for (const size_t at : p->lone_crs) {
    while (next < p->placeholder_specs.size() &&
           p->placeholder_specs[next].offset <= at) {
      next++;
    }
    const size_t k = at + 3 * next;
    const SkUnicode::BidiLevel level = k > 0          ? levels[k - 1]
                                       : k + 3 < skia ? levels[k + 3]
                                                      : base;
    std::fill(levels.begin() + k, levels.begin() + k + 3, level);
  }
  for (size_t j = 0; j < skia; j++) {
    if (p->bidi.empty() || p->bidi.back().level != levels[j]) {
      p->bidi.emplace_back(j, j + 1, levels[j]);
    } else {
      p->bidi.back().end = j + 1;
    }
  }
  if (p->lone_crs.empty() && p->bidi.size() == 1 &&
      p->bidi.front().level == base) {
    p->bidi.clear();
  }
}

// Measures the words of wrapping text from SkParagraph's clusters, which are
// what its line breaker measures: their widths, and the widest one, CSS
// min-content. Skia's own minimum is off in places: it is the whole text when
// the text has no spaces and fits on a line, and it leaves out the last
// cluster of a word too wide for the line at the end of the text. Around a
// placeholder, the words are where SkUnicode has them, which SkParagraph's
// line breaker doesn't heed (misplaced_break).
void measure_words(effing_paragraph* p) {
  p->measured = true;
  auto* whole = static_cast<ParagraphImpl*>(p->paragraphs.front().get());
  // For getUTF16Index.
  whole->ensureUTF16Mapping();
  const SkSpan<const char> text = whole->text();
  p->utf8_offsets.clear();
  for (size_t i = 0; i < text.size(); i++) {
    const auto c = static_cast<unsigned char>(text[i]);
    if ((c & 0xC0) != 0x80) {
      p->utf8_offsets.push_back(i);
      if (c >= 0xF0) {
        p->utf8_offsets.push_back(i);  // the low surrogate
      }
    }
  }
  p->utf8_offsets.push_back(text.size());
  p->collapsed.clear();
  if (!p->keep_trailing_whitespace) {
    for (size_t i = 0; i < text.size();) {
      size_t end = i;
      while (end < text.size() && (text[end] == ' ' || text[end] == '\t')) {
        end++;
      }
      // Spaces that end the text are left to hang on a line of their own,
      // as SkParagraph has the empty line after a hard break that ends it.
      if (end > i && end < text.size()) {
        p->collapsed.emplace_back(i, end);
      }
      // The next line's start.
      i = end;
      while (i < text.size()) {
        const size_t brk =
            hard_break_at(text.data(), text.size(), i, nullptr, 0);
        i += brk > 0 ? brk : 1;
        if (brk > 0) {
          break;
        }
      }
    }
  }
  compute_bidi(p);
  // SkParagraph's own flags have an opportunity on either side of every
  // placeholder.
  p->opportunities = std::none_of(p->placeholder_specs.begin(),
                                  p->placeholder_specs.end(), breaks_as_emoji)
                         ? std::vector<bool>()
                         : opportunities(p, whole, PieceKind::kWrapped, 0);
  p->glued.clear();
  if (!p->opportunities.empty()) {
    for (const Placeholder& placeholder : whole->placeholders()) {
      const TextRange range = placeholder.fRange;
      for (const size_t at : {range.start, range.end}) {
        if (range.width() > 0 && at > 0 && at < text.size() &&
            !p->opportunities[at] &&
            (p->glued.empty() || p->glued.back() != at)) {
          p->glued.push_back(at);
        }
      }
    }
  }
  // HarfBuzz splits a pair kerning from the font's legacy `kern` table
  // between the two glyphs: half on the first's advance, half on the
  // second's advance and offset, and it kerns across a soft hyphen. Where a
  // space or a soft hyphen and the letter after it are such a pair, a line
  // that starts at the letter keeps a half that Chrome drops, as it shapes
  // the line's text anew from there. In visual order, that offset is on the
  // letter in LTR and on the space or soft hyphen in RTL. Each such letter
  // with what a word that starts there is wider for it at a line's start,
  // its half of the kerning, sorted. Those after a space start lines that
  // SkParagraph lays out with the kerning (kerned_line_start); those after
  // a soft hyphen start a piece of their own anyway (hyphen_break).
  std::vector<std::pair<size_t, float>> kerned;
  p->kerned.clear();
  const auto space = [&](size_t i) {
    return i < text.size() && (text[i] == ' ' || text[i] == '\t');
  };
  const auto soft_hyphen = [&](size_t i) {
    return !p->hyphen.empty() && i + 1 < text.size() && text[i] == '\xC2' &&
           text[i + 1] == '\xAD';
  };
  for (const Run& run : whole->runs()) {
    if (run.isPlaceholder()) {
      continue;
    }
    const SkSpan<const SkPoint> offsets = run.offsets();
    for (size_t g = 0; g < run.size() && g < offsets.size(); g++) {
      if (offsets[g].fX == 0) {
        continue;
      }
      const size_t at = run.globalClusterIndex(g);
      const size_t start = run.leftToRight() ? at
                           : soft_hyphen(at) ? at + 2
                                             : at + 1;
      if (start >= text.size() || space(start)) {
        continue;
      }
      if (start > 0 && space(start - 1)) {
        kerned.emplace_back(start, -offsets[g].fX);
        if (p->kerned.empty() || p->kerned.back() != start) {
          p->kerned.push_back(start);
        }
      } else if (start >= 2 && soft_hyphen(start - 2)) {
        kerned.emplace_back(start, -offsets[g].fX);
      }
    }
  }
  std::sort(kerned.begin(), kerned.end());
  std::sort(p->kerned.begin(), p->kerned.end());
  p->kerned.erase(std::unique(p->kerned.begin(), p->kerned.end()),
                  p->kerned.end());
  // A word is measured as it is shaped in the paragraph, as Chrome's
  // min-content is, but a word that starts a line is shaped anew, and is too
  // wide for one with its half of the kerning.
  const auto unkerned = [&](size_t start, float width) {
    const auto it = std::lower_bound(kerned.begin(), kerned.end(), start,
                                     [](const std::pair<size_t, float>& k,
                                        size_t at) { return k.first < at; });
    return it != kerned.end() && it->first == start ? width + it->second
                                                    : width;
  };
  const auto breaks = [&](size_t i) {
    if (!p->opportunities.empty()) {
      return static_cast<bool>(p->opportunities[i]);
    }
    return whole->codeUnitHasProperty(i, SkUnicode::kSoftLineBreakBefore) ||
           whole->codeUnitHasProperty(i, SkUnicode::kHardLineBreakBefore);
  };
  p->words.clear();
  p->graphemes.clear();
  p->widest_word = 0;
  // A word that a line can break after at a soft hyphen is that wide with
  // the hyphen, as Chrome's min-content has it.
  const auto add_word = [&](size_t start, size_t end, size_t content_end,
                            float width) {
    if (!p->hyphen.empty() &&
        soft_hyphen_end(text.data(), text.size(), end) > 0) {
      width += hyphen_width(p);
    }
    p->words.push_back({start, end, content_end, unkerned(start, width)});
    p->widest_word = std::max(p->widest_word, width);
  };
  size_t start = 0;
  size_t content_end = 0;
  float width = 0;
  float trimmed = 0;
  for (const Cluster& cluster : whole->clusters()) {
    const TextRange range = cluster.textRange();
    if (range.width() == 0) {
      continue;
    }
    if (p->graphemes.empty() ||
        whole->codeUnitHasProperty(range.start, SkUnicode::kGraphemeStart)) {
      p->graphemes.push_back({range.start, range.end, range.start, 0});
    }
    p->graphemes.back().end = range.end;
    if (!cluster.isWhitespaceBreak()) {
      p->graphemes.back().content_end = range.end;
    }
    p->graphemes.back().width += cluster.width();
    if (range.start > start && breaks(range.start)) {
      add_word(start, range.start, content_end, trimmed);
      start = range.start;
      content_end = start;
      width = 0;
      trimmed = 0;
    }
    width += cluster.width();
    if (!cluster.isWhitespaceBreak()) {
      trimmed = width;
      content_end = range.end;
    }
  }
  if (text.size() > start) {
    add_word(start, text.size(), content_end, trimmed);
  }
}

// Rounds `width` up to the precision of SkParagraph's line breaker (too_wide),
// so that a line it adds up to `width` in another order, give or take a
// rounding error, still fits in that.
float round_up_for_line_breaker(float width) {
  const float val = std::fabs(width);
  return val < 10000    ? std::ceil(width * 100) * (1.f / 100)
         : val < 100000 ? std::ceil(width * 10) * (1.f / 10)
                        : std::ceil(width);
}

// The width at which every hard line of `paragraph`'s text fits on a line
// of its own, from SkParagraph's clusters, which are what its line breaker
// measures: the clusters between two hard breaks, without the whitespace that
// ends them unless it is kept, as CSS max-content has it. That is the widest
// line laid out at the unbounded width, unless a negative letter spacing
// gave an invisible character a negative width: the breaker then needs the
// widest the line gets as it adds up its clusters. Skia's own maximum adds up
// the lines it broke at the last layout's width, trailing whitespace
// included, so it changes with the width. With `collapse_leading`, the
// spaces and tabs that start a line are left out too, as white-space: normal
// collapses them away, and as layout does in wrapping text whose whitespace
// isn't kept (#19).
float widest_hard_line(Paragraph* paragraph,
                       bool keep_trailing_whitespace,
                       bool collapse_leading) {
  auto* impl = static_cast<ParagraphImpl*>(paragraph);
  const SkSpan<const char> text = impl->text();
  float widest = 0;
  // The line so far, and the widest it was at a cluster that isn't
  // whitespace, which is where the line breaker checks it.
  float width = 0;
  float peak = 0;
  const auto end_line = [&] {
    widest = std::max(widest,
                      keep_trailing_whitespace ? std::max(peak, width) : peak);
    width = 0;
    peak = 0;
  };
  // Where the last hard break ends, CRLF being one.
  size_t break_end = 0;
  // Whether only spaces and tabs came on the line so far.
  bool leading = true;
  for (const Cluster& cluster : impl->clusters()) {
    const TextRange range = cluster.textRange();
    if (range.width() == 0 || range.start < break_end) {
      continue;
    }
    // Placeholders are U+FFFC in the Skia text, not offsets.
    const size_t brk =
        hard_break_at(text.data(), text.size(), range.start, nullptr, 0);
    if (brk > 0) {
      end_line();
      break_end = range.start + brk;
      leading = true;
      continue;
    }
    if (leading) {
      leading = std::all_of(text.data() + range.start, text.data() + range.end,
                            [](char c) { return c == ' ' || c == '\t'; });
      if (leading && collapse_leading) {
        continue;
      }
    }
    width += cluster.width();
    if (!cluster.isWhitespaceBreak()) {
      peak = std::max(peak, width);
    }
  }
  end_line();
  return round_up_for_line_breaker(widest);
}

// Measures CSS max-content once, after the first layout has shaped the
// paragraphs: the widest hard line of the whole text, laid out unbounded and
// without max_lines, as CSS doesn't clamp intrinsic sizes. The hard lines
// that nowrap text with an ellipsis dropped for max_lines are shaped here.
void measure_max_content(effing_paragraph* p) {
  p->max_content = 0;
  const bool collapse_leading = !p->keep_trailing_whitespace && !p->nowrap;
  for (size_t k = 0; k < p->paragraphs.size(); k++) {
    Paragraph* paragraph = p->paragraphs[k].get();
    // The line clamped with the ellipsis after it is measured without.
    std::unique_ptr<Paragraph> unclamped;
    if (p->clamped_end != SIZE_MAX && k + 1 == p->paragraphs.size()) {
      const auto& source = p->sources[k];
      std::vector<std::pair<size_t, size_t>> placed;
      unclamped = build(p, source.start, source.end, source.first, source.last,
                        0, PieceKind::kUnbounded, SkString(), &placed);
      unclamped->layout(kUnbounded);
      paragraph = unclamped.get();
    }
    p->max_content = std::max(
        p->max_content, widest_hard_line(paragraph, p->keep_trailing_whitespace,
                                         collapse_leading));
  }
  if (!p->dropped_lines || p->sources.empty()) {
    return;
  }
  const auto& last = p->sources.back();
  const size_t start =
      last.end + hard_break_at(p->text.data(), p->text.size(), last.end,
                               p->placeholder_specs.data(),
                               p->placeholder_specs.size());
  if (start >= p->text.size() && last.last == p->placeholder_specs.size()) {
    return;  // only the empty line after a hard break that ends the text
  }
  // A paragraph per line, as effing_paragraph_create builds those it keeps:
  // shaped together, the lines can come out differently.
  const char* text = p->text.data();
  const size_t len = p->text.size();
  const auto* specs = p->placeholder_specs.data();
  const size_t count = p->placeholder_specs.size();
  size_t first = last.last;
  for (size_t line_start = start, i = start; i <= len;) {
    const size_t brk = i < len ? hard_break_at(text, len, i, specs, count) : 0;
    if (brk == 0 && i < len) {
      i++;
      continue;
    }
    size_t end = first;
    while (end < count && specs[end].offset <= i) {
      end++;
    }
    if (i > line_start || end > first) {
      std::vector<std::pair<size_t, size_t>> placed;
      auto line = build(p, line_start, i, first, end, 0, PieceKind::kUnbounded,
                        SkString(), &placed);
      line->layout(kUnbounded);
      p->max_content = std::max(
          p->max_content,
          widest_hard_line(line.get(), p->keep_trailing_whitespace, false));
    }
    if (brk == 0) {
      break;
    }
    first = end;
    i += brk;
    line_start = i;
  }
}

// Whether HarfBuzz kerned the first glyph of `line` against the text before
// it, which a line laid out from there has no kerning against: the glyph has
// an x offset, as the second glyph of a pair from a legacy `kern` table gets
// one, or in RTL the glyph of the character before it has, which is that
// second glyph in visual order. Such a line is narrower in the text shaped
// as a whole than on its own.
bool starts_kerned(ParagraphImpl* impl, const TextLine& line) {
  const ClusterRange clusters = line.clustersWithSpaces();
  if (clusters.width() == 0) {
    return false;
  }
  const auto offset = [&](size_t k) {
    const Cluster& cluster = impl->cluster(k);
    const Run& run = cluster.run();
    if (run.isPlaceholder()) {
      return false;
    }
    const SkSpan<const SkPoint> offsets = run.offsets();
    const size_t from = std::min(cluster.startPos(), cluster.endPos());
    const size_t to = std::max(cluster.startPos(), cluster.endPos());
    for (size_t g = from; g < to && g < offsets.size(); g++) {
      if (offsets[g].fX != 0) {
        return true;
      }
    }
    return false;
  };
  return offset(clusters.start) ||
         (clusters.start > 0 &&
          !impl->cluster(clusters.start).run().leftToRight() &&
          offset(clusters.start - 1));
}

// Lays the text out at width `w` the way CSS treats a word too wide for its
// line, which SkParagraph would break wherever the line ends, inside grapheme
// clusters too. The text is split into pieces, each a paragraph of its own,
// so that every such word starts a line:
// - overflow-wrap: normal puts the word, with the spaces after it, on a line
//   of its own at the unbounded width, where it overflows: the text before
//   it, the word, and the text after it are pieces.
// - break-word starts a piece at the word, in which a line may break between
//   any two grapheme clusters of the word: SkParagraph then breaks it where
//   the line is full, and fills its last line with the text after it.
// Each piece is built once. A line SkParagraph ends beside a placeholder
// where the text has no opportunity (misplaced_break) ends a piece at the
// last opportunity on it instead. With `force`, the text is split even with
// no word too wide, so that the lines are laid out as CSS has them: when
// SkParagraph emptied the last line of the whole paragraph
// (ellipsis_failed), ended a line so, or truncated the line the lines run
// out at with the ellipsis.
// Leaves p->pieces empty otherwise.
void split_around_long_words(effing_paragraph* p, float w, bool force) {
  // The last layout's pieces, which this one reuses where it can.
  std::vector<Piece> previous = std::move(p->pieces);
  p->pieces.clear();
  p->pieces_exceeded_max_lines = false;
  if (p->nowrap || p->paragraphs.size() != 1 ||
      (!too_wide(p->widest_word, w) && !force)) {
    return;
  }
  auto* whole = static_cast<ParagraphImpl*>(p->paragraphs.front().get());
  const SkSpan<const char> text = whole->text();
  const size_t len = text.size();
  const bool limited = p->max_lines > 0;
  int lines_left = p->max_lines;

  // Ends the last piece at its line `k`, where the lines run out, as that
  // line's own text with the ellipsis after it on one line: what CSS
  // line-clamp shows, the ellipsis after the line's content, or the content
  // truncated to fit it.
  const auto end_with_ellipsis = [&](size_t k) {
    Piece& piece = p->pieces.back();
    std::vector<LineMetrics> lines;
    piece.paragraph->getLineMetrics(lines);
    if (k > lines.size() || (k == lines.size() && k > 0)) {
      return;
    }
    // A piece of no text has no line, but takes an empty one. Skia puts the
    // empty line after a hard break that ends the text at the break itself.
    const bool empty =
        lines.empty() || (piece.empty_last_line && k + 1 == lines.size());
    const size_t line_start =
        empty ? piece.end
              : p->utf8_offsets[piece.offset + lines[k].fStartIndex];
    // Where the line's text ends, which a hyphen after it doesn't.
    const auto text_end = [&](size_t index) {
      return std::min(p->utf8_offsets[piece.offset + index], piece.end);
    };
    // The spaces before the ellipsis stay where whitespace is kept, as in
    // Chrome; the hard break after them doesn't.
    size_t line_end = empty ? piece.end
                      : p->keep_trailing_whitespace
                          ? without_hard_break(text.data(), len, line_start,
                                               text_end(lines[k].fEndIndex))
                          : text_end(lines[k].fEndExcludingWhitespaces);
    // Skia ends a line before a CRLF between its CR and LF.
    if (line_end > line_start && line_end < len && text[line_end] == '\n' &&
        text[line_end - 1] == '\r') {
      line_end--;
    }
    if (k == 0) {
      p->pieces.pop_back();
    } else {
      // Its lines before line k, from all its text, shaped as it was: cut
      // inside a word, the text would join and kern differently.
      piece.placed.clear();
      piece.max_lines = static_cast<int>(k);
      piece.paragraph = build_piece(p, piece.start, piece.end, piece.max_lines,
                                    piece.kind, SkString(), &piece.placed);
      layout_paragraph(piece.paragraph.get(),
                       piece.kind == PieceKind::kUnbounded ? kUnbounded : w,
                       justified(p, piece.kind));
      piece.hard_break = without_hard_break(text.data(), len, piece.start,
                                            line_start) != line_start;
      piece.override_hard_break = true;
      piece.empty_last_line = false;
      piece.line_end = SIZE_MAX;
      piece.hyphen = false;
    }
    // A line that breaks at a soft hyphen keeps its hyphen before the
    // ellipsis, as in Chrome.
    const bool hyphen = !empty && !p->hyphen.empty() &&
                        soft_hyphen_end(text.data(), len, line_end) == line_end;
    Piece last{};
    last.start = line_start;
    last.end = line_end;
    last.kind = PieceKind::kWrapped;
    last.max_lines = 1;
    last.suffixed = true;
    last.offset = whole->getUTF16Index(line_start);
    last.line_end = whole->getUTF16Index(line_end);
    last.hyphen = hyphen;
    last.paragraph = build_piece(p, line_start, line_end, 1, last.kind,
                                 p->paragraph_style.getEllipsis(), &last.placed,
                                 false, hyphen);
    if (layout_paragraph(last.paragraph.get(), w,
                         justified(p, PieceKind::kWrapped))) {
      // Not even the line's first grapheme cluster fits with the ellipsis
      // (or the ellipsis alone doesn't), and SkParagraph emptied the line.
      // CSS keeps it, and the ellipsis after it, both overflowing the line:
      // lay that out unbounded.
      const size_t end = first_grapheme_end(whole, line_start, line_end);
      last.hyphen = false;
      last.kind = PieceKind::kUnbounded;
      last.max_lines = 0;
      last.line_end = whole->getUTF16Index(end);
      last.placed.clear();
      last.paragraph =
          build_piece(p, line_start, end, 0, last.kind,
                      p->paragraph_style.getEllipsis(), &last.placed);
      layout_paragraph(last.paragraph.get(), kUnbounded, false);
    }
    p->pieces.push_back(std::move(last));
  };

  // The end of the word text[start, end) with what follows it on its line:
  // past the spaces after it, which hang there, and the hard break after
  // those. A placeholder's word ends before both, and the next piece would
  // start with them.
  const auto past_spaces = [&](size_t start, size_t end) {
    if (without_hard_break(text.data(), len, start, end) != end) {
      return end;  // the word ends its line already
    }
    auto g = std::lower_bound(p->graphemes.begin(), p->graphemes.end(), end,
                              [](const effing_paragraph::Word& g, size_t at) {
                                return g.start < at;
                              });
    while (g != p->graphemes.end() && g->start == end &&
           g->content_end == g->start &&
           hard_break_at(text.data(), len, end, nullptr, 0) == 0) {
      end = g->end;
      ++g;
    }
    if (end < len && without_hard_break(text.data(), len, start, end) == end) {
      end += hard_break_at(text.data(), len, end, nullptr, 0);
    }
    return end;
  };

  // Adds the piece [start, end); false when no lines are left for more.
  // With `soft_lines`, its text ends at a soft break, after that many lines.
  // With `hyphen`, its text ends at a soft hyphen where its last line breaks,
  // and the hyphen follows it.
  // A paragraph of [start, end) built and laid out to look for a line that
  // ends where it shouldn't, which add_one takes for its piece if it holds
  // the same text with the same limit.
  struct Probe {
    std::unique_ptr<Paragraph> paragraph;
    std::vector<std::pair<size_t, size_t>> placed;
    size_t start = 0;
    size_t end = 0;
    int max_lines = 0;
  };
  const auto add_one = [&](size_t start, size_t end, PieceKind kind,
                           int soft_lines, Probe* probe, bool hyphen) {
    const bool unbounded = kind == PieceKind::kUnbounded;
    Piece piece{};
    piece.start = start;
    piece.end = end < len && soft_lines == 0
                    ? without_hard_break(text.data(), len, start, end)
                    : end;
    piece.kind = kind;
    piece.offset = whole->getUTF16Index(start);
    piece.hard_break = piece.end != end;
    // A piece needn't hold more text than the lines left can show and one
    // more: their words, without the spaces between them, are at most a
    // line's width each. Nor need Skia shape and break it, then.
    bool cut = false;
    if (limited && !unbounded) {
      const float room = (lines_left + 1) * (w + 0.25f);
      auto word =
          std::upper_bound(p->words.begin(), p->words.end(), start,
                           [](size_t at, const effing_paragraph::Word& word) {
                             return at < word.end;
                           });
      float filled = 0;
      for (; word != p->words.end() && word->start < piece.end; ++word) {
        // A word the piece starts inside of (after a grapheme cluster too
        // wide for the line, or a placeholder) may be mostly before it.
        if (word->start < start) {
          continue;
        }
        filled += word->width;
        if (filled > room) {
          if (word->end < piece.end) {
            piece.end = word->end;
            piece.hard_break = false;
            cut = true;
          }
          break;
        }
      }
    }
    // A hard break its text still ends in, before the one left out, makes an
    // empty last line, whose text is at the piece's end.
    piece.empty_last_line =
        end < len && !cut && soft_lines == 0 &&
        without_hard_break(text.data(), len, start, piece.end) != piece.end;
    // The last line's text ends before the hyphen.
    piece.hyphen = hyphen && !cut;
    piece.line_end = piece.empty_last_line || piece.hyphen
                         ? whole->getUTF16Index(piece.end)
                         : SIZE_MAX;
    // The size of its text in SkParagraph's, with the hyphen.
    const size_t size =
        piece.end - piece.start + (piece.hyphen ? p->hyphen.size() : 0);
    // Without an ellipsis, Skia drops the lines past those left, and knows
    // whether text remains; with one, the line the lines run out at is
    // rebuilt, so one more line tells.
    piece.max_lines =
        !limited || unbounded ? 0 : lines_left + (p->ellipsized ? 1 : 0);
    // Text that ends at a soft break gets a sentinel after it that its last
    // line can't take, so that SkParagraph justifies that line as it does a
    // line that isn't the last, and as many lines, which leave the sentinel
    // out. Unless fewer lines are left than that, which end in the piece.
    const int max_lines = piece.max_lines;
    bool sentinel = soft_lines > 0 && !cut &&
                    (piece.max_lines == 0 || piece.max_lines >= soft_lines);
    if (sentinel) {
      piece.max_lines = soft_lines;
      piece.soft_lines = soft_lines;
    }
    // The last layout's piece of the same text, already shaped. Pieces are
    // in text order, so those that start where this one does are found by
    // bisection rather than a walk over all of them.
    for (auto old = std::lower_bound(
             previous.begin(), previous.end(), piece.start,
             [](const Piece& old, size_t start) { return old.start < start; });
         old != previous.end() && old->start == piece.start; ++old) {
      if (old->paragraph && old->end == piece.end && old->kind == kind &&
          old->max_lines == piece.max_lines &&
          old->soft_lines == piece.soft_lines && old->suffixed == false &&
          old->hyphen == piece.hyphen) {
        piece.paragraph = std::move(old->paragraph);
        piece.placed = std::move(old->placed);
        break;
      }
    }
    if (!piece.paragraph && probe != nullptr && probe->paragraph && !sentinel &&
        !piece.hyphen && probe->start == start && probe->end == piece.end &&
        probe->max_lines == piece.max_lines) {
      piece.paragraph = std::move(probe->paragraph);
      piece.placed = std::move(probe->placed);
    }
    if (!piece.paragraph) {
      piece.paragraph =
          build_piece(p, start, piece.end, piece.max_lines, kind, SkString(),
                      &piece.placed, sentinel, piece.hyphen);
    }
    layout_paragraph(piece.paragraph.get(), unbounded ? kUnbounded : w,
                     justified(p, kind));
    if (sentinel) {
      // Its text alone may not lay out in those lines after all, shaped
      // differently at the end: then it does without the sentinel, its last
      // line left unjustified.
      const auto lines =
          static_cast<ParagraphImpl*>(piece.paragraph.get())->lines();
      if (static_cast<int>(lines.size()) != soft_lines ||
          lines.back().textWithNewlines().end != size) {
        sentinel = false;
        piece.soft_lines = 0;
        piece.max_lines = max_lines;
        piece.placed.clear();
        piece.paragraph =
            build_piece(p, start, piece.end, piece.max_lines, kind, SkString(),
                        &piece.placed, false, piece.hyphen);
        layout_paragraph(piece.paragraph.get(), w, justified(p, kind));
      }
    } else if (justified(p, kind) && !cut && end < len && piece.end == end &&
               !piece.paragraph->didExceedMaxLines()) {
      // Its text ends at a soft break, before a word too wide for the line,
      // say: its last line is justified too, with a sentinel after it.
      const int lines = static_cast<int>(piece.paragraph->lineNumber());
      std::vector<std::pair<size_t, size_t>> placed;
      auto justified_piece =
          build_piece(p, start, piece.end, lines, kind, SkString(), &placed,
                      true, piece.hyphen);
      layout_paragraph(justified_piece.get(), w, true);
      const auto laid =
          static_cast<ParagraphImpl*>(justified_piece.get())->lines();
      if (lines > 0 && static_cast<int>(laid.size()) == lines &&
          laid.back().textWithNewlines().end == size) {
        sentinel = true;
        piece.paragraph = std::move(justified_piece);
        piece.placed = std::move(placed);
        piece.max_lines = lines;
        piece.soft_lines = lines;
      }
    }
    const int n = std::max(static_cast<int>(piece.paragraph->lineNumber()), 1);
    // The sentinel is always left out.
    const bool exceeded = piece.paragraph->didExceedMaxLines() && !sentinel;
    const bool truncated = cut || exceeded;
    // Skia gives the empty line after a hard break that ends a text the
    // break's own index, and its end after it; under a limit it may leave
    // that line out.
    const auto ends_in_empty_line = [&](size_t text_end) {
      const size_t brk = without_hard_break(text.data(), len, start, text_end);
      if (brk == text_end) {
        return false;
      }
      std::vector<LineMetrics> lines;
      piece.paragraph->getLineMetrics(lines);
      const size_t at = whole->getUTF16Index(brk) - piece.offset;
      return !lines.empty() && lines.back().fStartIndex >= at &&
             lines.back().fEndExcludingWhitespaces > lines.back().fStartIndex;
    };
    if (truncated ||
        (piece.empty_last_line && !ends_in_empty_line(piece.end))) {
      // Its last line is not the empty one after its text.
      piece.empty_last_line = false;
      piece.line_end = SIZE_MAX;
    }
    // Skia knows whether the last line of the text, or of text it truncated,
    // ends at a hard break; the end of a piece, or of the text cut short for
    // the lines left, is none.
    piece.override_hard_break = (end < len || cut) && !exceeded;
    // Skia's empty line after a hard break that ends the text is not one of
    // the lines maxLines counts: it shows if there is room, and Skia leaves
    // it out at the limit.
    const bool phantom =
        end == len && !truncated && n > 1 && ends_in_empty_line(end);
    const int counted = n - (phantom ? 1 : 0);
    p->pieces.push_back(std::move(piece));
    if (!limited) {
      return true;
    }
    if (!truncated && counted <= lines_left &&
        (end == len || counted < lines_left)) {
      if (phantom && n > lines_left) {
        // No room for the empty line: Skia leaves it out with the limit.
        Piece& last = p->pieces.back();
        last.placed.clear();
        last.max_lines = lines_left;
        last.paragraph =
            build_piece(p, start, last.end, lines_left, kind, SkString(),
                        &last.placed, false, last.hyphen);
        layout_paragraph(last.paragraph.get(), unbounded ? kUnbounded : w,
                         justified(p, kind));
      }
      lines_left -= counted;
      return true;
    }
    // The lines run out in this piece, at its line `lines_left - 1`, with
    // text after it.
    p->pieces_exceeded_max_lines = true;
    if (p->ellipsized) {
      end_with_ellipsis(static_cast<size_t>(std::min(lines_left, counted) - 1));
    } else if (counted > lines_left) {
      // A piece built without the limit (a word at the unbounded width)
      // shows no more lines than are left.
      Piece& last = p->pieces.back();
      last.placed.clear();
      last.max_lines = lines_left;
      last.paragraph =
          build_piece(p, start, last.end, lines_left, kind, SkString(),
                      &last.placed, false, last.hyphen);
      layout_paragraph(last.paragraph.get(), unbounded ? kUnbounded : w,
                       justified(p, kind));
      last.override_hard_break = false;
      last.empty_last_line = false;
      last.line_end = SIZE_MAX;
    }
    return false;
  };

  // Where a window of text from `start` on, of a few lines' worth of its
  // words, ends: at a word's end, or `stop`.
  const auto window_end = [&](size_t start, size_t stop) {
    constexpr int kWindowLines = 8;
    const float room = kWindowLines * (w + 0.25f);
    auto word =
        std::upper_bound(p->words.begin(), p->words.end(), start,
                         [](size_t at, const effing_paragraph::Word& word) {
                           return at < word.end;
                         });
    float filled = 0;
    int count = 0;
    for (; word != p->words.end() && word->start < stop; ++word) {
      if (word->start < start) {
        continue;
      }
      filled += word->width;
      if (filled > room && ++count > kWindowLines) {
        return std::min(word->end, stop);
      }
    }
    return stop;
  };

  // Adds the pieces of [start, end). Spaces that start a line, which CSS
  // collapses away, are left out of every piece, and a piece ends at the
  // hard break before them. With placeholders, where SkParagraph may end a
  // line where it shouldn't (misplaced_break), with soft hyphens, where it
  // breaks lines without the hyphen (hyphen_break), and with letters kerned
  // against the space before them, where a line may start with that kerning
  // (kerned_line_start), the text is laid out a window at a time first: a
  // piece ends where such a line should, or before such a line, or else
  // before the window's last line, which the text after the window may
  // change, and the next starts there. The windows keep the work in
  // proportion to the text, and so does going on with a window's lines after
  // a piece that ends where one of them does. A piece that ends where a line
  // breaks at a soft hyphen ends with the hyphen, without the spaces after
  // it, which hang.
  const auto add = [&](size_t start, size_t end, PieceKind kind) {
    auto run = std::lower_bound(p->collapsed.begin(), p->collapsed.end(), start,
                                [](const std::pair<size_t, size_t>& run,
                                   size_t at) { return run.second <= at; });
    Probe probe;
    // The first soft hyphen from `start` on, looked for again only once
    // `start` passes it, so that finding them all takes one pass.
    size_t soft_hyphen =
        p->hyphen.empty()
            ? std::string_view::npos
            : std::string_view(text.data(), len).find("\xC2\xAD", start);
    while (start < end) {
      for (; run != p->collapsed.end() && run->first <= start; ++run) {
        start = std::max(start, std::min(run->second, end));
      }
      if (start >= end) {
        break;
      }
      const size_t stop =
          run != p->collapsed.end() ? std::min(run->first, end) : end;
      size_t to = stop;
      int soft_lines = 0;
      PieceKind piece_kind = kind;
      // Only text with a placeholder beside no opportunity can have a line
      // end where it shouldn't, only text with a soft hyphen can have a line
      // break at one, and only text with a kerned letter after a space can
      // have a line start with that kerning.
      const auto glued =
          std::lower_bound(p->glued.begin(), p->glued.end(), start + 1);
      const bool misplaceable = glued != p->glued.end() && *glued < stop;
      if (!p->hyphen.empty() && soft_hyphen != std::string_view::npos &&
          soft_hyphen < start) {
        soft_hyphen =
            std::string_view(text.data(), len).find("\xC2\xAD", start);
      }
      const bool hyphenable = soft_hyphen < stop;
      const auto kerned =
          std::lower_bound(p->kerned.begin(), p->kerned.end(), start + 1);
      const bool kernable = kerned != p->kerned.end() && *kerned < stop;
      if ((misplaceable || hyphenable || kernable) &&
          kind != PieceKind::kUnbounded) {
        // The last probe's line that starts at `start`, unless that is the
        // last line of a window, which the text after the window may change,
        // or the probe kerned its first glyph against the text before it,
        // which makes it and the lines after it narrower than they are on
        // their own.
        int first_line = -1;
        if (probe.paragraph && probe.start < start && start < probe.end &&
            probe.end <= stop) {
          auto* probed = static_cast<ParagraphImpl*>(probe.paragraph.get());
          const auto& lines = probed->lines();
          for (size_t i = 1; i < lines.size(); i++) {
            if (probe.start + lines[i].text().start == start) {
              if ((i + 1 < lines.size() || probe.end == stop) &&
                  !starts_kerned(probed, lines[i])) {
                first_line = static_cast<int>(i);
              }
              break;
            }
          }
        }
        if (first_line < 0) {
          first_line = 0;
          probe.start = start;
          probe.end = window_end(start, stop);
          probe.max_lines = limited ? lines_left + (p->ellipsized ? 1 : 0) : 0;
          probe.placed.clear();
          probe.paragraph = build_piece(p, start, probe.end, probe.max_lines,
                                        kind, SkString(), &probe.placed);
          layout_paragraph(probe.paragraph.get(), w, false);
        }
        const size_t window = probe.end;
        Misplaced misplaced =
            misplaceable ? misplaced_break(p, probe.paragraph.get(), kind,
                                           probe.start, first_line)
                         : Misplaced{};
        const Misplaced hyphenated =
            hyphenable ? hyphen_break(p, probe.paragraph.get(), kind, text,
                                      probe.start, w, first_line)
                       : Misplaced{};
        const Misplaced kerned_start =
            kernable ? kerned_line_start(p, probe.paragraph.get(), probe.start,
                                         first_line)
                     : Misplaced{};
        // The earliest of them.
        for (const Misplaced& other : {hyphenated, kerned_start}) {
          if (other.at > 0 &&
              (misplaced.at == 0 || other.lines < misplaced.lines ||
               (other.lines == misplaced.lines && other.at < misplaced.at))) {
            misplaced = other;
          }
        }
        const auto probed =
            static_cast<ParagraphImpl*>(probe.paragraph.get())->lines();
        const int left = static_cast<int>(probed.size()) - first_line;
        if (misplaced.overflows) {
          to = probe.start + misplaced.at;
          piece_kind = PieceKind::kUnbounded;
        } else if (misplaced.at > 0) {
          to = probe.start + misplaced.at;
          soft_lines = misplaced.lines;
        } else if (window < stop && left >= 2 &&
                   !probe.paragraph->didExceedMaxLines()) {
          // The empty line after a hard break that ends the window starts at
          // the break itself (its text is the break): the piece then takes
          // the window, break and all, and ends at that hard break.
          const size_t last = probe.start + probed.back().text().start;
          to = hard_break_at(text.data(), len, last, nullptr, 0) > 0 ? window
                                                                     : last;
          soft_lines = left - 1;
        }
        // A line before a hard break ends the piece as any hard break does.
        if (to < stop &&
            without_hard_break(text.data(), len, start, to) != to) {
          soft_lines = 0;
        }
      }
      const size_t hyphen_end =
          p->hyphen.empty() ? 0 : soft_hyphen_end(text.data(), len, to);
      const bool hyphen = hyphen_end > start;
      const bool more = add_one(start, hyphen ? hyphen_end : to, piece_kind,
                                soft_lines, &probe, hyphen);
      Piece& added = p->pieces.back();
      if (hyphen && to > hyphen_end && added.start == start && added.hyphen &&
          added.line_end != SIZE_MAX) {
        added.hanging_end = whole->getUTF16Index(to);
      }
      if (!more) {
        return false;
      }
      start = to;
    }
    return true;
  };

  size_t start = 0;
  if (p->overflow_wrap == effing::OverflowWrap::kBreakWord) {
    PieceKind kind = PieceKind::kWrapped;
    auto grapheme = p->graphemes.begin();
    for (const auto& word : p->words) {
      if (!too_wide(word.width, w)) {
        continue;
      }
      if (word.start > start && !add(start, word.start, kind)) {
        return;
      }
      start = word.start;
      kind = PieceKind::kBreakFirstWord;
      // A grapheme cluster too wide for a line still overflows it, whole, as
      // in CSS, rather than leave Skia to break it.
      while (grapheme != p->graphemes.end() && grapheme->start < word.start) {
        ++grapheme;
      }
      for (;
           grapheme != p->graphemes.end() && grapheme->start < word.content_end;
           ++grapheme) {
        if (!too_wide(grapheme->width, w)) {
          continue;
        }
        if (grapheme->start > start && !add(start, grapheme->start, kind)) {
          return;
        }
        // The spaces after the word's last grapheme hang after it.
        const bool last = grapheme->end >= word.content_end;
        const size_t end =
            last ? past_spaces(word.start, word.end) : grapheme->end;
        if (!add(grapheme->start, end, PieceKind::kUnbounded)) {
          return;
        }
        start = end;
        kind = last ? PieceKind::kWrapped : PieceKind::kBreakFirstWord;
      }
    }
    if (start < len) {
      add(start, len, kind);
    }
    return;
  }
  for (const auto& word : p->words) {
    if (!too_wide(word.width, w)) {
      continue;
    }
    if (word.start > start && !add(start, word.start, PieceKind::kWrapped)) {
      return;
    }
    start = past_spaces(word.start, word.end);
    if (!add(word.start, start, PieceKind::kUnbounded)) {
      return;
    }
  }
  if (start < len) {
    add(start, len, PieceKind::kWrapped);
  }
}

// Lays the lines of nowrap text with an ellipsis out as pieces, one per
// line, when SkParagraph emptied some (`emptied`, by index; ellipsis_failed):
// each of those is its first grapheme cluster with the ellipsis after it,
// overflowing, as CSS text-overflow has it.
void truncate_nowrap_lines(effing_paragraph* p,
                           float w,
                           const std::vector<bool>& emptied) {
  for (size_t k = 0; k < p->paragraphs.size(); k++) {
    const auto& source = p->sources[k];
    // The last line kept has the ellipsis after its text when lines were
    // dropped after it.
    const bool clamped =
        p->clamped_end != SIZE_MAX && k + 1 == p->paragraphs.size();
    Piece piece{};
    piece.kind = PieceKind::kWrapped;
    piece.offset = p->offsets[k];
    piece.hard_break = k + 1 < p->paragraphs.size() || clamped;
    piece.override_hard_break = piece.hard_break;
    piece.line_end = clamped ? p->clamped_end : SIZE_MAX;
    if (!emptied[k]) {
      // As effing_paragraph_create built it.
      piece.paragraph = build(
          p, source.start, source.end, source.first, source.last, 1, piece.kind,
          clamped ? p->paragraph_style.getEllipsis() : SkString(),
          &piece.placed);
      layout_paragraph(piece.paragraph.get(), w, false);
    } else {
      Paragraph* line = p->paragraphs[k].get();
      // Its text, without the ellipsis after it.
      const size_t size =
          static_cast<ParagraphImpl*>(line)->text().size() -
          (clamped ? p->paragraph_style.getEllipsis().size() : 0);
      const auto [end, last] =
          to_text(p, source, first_grapheme_end(line, 0, size));
      piece.kind = PieceKind::kUnbounded;
      piece.line_end =
          piece.offset +
          utf16_length(p->text.data() + source.start, end - source.start) +
          (last - source.first);
      piece.paragraph =
          build(p, source.start, end, source.first, last, 0, piece.kind,
                p->paragraph_style.getEllipsis(), &piece.placed);
      layout_paragraph(piece.paragraph.get(), kUnbounded, false);
    }
    p->pieces.push_back(std::move(piece));
  }
}

// A paragraph the last layout laid out, and where its text starts in the
// whole text, in UTF-16 units.
struct LaidOut {
  Paragraph* paragraph;
  size_t offset;
};

// The paragraphs the last layout laid out, in text order: the pieces it
// split the text into, if any.
std::vector<LaidOut> laid_out(const effing_paragraph* p) {
  std::vector<LaidOut> out;
  if (p->pieces.empty()) {
    for (size_t k = 0; k < p->paragraphs.size(); k++) {
      out.push_back({p->paragraphs[k].get(), p->offsets[k]});
    }
  } else {
    for (const auto& piece : p->pieces) {
      out.push_back({piece.paragraph.get(), piece.offset});
    }
  }
  return out;
}

// Where each placeholder is in the paragraphs the last layout laid out: the
// paragraph's index (SIZE_MAX if its line was dropped) and its UTF-16 index
// in that paragraph's text.
std::vector<std::pair<size_t, size_t>> placements(const effing_paragraph* p) {
  std::vector<std::pair<size_t, size_t>> out;
  for (const auto& placeholder : p->placeholders) {
    out.emplace_back(p->pieces.empty() ? placeholder.paragraph : SIZE_MAX,
                     placeholder.index);
  }
  for (size_t k = 0; k < p->pieces.size(); k++) {
    for (const auto& [placeholder, index] : p->pieces[k].placed) {
      out[placeholder] = {k, index};
    }
  }
  return out;
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
  std::string shown_text;
  std::vector<effing_paragraph_placeholder> shown_placeholders;
  std::vector<size_t> lone_crs;
  if (hide_lone_crs(text, text_len, placeholders, placeholder_count,
                    &shown_text, &shown_placeholders, &lone_crs)) {
    text = shown_text.data();
    text_len = shown_text.size();
    placeholders = shown_placeholders.data();
  }
  auto font_collection = c_collection->collection;
  const auto families = split_families(font_family);
  const auto font_style =
      SkFontStyle(s->weight, SkFontStyle::kNormal_Width,
                  static_cast<SkFontStyle::Slant>(s->slant));
  const auto direction = static_cast<TextDirection>(s->direction);
  // The text is laid out at the size Chrome lays it out at, floored to
  // 1/100px, and so are the metrics the line boxes come from (#46).
  const float font_size = effing::effective_font_size(s->font_size);
  // Skia lays the glyphs out at that size to the nearest 1/64px, which its
  // FreeType takes sizes in, as CoreText's advances at the size come closest
  // to (effing::freetype_font_size).
  const float skia_font_size = effing::freetype_font_size(font_size);

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
  if (!hhea_metrics(primary, font_size, &out->ascent, &out->descent,
                    &out->line_gap)) {
    SkFont font(primary, font_size);
    SkFontMetrics m;
    font.getMetrics(&m);
    out->ascent = -m.fAscent;
    out->descent = m.fDescent;
    out->line_gap = std::max(m.fLeading, 0.f);
  }
  out->content_ascent = round_metric(out->ascent);
  out->content_descent = round_metric(out->descent);
  // `normal` is Chrome's line spacing (SimpleFontData::PlatformInit): the
  // ascent, descent and line gap each rounded to whole pixels.
  out->line_height = s->line_height >= 0
                         ? to_layout_units(s->line_height)
                         : out->content_ascent + out->content_descent +
                               round_metric(out->line_gap);
  out->x_height = placeholder_count > 0 ? x_height(primary, font_size) : 0;

  TextStyle text_style;
  text_style.setFontFamilies(families);
  text_style.setFontSize(skia_font_size);
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
  strut.setFontSize(skia_font_size);
  strut.setHeight(out->line_height / skia_font_size);
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
  out->length = utf16_length(text, text_len) + placeholder_count;
  // A placeholder at the end of the text comes after a break there.
  if (placeholder_count == 0 ||
      placeholders[placeholder_count - 1].offset < text_len) {
    for (size_t i = text_len - std::min<size_t>(text_len, 3); i < text_len;
         i++) {
      const size_t brk =
          hard_break_at(text, text_len, i, placeholders, placeholder_count);
      if (brk > 0 && i + brk == text_len) {
        out->ends_in_hard_break = true;
        break;
      }
    }
  }
  out->placeholders.reserve(placeholder_count);
  for (size_t i = 0; i < placeholder_count; i++) {
    out->placeholders.push_back({placeholders[i]});
  }
  out->word_break = static_cast<effing::WordBreak>(s->word_break);
  out->overflow_wrap = static_cast<effing::OverflowWrap>(s->overflow_wrap);
  out->max_lines = s->max_lines;
  out->text.assign(text, text_len);
  out->placeholder_specs.assign(placeholders, placeholders + placeholder_count);
  out->lone_crs = std::move(lone_crs);
  if (!out->lone_crs.empty()) {
    compute_bidi(out);
  }
  // Only wrapping text breaks lines at a soft hyphen.
  if (!out->nowrap && out->text.find("\xC2\xAD") != std::string::npos) {
    out->hyphen =
        primary && primary->unicharToGlyph(0x2010) != 0 ? "\xE2\x80\x90" : "-";
  }
  out->paragraph_style = paragraph_style;
  out->strut_families = families;
  out->font_collection = font_collection;
  // The next placeholder to place; each takes one UTF-16 unit (U+FFFC).
  size_t next = 0;
  // Builds a paragraph of text[start, end), with the placeholders up to `end`
  // in it.
  // The placeholders up to `end` from the next one on end before this.
  const auto placeholders_to = [&](size_t end) {
    size_t last = next;
    while (last < placeholder_count && placeholders[last].offset <= end) {
      last++;
    }
    return last;
  };
  // With `suffix` after the text.
  const auto add = [&](size_t start, size_t end, int max_lines,
                       const SkString& suffix = SkString()) {
    const size_t last = placeholders_to(end);
    out->offsets.push_back(utf16_length(text, start) + next);
    out->sources.push_back({start, end, next, last});
    const size_t k = out->paragraphs.size();
    std::vector<std::pair<size_t, size_t>> placed;
    out->paragraphs.push_back(build(out, start, end, next, last, max_lines,
                                    PieceKind::kWrapped, suffix, &placed));
    for (const auto& [placeholder, index] : placed) {
      out->placeholders[placeholder].paragraph = k;
      out->placeholders[placeholder].index = index;
    }
    next = last;
  };
  if (!(out->nowrap && out->ellipsized)) {
    add(0, text_len, s->max_lines);
    return out;
  }
  // One line per hard break, each truncated to the width.
  const size_t max_lines =
      s->max_lines > 0 ? static_cast<size_t>(s->max_lines) : SIZE_MAX;
  size_t start = 0;
  for (size_t i = 0; i <= text_len;) {
    const size_t brk =
        i < text_len
            ? hard_break_at(text, text_len, i, placeholders, placeholder_count)
            : 0;
    if (brk == 0 && i < text_len) {
      i++;
      continue;
    }
    if (out->paragraphs.size() == max_lines) {
      // The empty line after a hard break that ends the text is not one of
      // the lines max_lines counts, as when Skia lays out the whole text.
      out->dropped_lines = start < text_len || next < placeholder_count;
      break;
    }
    // The last line kept, with lines after it that aren't kept, ends with
    // the ellipsis, as CSS line-clamp has it under white-space: pre (#20),
    // and is truncated to fit it.
    if (brk > 0 && out->paragraphs.size() + 1 == max_lines &&
        (i + brk < text_len || placeholders_to(i) < placeholder_count)) {
      // Without the spaces and tabs that end it, unless whitespace is kept:
      // they hang at the end of a line, before the ellipsis too.
      size_t end = i;
      while (!out->keep_trailing_whitespace && end > start &&
             (text[end - 1] == ' ' || text[end - 1] == '\t') &&
             !placeholder_at(placeholders, placeholder_count, end)) {
        end--;
      }
      out->clamped_end = utf16_length(text, end) + placeholders_to(end);
      add(start, end, 1, paragraph_style.getEllipsis());
    } else {
      add(start, i, 1);
    }
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
  // The text and style don't change, so neither does a layout at the same
  // width.
  if (w == p->laid_out_width) {
    return;
  }
  p->laid_out_width = w;

  // Once the words are measured, the whole paragraph needn't be laid out at
  // a width where pieces replace it.
  const bool pieces = p->measured && !p->nowrap && w < kUnbounded &&
                      p->paragraphs.size() == 1 && too_wide(p->widest_word, w);
  // The paragraphs whose last line SkParagraph emptied (ellipsis_failed).
  std::vector<bool> emptied(p->paragraphs.size(), false);
  bool any_emptied = false;
  if (!pieces) {
    for (size_t k = 0; k < p->paragraphs.size(); k++) {
      emptied[k] =
          layout_paragraph(p->paragraphs[k].get(), unbounded ? kUnbounded : w,
                           justified(p, PieceKind::kWrapped));
      any_emptied |= emptied[k];
    }
  }
  if (!p->nowrap && !p->measured) {
    measure_words(p);
  }
  if (p->max_content < 0) {
    measure_max_content(p);
  }
  // A line SkParagraph ended beside a placeholder, where it shouldn't, is
  // laid out in pieces too, and so is wrapping text the ellipsis truncates,
  // whose last line CSS line-clamp makes of that line's own text with the
  // ellipsis after it: SkParagraph fills it with the text after it instead,
  // to cut that at any grapheme cluster, and leaves a line that ends at a
  // hard break without the ellipsis.
  const bool whole = !pieces && !p->nowrap && p->paragraphs.size() == 1;
  const bool misplaced =
      whole && w < kUnbounded &&
      misplaced_break(p, p->paragraphs.front().get(), PieceKind::kWrapped, 0)
              .at > 0;
  const bool clamped =
      whole && p->ellipsized && p->paragraphs.front()->didExceedMaxLines();
  // So is text with spaces that start a line, which CSS collapses away.
  const bool collapsed = whole && !p->collapsed.empty();
  // And text with a line that breaks at a soft hyphen, which ends with a
  // hyphen that SkParagraph neither draws nor makes room for, or that starts
  // at a letter kerned against the space before it, which Chrome shapes
  // without that kerning.
  const bool hyphenated = whole && w < kUnbounded && !p->hyphen.empty() &&
                          breaks_at_soft_hyphen(p->paragraphs.front().get());
  const bool kerned =
      whole && w < kUnbounded && !p->kerned.empty() &&
      kerned_line_start(p, p->paragraphs.front().get(), 0).at > 0;
  split_around_long_words(
      p, w,
      any_emptied || misplaced || clamped || collapsed || hyphenated || kerned);
  if (p->nowrap && any_emptied) {
    truncate_nowrap_lines(p, w, emptied);
  }
  const auto paragraphs = laid_out(p);

  p->lines.clear();
  p->line_widths.clear();
  p->kept_whitespace.clear();
  p->first_lines.clear();
  for (size_t k = 0; k < paragraphs.size(); k++) {
    Paragraph* paragraph = paragraphs[k].paragraph;
    const size_t offset = paragraphs[k].offset;
    const size_t first = p->lines.size();
    p->first_lines.push_back(first);
    std::vector<LineMetrics> lines;
    paragraph->getLineMetrics(lines);
    if (lines.empty() && p->length > 0) {
      // An empty hard-broken line still takes a line box, as it does when
      // Skia lays out the whole text, also when it is the only line nowrap
      // text with an ellipsis keeps. Only empty text has no line.
      lines.emplace_back();
      lines.back().fHardBreak = true;
    }
    if (!p->pieces.empty() && !lines.empty()) {
      const Piece& piece = p->pieces[k];
      LineMetrics& last = lines.back();
      if (piece.override_hard_break) {
        last.fHardBreak = piece.hard_break;
      }
      if (piece.line_end != SIZE_MAX) {
        // The line's text ends before an ellipsis given as text, or the line
        // is the empty one after a hard break its text ends in.
        const size_t end = piece.line_end - offset;
        if (piece.empty_last_line) {
          last.fStartIndex = end;
        }
        for (size_t* index : {&last.fEndExcludingWhitespaces, &last.fEndIndex,
                              &last.fEndIncludingNewline}) {
          *index = piece.empty_last_line ? end : std::min(*index, end);
        }
        if (piece.hanging_end > piece.line_end) {
          last.fEndIndex = last.fEndIncludingNewline =
              piece.hanging_end - offset;
        }
      }
    } else if (p->clamped_end != SIZE_MAX && k + 1 == paragraphs.size() &&
               !lines.empty()) {
      // The line's text ends before the ellipsis it was given as text.
      LineMetrics& last = lines.back();
      for (size_t* index : {&last.fEndExcludingWhitespaces, &last.fEndIndex,
                            &last.fEndIncludingNewline}) {
        *index = std::min(*index, p->clamped_end - offset);
      }
    }
    for (LineMetrics& line : lines) {
      line.fStartIndex += offset;
      line.fEndIndex += offset;
      line.fEndExcludingWhitespaces += offset;
      line.fEndIncludingNewline += offset;
      // Skia gives the empty line after a hard break that ends the text the
      // break's last unit, [length - 1, length), the LF of a CRLF; it starts
      // after the break, at the end of the text, as an empty line between
      // two hard breaks starts after the first.
      if (p->ends_in_hard_break && line.fStartIndex >= p->hard_breaks.back() &&
          line.fEndExcludingWhitespaces > line.fStartIndex) {
        line.fStartIndex = line.fEndIndex = line.fEndExcludingWhitespaces =
            line.fEndIncludingNewline = p->length;
      }
      // Skia counts a hard break that ends the text in the line before it;
      // the line's text stops at its first hard break.
      const auto brk = std::lower_bound(p->hard_breaks.begin(),
                                        p->hard_breaks.end(), line.fStartIndex);
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
      // painted runs include it. Only that line's: elsewhere a run can end
      // past the line, as one does in RTL whose zero-width character (a
      // ZWSP) a negative letter spacing gives a negative width.
      const auto& text_lines = static_cast<ParagraphImpl*>(paragraph)->lines();
      const size_t n = std::min(lines.size(), text_lines.size());
      // The ellipsis comes after the line's text, which in RTL is on its
      // left, so the runs visited there can end before a placeholder on the
      // line's right (which isn't visited).
      for (size_t i = 0; i < n; i++) {
        if (const Run* ellipsis = text_lines[i].ellipsis()) {
          float& line_width = p->line_widths[first + i];
          line_width =
              std::max(line_width, static_cast<float>(lines[i].fWidth) +
                                       ellipsis->advance().fX +
                                       p->kept_whitespace[first + i]);
        }
      }
      paragraph->visit([&](int line, const Paragraph::VisitorInfo* run) {
        if (run == nullptr || line < 0 || static_cast<size_t>(line) >= n ||
            text_lines[line].ellipsis() == nullptr) {
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
  // baseline placed by the font's ascent and descent as Chrome rounds them.
  // Skia rounds line heights to whole pixels and measures the strut with
  // hinted metrics, so its own baselines drift from this.
  const float baseline_in_box = baseline_in_line_box(
      p->line_height, p->content_ascent, p->content_descent);
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
  const auto placed = placements(p);
  p->placeholder_boxes.assign(p->placeholders.size(), {});
  for (size_t j = 0; j < p->placeholders.size(); j++) {
    const auto& placeholder = p->placeholders[j];
    const auto [k, local] = placed[j];
    if (k >= paragraphs.size()) {
      continue;
    }
    // Its line, unless max_lines or an ellipsis cut it off.
    const size_t index = paragraphs[k].offset + local;
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
    const auto rects = paragraphs[k].paragraph->getRectsForRange(
        local, local + 1, RectHeightStyle::kTight, RectWidthStyle::kTight);
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
  for (const auto& laid : laid_out(p)) {
    m->longest_line =
        std::max(m->longest_line, laid.paragraph->getLongestLine());
  }
  // Both measured once, on the first layout, so they don't depend on the
  // width or on the layouts before. nowrap text cannot shrink to its widest
  // word: its min-content width is its max-content width, as in CSS.
  const float max_content = std::max(p->max_content, 0.f);
  m->min_intrinsic_width = p->nowrap ? max_content : p->widest_word;
  // Never less than min-content, as in CSS, which a negative letter spacing
  // on an invisible character (a soft hyphen) could make it.
  m->max_intrinsic_width = std::max(max_content, m->min_intrinsic_width);
  // Each line of nowrap text with an ellipsis is its own one-line paragraph,
  // which "exceeds" its one line whenever it is truncated to the width.
  if (!(p->nowrap && p->ellipsized)) {
    m->did_exceed_max_lines = p->pieces.empty()
                                  ? p->paragraphs.front()->didExceedMaxLines()
                                  : p->pieces_exceeded_max_lines;
  }
  m->line_height = p->line_height;
  m->ascent = p->ascent;
  m->descent = p->descent;
  m->line_gap = p->line_gap;
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
  const int n = std::min(count, static_cast<int>(p->placeholder_boxes.size()));
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
  const auto paragraphs = laid_out(p);
  if (p->first_lines.size() != paragraphs.size()) {
    return;
  }
  effing::Painted drawn;
  for (size_t k = 0; k < paragraphs.size(); k++) {
    effing::paint_paragraph_unsnapped(
        paragraphs[k].paragraph, reinterpret_cast<SkCanvas*>(c_canvas), x, y,
        *reinterpret_cast<SkPaint*>(c_paint),
        p->line_origins.data() + p->first_lines[k], &drawn);
  }
  drawn.export_to(painted);
}

void effing_paragraph_destroy(effing_paragraph* p) {
  delete p;
}

}  // extern "C"
