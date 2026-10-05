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
#include "word_break.hpp"

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
  // whitespace. Measured on the first layout.
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
  // That Skia text's UTF-8 offset at each UTF-16 offset.
  std::vector<size_t> utf8_offsets;
  // Laid out and painted in place of `paragraphs` when a word too wide for
  // its line splits the text; empty otherwise.
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
      return baseline - p->ascent;
    case EFFING_PLACEHOLDER_TEXT_BOTTOM:
      return baseline + p->descent - spec.height;
    default:
      return baseline - spec.baseline_offset;
  }
}

using Piece = effing_paragraph::Piece;
using PieceKind = effing_paragraph::PieceKind;

// Builds a paragraph of text[start, end) (UTF-8 offsets in p->text) with the
// placeholders [first, last) in it and `suffix` after it, in p's style, with
// at most `max_lines` lines (0 for no limit, and then no ellipsis). Reports
// each placeholder's index and its UTF-16 index in the paragraph's text to
// `placed`.
// - kUnbounded is for one line at the unbounded width, where floats are too
//   coarse for any alignment but the start.
// - kBreakFirstWord lets a line break between any two grapheme clusters of
//   the text's first word.
std::unique_ptr<Paragraph> build(const effing_paragraph* p,
                                 size_t start,
                                 size_t end,
                                 size_t first,
                                 size_t last,
                                 int max_lines,
                                 PieceKind kind,
                                 const SkString& suffix,
                                 std::vector<std::pair<size_t, size_t>>* placed,
                                 bool ellipsis = true) {
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
  // Paragraphs whose line breaks differ must not share Skia's cache entry.
  const std::string tag =
      effing::word_break_cache_tag(p->word_break, break_first_word);
  if (!tag.empty()) {
    StrutStyle strut = style.getStrutStyle();
    auto families = p->strut_families;
    families.emplace_back(tag.c_str());
    strut.setFontFamilies(families);
    style.setStrutStyle(strut);
  }
  ParagraphBuilderImpl builder(
      style, p->font_collection,
      effing::make_word_break_unicode(p->word_break, break_first_word));
  size_t next = first;
  add_content(&builder, p->text.data(), start, end, p->placeholder_specs.data(),
              last, &next, [&](size_t placeholder, size_t index) {
                placed->emplace_back(placeholder, index);
              });
  if (!suffix.isEmpty()) {
    builder.addText(suffix.c_str(), suffix.size());
  }
  return builder.Build();
}

// The offset in p->text of `skia`, an offset in the Skia text of the whole
// paragraph, where each placeholder is a U+FFFC of 3 bytes, and the number of
// placeholders before it.
std::pair<size_t, size_t> to_text(const effing_paragraph* p, size_t skia) {
  size_t k = 0;
  while (k < p->placeholder_specs.size() &&
         p->placeholder_specs[k].offset + 3 * k < skia) {
    k++;
  }
  return {skia - 3 * k, k};
}

// Builds a piece of the whole paragraph's Skia text [start, end).
std::unique_ptr<Paragraph> build_piece(
    const effing_paragraph* p,
    size_t start,
    size_t end,
    int max_lines,
    PieceKind kind,
    const SkString& suffix,
    std::vector<std::pair<size_t, size_t>>* placed) {
  const auto [text_start, first] = to_text(p, start);
  const auto [text_end, last] = to_text(p, end);
  // Only the line given an ellipsis as `suffix` may truncate with Skia's.
  return build(p, text_start, text_end, first, last, max_lines, kind, suffix,
               placed, !suffix.isEmpty());
}

// Measures the words of wrapping text from SkParagraph's clusters, which are
// what its line breaker measures: their widths, and the widest one, CSS
// min-content. Skia's own minimum is off in places: it is the whole text when
// the text has no spaces and fits on a line, and it leaves out the last
// cluster of a word too wide for the line at the end of the text. A
// placeholder is a word of its own.
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
  const auto breaks = [&](size_t i) {
    return whole->codeUnitHasProperty(i, SkUnicode::kSoftLineBreakBefore) ||
           whole->codeUnitHasProperty(i, SkUnicode::kHardLineBreakBefore);
  };
  p->words.clear();
  p->graphemes.clear();
  p->widest_word = 0;
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
      p->words.push_back({start, range.start, content_end, trimmed});
      p->widest_word = std::max(p->widest_word, trimmed);
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
    p->words.push_back({start, text.size(), content_end, trimmed});
    p->widest_word = std::max(p->widest_word, trimmed);
  }
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
// Each piece is built once. Leaves p->pieces empty when no word is too wide.
void split_around_long_words(effing_paragraph* p, float w) {
  // The last layout's pieces, which this one reuses where it can.
  std::vector<Piece> previous = std::move(p->pieces);
  p->pieces.clear();
  p->pieces_exceeded_max_lines = false;
  if (p->nowrap || w >= kUnbounded || p->paragraphs.size() != 1 ||
      !too_wide(p->widest_word, w)) {
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
    // The spaces before the ellipsis stay where whitespace is kept, as in
    // Chrome; the hard break after them doesn't.
    const size_t line_end =
        empty ? piece.end
        : p->keep_trailing_whitespace
            ? without_hard_break(
                  text.data(), len, line_start,
                  p->utf8_offsets[piece.offset + lines[k].fEndIndex])
            : p->utf8_offsets[piece.offset + lines[k].fEndExcludingWhitespaces];
    if (k == 0) {
      p->pieces.pop_back();
    } else {
      // Its lines before line k, from all its text, shaped as it was: cut
      // inside a word, the text would join and kern differently.
      piece.placed.clear();
      piece.max_lines = static_cast<int>(k);
      piece.paragraph = build_piece(p, piece.start, piece.end, piece.max_lines,
                                    piece.kind, SkString(), &piece.placed);
      piece.paragraph->layout(piece.kind == PieceKind::kUnbounded ? kUnbounded
                                                                  : w);
      piece.hard_break = without_hard_break(text.data(), len, piece.start,
                                            line_start) != line_start;
      piece.override_hard_break = true;
      piece.empty_last_line = false;
      piece.line_end = SIZE_MAX;
    }
    Piece last{};
    last.start = line_start;
    last.end = line_end;
    last.kind = PieceKind::kWrapped;
    last.max_lines = 1;
    last.suffixed = true;
    last.offset = whole->getUTF16Index(line_start);
    last.line_end = whole->getUTF16Index(line_end);
    last.paragraph =
        build_piece(p, line_start, line_end, 1, last.kind,
                    p->paragraph_style.getEllipsis(), &last.placed);
    last.paragraph->layout(w);
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
  const auto add = [&](size_t start, size_t end, PieceKind kind) {
    const bool unbounded = kind == PieceKind::kUnbounded;
    Piece piece{};
    piece.start = start;
    piece.end =
        end < len ? without_hard_break(text.data(), len, start, end) : end;
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
        end < len && !cut &&
        without_hard_break(text.data(), len, start, piece.end) != piece.end;
    piece.line_end =
        piece.empty_last_line ? whole->getUTF16Index(piece.end) : SIZE_MAX;
    // Without an ellipsis, Skia drops the lines past those left, and knows
    // whether text remains; with one, the line the lines run out at is
    // rebuilt, so one more line tells.
    piece.max_lines =
        !limited || unbounded ? 0 : lines_left + (p->ellipsized ? 1 : 0);
    // The last layout's piece of the same text, already shaped.
    for (auto& old : previous) {
      if (old.paragraph && old.start == piece.start && old.end == piece.end &&
          old.kind == kind && old.max_lines == piece.max_lines &&
          old.suffixed == false) {
        piece.paragraph = std::move(old.paragraph);
        piece.placed = std::move(old.placed);
        break;
      }
    }
    if (!piece.paragraph) {
      piece.paragraph = build_piece(p, start, piece.end, piece.max_lines, kind,
                                    SkString(), &piece.placed);
    }
    piece.paragraph->layout(unbounded ? kUnbounded : w);
    const int n = std::max(static_cast<int>(piece.paragraph->lineNumber()), 1);
    const bool truncated = cut || piece.paragraph->didExceedMaxLines();
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
    piece.override_hard_break =
        (end < len || cut) && !piece.paragraph->didExceedMaxLines();
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
        last.paragraph = build_piece(p, start, last.end, lines_left, kind,
                                     SkString(), &last.placed);
        last.paragraph->layout(unbounded ? kUnbounded : w);
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
      last.paragraph = build_piece(p, start, last.end, lines_left, kind,
                                   SkString(), &last.placed);
      last.paragraph->layout(unbounded ? kUnbounded : w);
      last.override_hard_break = false;
      last.empty_last_line = false;
      last.line_end = SIZE_MAX;
    }
    return false;
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
  out->word_break = static_cast<effing::WordBreak>(s->word_break);
  out->overflow_wrap = static_cast<effing::OverflowWrap>(s->overflow_wrap);
  out->max_lines = s->max_lines;
  out->text.assign(text, text_len);
  out->placeholder_specs.assign(placeholders, placeholders + placeholder_count);
  out->paragraph_style = paragraph_style;
  out->strut_families = families;
  out->font_collection = font_collection;
  // The next placeholder to place; each takes one UTF-16 unit (U+FFFC).
  size_t next = 0;
  // Builds a paragraph of text[start, end), with the placeholders up to `end`
  // in it.
  const auto add = [&](size_t start, size_t end, int max_lines) {
    size_t last = next;
    while (last < placeholder_count && placeholders[last].offset <= end) {
      last++;
    }
    out->offsets.push_back(utf16_length(text, start) + next);
    const size_t k = out->paragraphs.size();
    std::vector<std::pair<size_t, size_t>> placed;
    out->paragraphs.push_back(build(out, start, end, next, last, max_lines,
                                    PieceKind::kWrapped, SkString(), &placed));
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
      out->dropped_lines = true;
      break;
    }
    add(start, i, 1);
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
  if (!pieces) {
    for (auto& paragraph : p->paragraphs) {
      paragraph->layout(unbounded ? kUnbounded : w);
    }
  }
  if (!p->nowrap && !p->measured) {
    measure_words(p);
  }
  split_around_long_words(p, w);
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
    if (lines.empty() && (paragraphs.size() > 1 || !p->pieces.empty())) {
      // An empty hard-broken line still takes a line box, as it does when
      // Skia lays out the whole text.
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
      }
    }
    for (LineMetrics& line : lines) {
      line.fStartIndex += offset;
      line.fEndIndex += offset;
      line.fEndExcludingWhitespaces += offset;
      line.fEndIncludingNewline += offset;
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
  for (const auto& paragraph : p->paragraphs) {
    m->min_intrinsic_width =
        std::max(m->min_intrinsic_width, paragraph->getMinIntrinsicWidth());
    m->max_intrinsic_width =
        std::max(m->max_intrinsic_width, paragraph->getMaxIntrinsicWidth());
  }
  if (p->measured) {
    m->min_intrinsic_width = p->widest_word;
  }
  // Skia's minimum is the widest word, which nowrap text cannot shrink to:
  // its min-content width is its max-content width, as in CSS.
  if (p->nowrap) {
    m->min_intrinsic_width = m->max_intrinsic_width;
  }
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
