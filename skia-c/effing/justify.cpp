// Justifies a paragraph's lines as Chrome does (justify.hpp).
#include "justify.hpp"

#include <algorithm>
#include <cstddef>
#include <vector>

#include "modules/skparagraph/src/ParagraphImpl.h"
#include "modules/skparagraph/src/Run.h"
#include "modules/skparagraph/src/TextLine.h"
#include "src/core/SkUTF.h"

namespace effing {

namespace {

using skia::textlayout::Cluster;
using skia::textlayout::ClusterIndex;
using skia::textlayout::Paragraph;
using skia::textlayout::ParagraphImpl;
using skia::textlayout::Run;
using skia::textlayout::TextLine;

// SkParagraph keeps what TextLine::justify writes private to Run and
// TextLine, and calls that only for its own justification. Effing writes the
// same state for its own: an explicit instantiation may name a private
// member, and the friend function it defines hands the member pointer out.
template <typename Tag, typename Tag::Type kMember>
struct PrivateMember {
  friend typename Tag::Type member(Tag) { return kMember; }
};

// Run::fJustificationShifts: for each glyph (and the run's end), the shift
// of its cluster and of the cluster before it on screen.
struct RunShifts {
  using Type = skia_private::STArray<64, SkPoint, true> Run::*;
  friend Type member(RunShifts);
};
template struct PrivateMember<RunShifts, &Run::fJustificationShifts>;

// TextLine::fAdvance, whose x is the line's width.
struct LineAdvance {
  using Type = SkVector TextLine::*;
  friend Type member(LineAdvance);
};
template struct PrivateMember<LineAdvance, &TextLine::fAdvance>;

// TextLine::fWidthWithSpaces: the line's width with the spaces that hang
// after it.
struct LineWidthWithSpaces {
  using Type = SkScalar TextLine::*;
  friend Type member(LineWidthWithSpaces);
};
template struct PrivateMember<LineWidthWithSpaces, &TextLine::fWidthWithSpaces>;

// What a character is to Chrome's justification (Blink's
// JustificationContext::CheckOpportunity, under text-justify: auto).
enum class Kind {
  // A default-ignorable code point: no opportunity, and the one before it
  // carries on past it.
  kIgnorable,
  // A space, a tab, a line feed or a no-break space: an opportunity after
  // it.
  kSpace,
  // A CJK ideograph or symbol (IsCjkIdeographOrSymbol): an opportunity
  // after it, and one before it unless one is already there.
  kCjk,
  // Any other: no opportunity.
  kOther,
};

struct Range {
  char32_t first;
  char32_t last;
};

// Blink's Default_Ignorable_Code_Point (Unicode 16) from U+0100 on.
constexpr Range kIgnorable[] = {
    {0x34F, 0x34F},     {0x61C, 0x61C},     {0x115F, 0x1160},
    {0x17B4, 0x17B5},   {0x180B, 0x180F},   {0x200B, 0x200F},
    {0x202A, 0x202E},   {0x2060, 0x206F},   {0x3164, 0x3164},
    {0xFE00, 0xFE0F},   {0xFEFF, 0xFEFF},   {0xFFA0, 0xFFA0},
    {0xFFF0, 0xFFF8},   {0x1BCA0, 0x1BCA3}, {0x1D173, 0x1D17A},
    {0xE0000, 0xE0FFF},
};

// Blink's IsCjkIdeographOrSymbol (character_property_data.h, with
// character_property_data_generator.cc's emoji): the CJK ideographs,
// radicals, strokes and symbols, the CJK Symbols and Punctuation block but
// for U+302E, U+302F and U+3030, kana, bopomofo, the halfwidth and fullwidth
// forms but for U+FF0D, U+FF1B, U+FF1C, U+FF1E, a list of symbols CJK text
// uses, the Emoji_Presentation code points (Unicode 16) and the
// Extended_Pictographic ones of the RGI emoji ZWJ and modifier sequences
// (such as U+2640 and U+2764). Merged and sorted.
constexpr Range kCjk[] = {
    {0x2C7, 0x2C7},     {0x2CA, 0x2CB},     {0x2D9, 0x2D9},
    {0x2020, 0x2021},   {0x2030, 0x2030},   {0x203B, 0x203C},
    {0x2042, 0x2042},   {0x2047, 0x2049},   {0x2051, 0x2051},
    {0x20DD, 0x20DE},   {0x2100, 0x2100},   {0x2103, 0x2103},
    {0x2105, 0x2105},   {0x2109, 0x210A},   {0x2113, 0x2113},
    {0x2116, 0x2116},   {0x2121, 0x2121},   {0x212B, 0x212B},
    {0x213B, 0x213B},   {0x2150, 0x2152},   {0x2156, 0x215A},
    {0x2160, 0x216B},   {0x2170, 0x217B},   {0x217F, 0x217F},
    {0x2189, 0x2189},   {0x2194, 0x2195},   {0x2307, 0x2307},
    {0x2312, 0x2312},   {0x231A, 0x231B},   {0x23BE, 0x23CC},
    {0x23CE, 0x23CE},   {0x23E9, 0x23EC},   {0x23F0, 0x23F0},
    {0x23F3, 0x23F3},   {0x2423, 0x2423},   {0x2460, 0x2492},
    {0x249C, 0x24FF},   {0x25A0, 0x25A2},   {0x25AA, 0x25AB},
    {0x25B1, 0x25B3},   {0x25B6, 0x25B7},   {0x25BC, 0x25BD},
    {0x25C0, 0x25C1},   {0x25C6, 0x25C7},   {0x25C9, 0x25C9},
    {0x25CB, 0x25CC},   {0x25CE, 0x25D3},   {0x25E2, 0x25E6},
    {0x25EF, 0x25EF},   {0x25FD, 0x25FE},   {0x2600, 0x2603},
    {0x2605, 0x2606},   {0x260E, 0x260E},   {0x2614, 0x2617},
    {0x261D, 0x261D},   {0x2620, 0x2620},   {0x2640, 0x2640},
    {0x2642, 0x2642},   {0x2648, 0x2653},   {0x2660, 0x266F},
    {0x2672, 0x267D},   {0x267F, 0x267F},   {0x2693, 0x2693},
    {0x2695, 0x2696},   {0x26A0, 0x26A1},   {0x26A7, 0x26A7},
    {0x26AA, 0x26AB},   {0x26BD, 0x26BE},   {0x26C4, 0x26C5},
    {0x26CE, 0x26CE},   {0x26D3, 0x26D4},   {0x26EA, 0x26EA},
    {0x26F2, 0x26F3},   {0x26F5, 0x26F5},   {0x26F9, 0x26FA},
    {0x26FD, 0x26FD},   {0x2705, 0x2705},   {0x2708, 0x2708},
    {0x270A, 0x270D},   {0x2713, 0x2713},   {0x271A, 0x271A},
    {0x2728, 0x2728},   {0x273F, 0x2740},   {0x2744, 0x2744},
    {0x274C, 0x274C},   {0x274E, 0x274E},   {0x2753, 0x2757},
    {0x2763, 0x2764},   {0x2776, 0x277F},   {0x2795, 0x2797},
    {0x27A1, 0x27A1},   {0x27B0, 0x27B0},   {0x27BF, 0x27BF},
    {0x2B1A, 0x2B1C},   {0x2B50, 0x2B50},   {0x2B55, 0x2B55},
    {0x2E80, 0x2FDF},   {0x2FF0, 0x302D},   {0x3031, 0x312F},
    {0x3190, 0x31EF},   {0x3200, 0x9FFF},   {0xF860, 0xF862},
    {0xF900, 0xFAFF},   {0xFE10, 0xFE12},   {0xFE19, 0xFE19},
    {0xFE30, 0xFE6F},   {0xFF00, 0xFF0C},   {0xFF0E, 0xFF1A},
    {0xFF1D, 0xFF1D},   {0xFF1F, 0xFFEF},   {0x16FE0, 0x18AFF},
    {0x1B000, 0x1B12F}, {0x1B170, 0x1B2FF}, {0x1F004, 0x1F004},
    {0x1F0CF, 0x1F0CF}, {0x1F100, 0x1F100}, {0x1F110, 0x1F129},
    {0x1F130, 0x1F149}, {0x1F150, 0x1F169}, {0x1F170, 0x1F189},
    {0x1F18E, 0x1F18E}, {0x1F191, 0x1F19A}, {0x1F1E6, 0x1F6D7},
    {0x1F6D9, 0x1F6FF}, {0x1F7E0, 0x1F7EB}, {0x1F7F0, 0x1F7F0},
    {0x1F900, 0x1F9FF}, {0x1FA70, 0x1FA7C}, {0x1FA80, 0x1FA89},
    {0x1FA8F, 0x1FAC6}, {0x1FAC9, 0x1FACC}, {0x1FACE, 0x1FADC},
    {0x1FADF, 0x1FAE9}, {0x1FAF0, 0x1FAF8}, {0x20000, 0x2FFFF},
};

template <size_t N>
bool in(const Range (&ranges)[N], char32_t c) {
  const Range* end = ranges + N;
  const Range* range = std::lower_bound(
      ranges, end, c, [](const Range& r, char32_t v) { return r.last < v; });
  return range != end && range->first <= c;
}

Kind kind_of(char32_t c) {
  if (c < 0x100 ? c == 0xAD : in(kIgnorable, c)) {
    return Kind::kIgnorable;
  }
  if (c == ' ' || c == '\t' || c == '\n' || c == 0xA0) {
    return Kind::kSpace;
  }
  return c >= 0x2C7 && in(kCjk, c) ? Kind::kCjk : Kind::kOther;
}

// The space separators other than the space, the no-break spaces and the
// ideographic space (the en and em spaces, ...), which SkParagraph lets hang
// at the end of a line, as it lets spaces hang. Chrome hangs the ideographic
// space there too, but counts these in the line's width; it breaks the line
// before them where they don't fit.
bool other_space_separator(char32_t c) {
  return c == 0x1680 || (c >= 0x2000 && c <= 0x200A && c != 0x2007) ||
         c == 0x205F;
}

// The code point `cluster`'s text starts with: the one Chrome looks at for
// the glyphs of a cluster.
char32_t first_code_point(const ParagraphImpl* impl, const Cluster& cluster) {
  const SkSpan<const char> text = impl->text();
  const char* at = text.data() + cluster.textRange().start;
  const char* end =
      text.data() + std::min(cluster.textRange().end, text.size());
  if (at >= end) {
    return 0;
  }
  const SkUnichar c = SkUTF::NextUTF8(&at, end);
  return c < 0 ? 0xFFFD : static_cast<char32_t>(c);
}

// Moves `cluster`'s glyphs by `shift`, its left edge on screen by `before`
// (the shift of the cluster before it), as TextLine::shiftCluster does.
void shift_cluster(const Cluster& cluster, float shift, float before) {
  Run& run = cluster.run();
  auto& shifts = run.*member(RunShifts());
  if (shifts.empty()) {
    shifts.push_back_n(static_cast<int>(run.size()) + 1, SkPoint{0, 0});
  }
  size_t end = cluster.endPos();
  if (end == run.size()) {
    // The run's end moves with its last cluster.
    end++;
  }
  for (size_t pos = cluster.startPos(); pos < end; pos++) {
    shifts[static_cast<int>(pos)] = {shift, before};
  }
}

struct Item {
  const Cluster* cluster;
  // Among the spaces that hang after the line.
  bool ghost;
  Kind kind;
  // Whether the line expands right before it and right after it.
  bool before = false;
  bool after = false;
};

// Justifies `line` as TextLine::format would under TextAlign::kJustify, but
// as Chrome does: Blink's ApplyJustification, with ShapeResultSpacing's
// opportunities.
//
// Chrome expands a line at its characters' justification opportunities:
// after each space, tab and no-break space, and after each CJK ideograph or
// symbol, and before one where the character before it has none after it.
// The line's last character, before the spaces that hang, has none after
// it: Chrome counts the opportunities in the line's text up to those spaces,
// starting as if after one, and drops the last one where the text ends with
// one. The space the line lacks is spread over them equally. A line with
// none is left start-aligned.
//
// Chrome counts a line's opportunities in the order of its text, backwards
// in an RTL paragraph, which is their order on screen in a line of one
// direction; SkParagraph's line is walked on screen. Each expansion goes
// where Chrome puts it: after a space as part of the space (whose glyph,
// which is blank, moves with it), before an ideograph as part of it, and
// after one as part of what follows, as TextLine::justify puts it; but
// before a placeholder, which SkParagraph places by the advances before it
// alone, as part of the ideograph, which moves instead.
void justify_line(const ParagraphImpl* impl, TextLine& line, float width) {
  const float advance = line.widthWithoutEllipsis();
  float space = width - line.width();
  if (space <= 0 || line.endsWithHardLineBreak()) {
    return;
  }
  std::vector<Item> items;
  float separators = 0;
  line.iterateThroughClustersInGlyphsOrder(
      false, true, [&](const Cluster* cluster, ClusterIndex, bool ghost) {
        const char32_t c = first_code_point(impl, *cluster);
        items.push_back({cluster, ghost, kind_of(c)});
        if (ghost && other_space_separator(c)) {
          separators += cluster->width();
        }
        return true;
      });
  if (separators > 0 && separators <= space) {
    space -= separators;
  }

  int count = 0;
  bool after_opportunity = true;
  Item* last = nullptr;
  for (Item& item : items) {
    if (item.ghost || item.kind == Kind::kIgnorable) {
      continue;
    }
    item.before = item.kind == Kind::kCjk && !after_opportunity;
    item.after = item.kind == Kind::kSpace || item.kind == Kind::kCjk;
    after_opportunity = item.after;
    count += item.before + item.after;
    last = &item;
  }
  if (last != nullptr && last->after) {
    last->after = false;
    count--;
  }
  if (count == 0) {
    return;
  }

  // Each opportunity's share, the shares taken so far summed exactly, as
  // Blink hands the last one what is left.
  int taken = 0;
  const auto shift = [&] {
    return static_cast<float>(static_cast<double>(space) * taken / count);
  };
  float before = 0;
  for (size_t i = 0; i < items.size(); i++) {
    Item& item = items[i];
    if (item.ghost) {
      // As TextLine::justify: spaces that hang after an LTR run follow the
      // line's end, an RTL run's stay where they are.
      if (item.cluster->run().leftToRight()) {
        shift_cluster(*item.cluster, space, space);
      }
      continue;
    }
    bool next_placeholder = false;
    for (size_t k = i + 1; k < items.size(); k++) {
      if (!items[k].ghost) {
        next_placeholder = items[k].cluster->run().isPlaceholder();
        break;
      }
    }
    taken += item.before;
    if (item.after && (item.kind == Kind::kSpace || next_placeholder)) {
      taken++;
      item.after = false;
    }
    const float glyph = shift();
    shift_cluster(*item.cluster, glyph, before);
    before = glyph;
    taken += item.after;
  }

  (line.*member(LineAdvance())).fX = width;
  line.*member(LineWidthWithSpaces()) += width - advance;
}

}  // namespace

void justify_lines(Paragraph* paragraph, float width) {
  auto* impl = static_cast<ParagraphImpl*>(paragraph);
  for (TextLine& line : impl->lines()) {
    justify_line(impl, line, width);
  }
}

}  // namespace effing
