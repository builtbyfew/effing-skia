// Effing's paragraphs laid out with upstream's Blink-style shaper
// (paragraph_blink.hpp).
//
// Chrome lays a paragraph out by shaping its text whole, finding where its
// lines break from the advances of that shape, and shaping each line's text
// anew at its edges, where the shape is not safe to break. This does the same
// with the shaper fillText uses: each hard-broken line of the text is shaped
// whole once, for the advances its lines are broken by, and each line is then
// laid out on its own, as fillText lays out its text, which gives the line its
// glyphs and its width. A line that the advances said fits but whose own
// layout comes out too wide gives back its last word, as Chrome's line
// breaker does.
#include "paragraph_blink.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "../skia_c.hpp"
#include "../text_caches.hpp"
#include "include/core/SkFont.h"
#include "include/core/SkFontStyle.h"
#include "include/core/SkTypeface.h"
#include "justify.hpp"
#include "line_box.hpp"
#include "modules/skparagraph/include/DartTypes.h"
#include "modules/skparagraph/include/FontCollection.h"
#include "modules/skunicode/include/SkUnicode.h"
#include "src/core/SkUTF.h"
#include "text.hpp"
#include "word_break.hpp"

// text.cpp: the line fillText lays out for `request`, which the next layout
// may evict from its cache.
const TextCaches::Line& effing_lay_out_text_line(
    skiac_font_collection* c_collection,
    const skiac_text_request& request);
// shaper.cpp: the primary font of `request`'s font list, before font
// arguments.
sk_sp<SkTypeface> effing_primary_face(skiac_font_collection* c_collection,
                                      const skiac_text_request& request);

namespace effing {

namespace {

using skia::textlayout::TextAlign;
using skia::textlayout::TextDirection;

// Wide enough for any real layout, small enough to stay exact in float.
constexpr float kUnbounded = 1e7f;

// What each placeholder is shaped as, and a lone CR (docs/effing.md): U+2063
// INVISIBLE SEPARATOR, which HarfBuzz hides and the line breaker takes for a
// letter.
constexpr char kObjectReplacement[] = "\xEF\xBF\xBC";
constexpr char kInvisibleSeparator[] = "\xE2\x81\xA3";

// One glyph of a laid-out line, in visual order.
struct Glyph {
  // Its font, in Shaped::fonts.
  uint32_t font;
  SkGlyphID id;
  // Where its advance starts, from the line's left edge, and where the glyph
  // sits from there.
  float pen;
  SkPoint offset;
  // Its cluster's first byte in BlinkParagraph::text.
  size_t cluster;
  // Its advance, up to the next glyph on screen as the shaper laid them
  // out (and as justification widens it).
  float advance = 0;
};

// A line of text as the shaper lays it out.
struct Shaped {
  std::vector<SkFont> fonts;
  std::vector<Glyph> glyphs;
  float width = 0;
  // The placeholders in it, and the x where each one's box starts.
  std::vector<std::pair<size_t, float>> boxes;
};

// The advance of glyphs[i] as the shaper lays it out: up to the next glyph
// on screen.
float advance_of(const Shaped& shaped, size_t i) {
  const float next =
      i + 1 < shaped.glyphs.size() ? shaped.glyphs[i + 1].pen : shaped.width;
  return next - shaped.glyphs[i].pen;
}

// Puts `tail` on screen after `shaped`, to its right.
void append(Shaped* shaped, const Shaped& tail) {
  const auto fonts = static_cast<uint32_t>(shaped->fonts.size());
  shaped->fonts.insert(shaped->fonts.end(), tail.fonts.begin(),
                       tail.fonts.end());
  for (Glyph glyph : tail.glyphs) {
    glyph.font += fonts;
    glyph.pen += shaped->width;
    shaped->glyphs.push_back(glyph);
  }
  for (auto [placeholder, x] : tail.boxes) {
    shaped->boxes.emplace_back(placeholder, x + shaped->width);
  }
  shaped->width += tail.width;
}

// Puts `head` on screen before `shaped`, to its left.
void prepend(Shaped* shaped, const Shaped& head) {
  Shaped joined = head;
  append(&joined, *shaped);
  *shaped = std::move(joined);
}

// The generic family a family name is, as ctx.font reads it (src/font.rs
// GenericFamily, skiac_text_family::generic), or 0 for a named one.
int generic_of(const SkString& name) {
  std::string lower(name.c_str(), name.size());
  for (char& c : lower) {
    if (c >= 'A' && c <= 'Z') {
      c = static_cast<char>(c - 'A' + 'a');
    }
  }
  static constexpr const char* kGenerics[] = {
      "serif",     "sans-serif", "cursive",      "fantasy",
      "monospace", "system-ui",  "-webkit-body", "math",
  };
  for (size_t i = 0; i < std::size(kGenerics); i++) {
    if (lower == kGenerics[i]) {
      return static_cast<int>(i) + 1;
    }
  }
  return 0;
}

// Whitespace that hangs at the end of a line, outside its width.
bool hangs(char32_t c) {
  return c == ' ' || c == '\t' || c == 0x3000;
}

// Whitespace that collapses away at the start of a hard line.
bool collapses(char32_t c) {
  return c == ' ' || c == '\t';
}

// Whether `w` fits in `width`, in Chrome's LayoutUnits: the line breaker
// compares widths ceiled to 1/64px.
bool fits(float w, float width) {
  if (width >= kUnbounded) {
    return true;
  }
  return std::ceil(static_cast<double>(w) * 64 - 1e-3) / 64 <= width + 1e-6;
}

}  // namespace

struct BlinkParagraph {
  skiac_font_collection* collection = nullptr;
  // The text as it is shaped: UTF-8, with U+FFFC where each placeholder sits
  // and U+2063 for each lone CR.
  std::string text;
  // The UTF-16 index in the caller's text (each placeholder taking one unit)
  // of each byte of `text` and of its end.
  std::vector<size_t> utf16;
  // The code point that starts at each byte of `text`, or 0 within one.
  std::vector<char32_t> chars;
  // The placeholders, and the one at each byte of `text` (SIZE_MAX for none).
  std::vector<effing_paragraph_placeholder> placeholders;
  std::vector<size_t> placeholder_at;
  std::vector<size_t> placeholder_of;
  // The hard lines, [start, end) in `text` without the break, and whether a
  // hard break ends the text, which gives an empty last one.
  struct HardLine {
    size_t start;
    size_t end;
  };
  std::vector<HardLine> hard_lines;
  bool ends_in_hard_break = false;
  // The SkUnicode::CodeUnitFlags of each byte of `text`, and its bidi level
  // in its hard line.
  std::vector<SkUnicode::CodeUnitFlags> flags;
  std::vector<SkUnicode::BidiLevel> levels;
  sk_sp<SkUnicode> unicode;

  // The style.
  std::vector<std::string> family_names;
  std::vector<skiac_text_family> families;
  float font_size = 0;
  float weight = 400;
  int slant = 0;
  float letter_spacing = 0;
  bool rtl = false;
  TextAlign align = TextAlign::kLeft;
  bool nowrap = false;
  int max_lines = 0;
  std::string ellipsis;
  bool keep_trailing_whitespace = false;
  OverflowWrap overflow_wrap = OverflowWrap::kNormal;
  // What a line that breaks at a soft hyphen (U+00AD) ends with: U+2010 if
  // the primary font has it, else "-", as Chrome picks it. Empty when no
  // line can break at one.
  std::string hyphen;

  // The line box.
  float line_height = 0;
  float ascent = 0;
  float descent = 0;
  float line_gap = 0;
  float content_ascent = 0;
  float content_descent = 0;
  float x_height = 0;

  // Measured on the first layout: the sums of the advances of the bytes'
  // clusters in the shapes of their hard lines (advance_sums[i] is up to byte
  // i), the hyphen's and the ellipsis's width, and the intrinsic widths.
  bool measured = false;
  std::vector<double> advance_sums;
  Shaped hyphen_shape;
  Shaped ellipsis_shape;
  float min_content = 0;
  float max_content = 0;

  // The layout.
  struct Line {
    // The line's text in `text`: up to the whitespace that hangs after it.
    size_t start = 0;
    size_t end = 0;
    // Where the whitespace that hangs after it ends.
    size_t brk = 0;
    bool hard_break = false;
    float left = 0;
    float baseline = 0;
    Shaped shaped;
  };
  std::vector<Line> lines;
  std::vector<effing_paragraph_placeholder_box> boxes;
  bool exceeded_max_lines = false;
  float laid_out_width = -1;
};

namespace {

using Line = BlinkParagraph::Line;
using HardLine = BlinkParagraph::HardLine;

bool has_flag(const BlinkParagraph& p, size_t at, SkUnicode::CodeUnitFlags f) {
  return at < p.flags.size() && (p.flags[at] & f) != 0;
}

bool is_placeholder(const BlinkParagraph& p, size_t at) {
  return at < p.placeholder_of.size() && p.placeholder_of[at] != SIZE_MAX;
}

// The start of the code point before byte `at`.
size_t previous_char(const BlinkParagraph& p, size_t at) {
  do {
    at--;
  } while (at > 0 && p.chars[at] == 0);
  return at;
}

// The end of the code point at byte `at`.
size_t next_char(const BlinkParagraph& p, size_t at) {
  do {
    at++;
  } while (at < p.text.size() && p.chars[at] == 0);
  return at;
}

// text[start, end) without the whitespace that hangs after it.
size_t without_hanging(const BlinkParagraph& p, size_t start, size_t end) {
  while (end > start) {
    const size_t before = previous_char(p, end);
    if (!hangs(p.chars[before]) || is_placeholder(p, before)) {
      break;
    }
    end = before;
  }
  return end;
}

// The sum of the advances of text[start, end) in the shape of its hard line.
float advance(const BlinkParagraph& p, size_t start, size_t end) {
  return static_cast<float>(p.advance_sums[end] - p.advance_sums[start]);
}

skiac_text_request make_request(const BlinkParagraph& p,
                                const std::string& text,
                                bool rtl,
                                float letter_spacing) {
  skiac_text_request request{};
  request.text = text.data();
  request.text_len = text.size();
  request.families = p.families.data();
  request.family_count = p.families.size();
  request.size = p.font_size;
  request.weight = p.weight;
  request.slope =
      p.slant == static_cast<int>(SkFontStyle::kUpright_Slant) ? 0.f : 14.f;
  request.style = p.slant;
  request.stretch = static_cast<int>(SkFontStyle::kNormal_Width);
  request.stretch_pct = 100;
  // TextBaseline::Alphabetic (src/sk.rs).
  request.baseline = 3;
  request.align = static_cast<int>(TextAlign::kLeft);
  request.direction =
      static_cast<int>(rtl ? TextDirection::kRtl : TextDirection::kLtr);
  request.letter_spacing = letter_spacing;
  request.lang = "";
  request.text_rendering = kTextRenderingGeometricPrecision;
  request.size_adjust_metric = -1;
  return request;
}

// Lays `text` out as fillText would, its glyphs' clusters counted from
// `offset` in p.text.
Shaped shape_string(const BlinkParagraph& p,
                    const std::string& text,
                    size_t offset,
                    bool rtl,
                    float letter_spacing) {
  Shaped shaped;
  if (text.empty()) {
    return shaped;
  }
  const skiac_text_request request = make_request(p, text, rtl, letter_spacing);
  const TextCaches::Line& line =
      effing_lay_out_text_line(p.collection, request);
  if (line.empty) {
    return shaped;
  }
  shaped.width = line.line_width;
  for (const BlinkRun& run : line.blink.runs) {
    const auto font = static_cast<uint32_t>(shaped.fonts.size());
    shaped.fonts.push_back(run.font);
    for (size_t i = 0; i < run.glyphs.size(); i++) {
      // BlinkRun's positions have HarfBuzz's offsets added to the pen.
      const SkPoint hb =
          i < run.offsets.size() ? run.offsets[i] : SkPoint{0, 0};
      shaped.glyphs.push_back({font,
                               run.glyphs[i],
                               run.origin.fX + run.positions[i].fX - hb.fX,
                               {hb.fX, run.origin.fY + run.positions[i].fY},
                               offset + run.clusters[i]});
    }
  }
  for (size_t i = 0; i < shaped.glyphs.size(); i++) {
    shaped.glyphs[i].advance = advance_of(shaped, i);
  }
  return shaped;
}

// Lays text[start, end) of p.text out as Chrome's inline layout does: each
// run of it at one bidi level (of the levels its hard line resolves to, as
// UAX #9 has them) shaped on its own, as fillText shapes text of the run's
// direction, and the runs put in their visual order. A lone CR, which Chrome
// takes for a paragraph separator, has no width and no glyph, and ends a run.
Shaped shape_pieces(const BlinkParagraph& p, size_t start, size_t end) {
  struct Piece {
    size_t start;
    size_t end;
    SkUnicode::BidiLevel level;
  };
  std::vector<Piece> pieces;
  const SkUnicode::BidiLevel base = p.rtl ? 1 : 0;
  for (size_t at = start; at < end;) {
    if (p.chars[at] == '\r') {
      pieces.push_back({at, at, base});
      at += 3;
      continue;
    }
    const SkUnicode::BidiLevel level = p.levels[at];
    size_t to = at;
    while (to < end && p.chars[to] != '\r' && p.levels[to] == level) {
      to = next_char(p, to);
    }
    pieces.push_back({at, to, level});
    at = to;
  }
  // UAX #9 L1: whitespace that ends the line takes the paragraph's level.
  for (size_t k = pieces.size(); k-- > 0;) {
    Piece& piece = pieces[k];
    size_t from = piece.end;
    while (from > piece.start && hangs(p.chars[previous_char(p, from)]) &&
           !is_placeholder(p, previous_char(p, from))) {
      from = previous_char(p, from);
    }
    if (from == piece.end || piece.level == base) {
      break;
    }
    if (from > piece.start) {
      pieces.insert(pieces.begin() + static_cast<long>(k) + 1,
                    {from, piece.end, base});
      pieces[k].end = from;
      break;
    }
    piece.level = base;
  }
  std::vector<SkUnicode::BidiLevel> levels;
  for (const Piece& piece : pieces) {
    levels.push_back(piece.level);
  }
  std::vector<int32_t> order(pieces.size());
  for (size_t k = 0; k < order.size(); k++) {
    order[k] = static_cast<int32_t>(k);
  }
  if (pieces.size() > 1 && p.unicode) {
    p.unicode->reorderVisual(levels.data(), static_cast<int>(levels.size()),
                             order.data());
  }
  Shaped shaped;
  for (const int32_t k : order) {
    const Piece& piece = pieces[static_cast<size_t>(k)];
    if (piece.end > piece.start) {
      append(
          &shaped,
          shape_string(p, p.text.substr(piece.start, piece.end - piece.start),
                       piece.start, (piece.level & 1) != 0, p.letter_spacing));
    }
  }
  return shaped;
}

// shape_pieces, with each placeholder's U+FFFC as wide as the placeholder
// and drawn as nothing.
Shaped shape_range(const BlinkParagraph& p, size_t start, size_t end) {
  Shaped shaped = shape_pieces(p, start, end);
  bool any = false;
  for (const Glyph& glyph : shaped.glyphs) {
    any |= is_placeholder(p, glyph.cluster);
  }
  if (!any) {
    return shaped;
  }
  std::vector<Glyph> kept;
  kept.reserve(shaped.glyphs.size());
  float shift = 0;
  for (size_t i = 0; i < shaped.glyphs.size(); i++) {
    Glyph glyph = shaped.glyphs[i];
    const float glyph_advance = glyph.advance;
    if (!is_placeholder(p, glyph.cluster)) {
      glyph.pen += shift;
      kept.push_back(glyph);
      continue;
    }
    const size_t placeholder = p.placeholder_of[glyph.cluster];
    const bool first =
        shaped.boxes.empty() || shaped.boxes.back().first != placeholder;
    if (first) {
      shaped.boxes.emplace_back(placeholder, glyph.pen + shift);
      shift += p.placeholders[placeholder].width;
    }
    shift -= glyph_advance;
  }
  shaped.glyphs = std::move(kept);
  shaped.width += shift;
  return shaped;
}

// The line-break opportunity after `at` in `line`, or its end.
size_t next_opportunity(const BlinkParagraph& p,
                        const HardLine& line,
                        size_t at) {
  for (size_t i = at + 1; i < line.end; i++) {
    if (p.chars[i] != 0 &&
        has_flag(p, i, SkUnicode::CodeUnitFlags::kSoftLineBreakBefore)) {
      return i;
    }
  }
  return line.end;
}

// Whether a line of text[start, end) ends at a soft hyphen it breaks at.
bool ends_in_soft_hyphen(const BlinkParagraph& p, size_t start, size_t end) {
  return !p.hyphen.empty() && end > start &&
         p.chars[previous_char(p, end)] == 0xAD;
}

// The width a line of text[start, end), up to the whitespace that hangs after
// it, takes by the advances of its hard line's shape, with the hyphen when it
// ends at a soft hyphen.
float estimate(const BlinkParagraph& p,
               size_t start,
               size_t end,
               bool hyphenate) {
  float w = advance(p, start, end);
  if (hyphenate && ends_in_soft_hyphen(p, start, end)) {
    w += p.hyphen_shape.width;
  }
  return w;
}

// Drops the glyphs and placeholders of the bytes from `from` on, closing up
// the gaps they leave.
void drop_from(const BlinkParagraph& p, Shaped* shaped, size_t from) {
  std::vector<Glyph> kept;
  kept.reserve(shaped->glyphs.size());
  std::vector<float> boxes;
  for (const auto& box : shaped->boxes) {
    boxes.push_back(box.second);
  }
  float shift = 0;
  for (size_t i = 0; i < shaped->glyphs.size(); i++) {
    Glyph glyph = shaped->glyphs[i];
    if (glyph.cluster >= from) {
      const float dropped = glyph.advance;
      // The placeholders after it on screen close up too.
      for (size_t k = 0; k < shaped->boxes.size(); k++) {
        if (boxes[k] >= glyph.pen + dropped - 1e-3f) {
          shaped->boxes[k].second -= dropped;
        }
      }
      shift -= dropped;
      continue;
    }
    glyph.pen += shift;
    kept.push_back(glyph);
  }
  // As do the glyphs and placeholders after a placeholder that is dropped.
  std::vector<std::pair<size_t, float>> kept_boxes;
  for (size_t k = 0; k < shaped->boxes.size(); k++) {
    auto box = shaped->boxes[k];
    if (p.placeholder_at[box.first] < from) {
      kept_boxes.push_back(box);
      continue;
    }
    const float width = p.placeholders[box.first].width;
    for (Glyph& glyph : kept) {
      if (glyph.pen >= box.second + width - 1e-3f) {
        glyph.pen -= width;
      }
    }
    for (auto& other : shaped->boxes) {
      if (other.second >= box.second + width - 1e-3f) {
        other.second -= width;
      }
    }
    for (auto& other : kept_boxes) {
      if (other.second >= box.second + width - 1e-3f) {
        other.second -= width;
      }
    }
    shift -= width;
  }
  shaped->boxes = std::move(kept_boxes);
  shaped->glyphs = std::move(kept);
  shaped->width += shift;
}

// Drops the glyphs and placeholders of the bytes from `from` on, leaving
// the others where they are.
void drop_from_keeping_places(Shaped* shaped, size_t from) {
  std::vector<Glyph> kept;
  for (const Glyph& glyph : shaped->glyphs) {
    if (glyph.cluster < from) {
      kept.push_back(glyph);
    }
  }
  shaped->glyphs = std::move(kept);
}

// Lays out a line of text[start, end), followed by whitespace that hangs up
// to `brk`, with the hyphen when it ends at a soft hyphen and `hyphenate`.
// Chrome shapes a start-aligned line with the whitespace after it, which
// keeps the kerning of its last letter against it, and any other line
// without it.
Line make_line(const BlinkParagraph& p,
               size_t start,
               size_t end,
               size_t brk,
               bool hard_break,
               bool hyphenate) {
  Line line;
  line.start = start;
  line.end = end;
  line.brk = brk;
  line.hard_break = hard_break;
  const bool start_aligned =
      p.align == (p.rtl ? TextAlign::kRight : TextAlign::kLeft);
  if (start_aligned && brk > end) {
    line.shaped = shape_range(p, start, brk);
    drop_from(p, &line.shaped, end);
  } else {
    line.shaped = shape_range(p, start, end);
  }
  if (hyphenate && ends_in_soft_hyphen(p, start, end)) {
    Shaped hyphen = p.hyphen_shape;
    for (Glyph& glyph : hyphen.glyphs) {
      glyph.cluster = previous_char(p, end);
    }
    if (p.rtl) {
      prepend(&line.shaped, hyphen);
    } else {
      append(&line.shaped, hyphen);
    }
  }
  return line;
}

// The start of the grapheme cluster byte `at` is in.
size_t grapheme_start(const BlinkParagraph& p, size_t start, size_t at) {
  while (at > start &&
         !has_flag(p, at, SkUnicode::CodeUnitFlags::kGraphemeStart)) {
    at = previous_char(p, at);
  }
  return at;
}

// The end of the grapheme cluster byte `at` is in.
size_t grapheme_end(const BlinkParagraph& p, size_t at, size_t end) {
  do {
    at = next_char(p, at);
  } while (at < end &&
           !has_flag(p, at, SkUnicode::CodeUnitFlags::kGraphemeStart));
  return std::min(at, end);
}

// Cuts `line` for the ellipsis after it as Chrome's LineTruncator does: in
// visual order, from the edge the line ends at, the glyphs and boxes that
// would overlap the ellipsis come off (by grapheme cluster), and the rest
// keep their places. In text of the paragraph's direction that drops the end
// of the text; in a run of the other direction at the line's end, it drops
// the start of that run. False when that leaves no more than the whitespace
// before the line's first grapheme cluster, which ends at `first`.
bool cut_visually(const BlinkParagraph& p,
                  Line* line,
                  size_t first,
                  float width) {
  Shaped& shaped = line->shaped;
  const float ellipsis = p.ellipsis_shape.width;
  const float total = shaped.width;
  // Each glyph and box: its grapheme cluster and its extent from the line's
  // start edge.
  struct Item {
    size_t grapheme;
    float from;
    float to;
  };
  std::vector<Item> items;
  const auto add = [&](size_t at, float left, float right) {
    const size_t grapheme = grapheme_start(p, line->start, at);
    if (p.rtl) {
      items.push_back({grapheme, total - right, total - left});
    } else {
      items.push_back({grapheme, left, right});
    }
  };
  for (const Glyph& glyph : shaped.glyphs) {
    add(glyph.cluster, glyph.pen, glyph.pen + glyph.advance);
  }
  for (auto [placeholder, x] : shaped.boxes) {
    add(p.placeholder_at[placeholder], x,
        x + p.placeholders[placeholder].width);
  }
  // The graphemes that come off: those of every item that overlaps the
  // ellipsis, and then of every item at or past one of those.
  std::vector<bool> dropped(line->end - line->start + 1, false);
  const auto off = [&](size_t grapheme) {
    return dropped[grapheme - line->start];
  };
  float cut = total;
  for (const Item& item : items) {
    if (!fits(item.to + ellipsis, width)) {
      cut = std::min(cut, item.from);
    }
  }
  for (bool changed = true; changed;) {
    changed = false;
    for (const Item& item : items) {
      if (item.to <= cut + 1e-3f && !off(item.grapheme)) {
        continue;
      }
      if (!off(item.grapheme)) {
        dropped[item.grapheme - line->start] = true;
        changed = true;
      }
      if (item.from < cut) {
        cut = item.from;
        changed = true;
      }
    }
  }
  const auto is_dropped = [&](size_t at) {
    return off(grapheme_start(p, line->start, at));
  };
  // What is left must hold more than the whitespace before the first
  // cluster.
  size_t end = line->start;
  float reach = 0;
  for (const Item& item : items) {
    if (!off(item.grapheme)) {
      end = std::max(end, grapheme_end(p, item.grapheme, line->end));
      reach = std::max(reach, item.to);
    }
  }
  if (end < first) {
    return false;
  }
  std::vector<Glyph> kept;
  for (const Glyph& glyph : shaped.glyphs) {
    if (!is_dropped(glyph.cluster)) {
      kept.push_back(glyph);
    }
  }
  std::vector<std::pair<size_t, float>> kept_boxes;
  for (auto box : shaped.boxes) {
    if (!is_dropped(p.placeholder_at[box.first])) {
      kept_boxes.push_back(box);
    }
  }
  // In RTL the start edge is the right one: what is left moves left by the
  // width that came off there.
  if (p.rtl) {
    const float shift = total - reach;
    for (Glyph& glyph : kept) {
      glyph.pen -= shift;
    }
    for (auto& box : kept_boxes) {
      box.second -= shift;
    }
  }
  shaped.glyphs = std::move(kept);
  shaped.boxes = std::move(kept_boxes);
  shaped.width = reach;
  line->end = end;
  return true;
}

// Truncates `line` to fit `width` with the ellipsis after it, as Chrome's
// line-clamp and text-overflow do: grapheme clusters come off the end of its
// text until the rest and the ellipsis fit, keeping at least the first.
// Whitespace that then ends it hangs before the ellipsis, unless it is kept.
void ellipsize(const BlinkParagraph& p,
               Line* line,
               float width,
               bool more_after) {
  const Shaped& ellipsis = p.ellipsis_shape;
  if (!more_after && fits(line->shaped.width, width)) {
    return;
  }
  const auto put_ellipsis = [&](Line* truncated) {
    Shaped tail = ellipsis;
    for (Glyph& glyph : tail.glyphs) {
      glyph.cluster = truncated->end;
    }
    if (p.rtl) {
      prepend(&truncated->shaped, tail);
    } else {
      append(&truncated->shaped, tail);
    }
  };
  // Kept whitespace stays before the ellipsis, at a soft wrap too.
  if (p.keep_trailing_whitespace && line->brk > line->end) {
    *line = make_line(p, line->start, line->brk, line->brk, line->hard_break,
                      false);
  }
  // The line as it is, its hyphen too, when the ellipsis fits after it.
  if (fits(line->shaped.width + ellipsis.width, width)) {
    put_ellipsis(line);
    return;
  }
  // The end of the first grapheme cluster, after any whitespace before it.
  size_t first = line->start;
  while (first < line->end && collapses(p.chars[first])) {
    first = next_char(p, first);
  }
  if (first < line->end) {
    first = next_char(p, first);
  }
  while (first < line->end &&
         !has_flag(p, first, SkUnicode::CodeUnitFlags::kGraphemeStart)) {
    first = next_char(p, first);
  }
  if (cut_visually(p, line, first, width)) {
    put_ellipsis(line);
    return;
  }
  // Not even the first cluster fits: it stays, the ellipsis after it, both
  // overflowing the line.
  drop_from(p, &line->shaped, first);
  line->end = first;
  put_ellipsis(line);
}

// Spreads `line` over `width` at Chrome's justification opportunities, as
// Blink's ApplyJustification does with ShapeResultSpacing's (see justify.cpp
// for the opportunities).
bool justify(const BlinkParagraph& p, Line* line, float width) {
  const float space = width - line->shaped.width;
  if (!(space > 0)) {
    return false;
  }
  // Each code point's expansion before and after it, in opportunities.
  struct Expansion {
    uint8_t before = 0;
    uint8_t after = 0;
  };
  std::vector<Expansion> expansions(line->end - line->start);
  int count = 0;
  bool after_opportunity = true;
  size_t last = SIZE_MAX;
  for (size_t i = line->start; i < line->end; i = next_char(p, i)) {
    const JustificationKind kind = is_placeholder(p, i)
                                       ? JustificationKind::kOther
                                       : justification_kind(p.chars[i]);
    if (kind == JustificationKind::kIgnorable) {
      continue;
    }
    Expansion& e = expansions[i - line->start];
    e.before = kind == JustificationKind::kCjk && !after_opportunity;
    e.after =
        kind == JustificationKind::kSpace || kind == JustificationKind::kCjk;
    after_opportunity = e.after;
    count += e.before + e.after;
    last = i;
  }
  if (last != SIZE_MAX && expansions[last - line->start].after) {
    expansions[last - line->start].after = 0;
    count--;
  }
  if (count == 0) {
    return false;
  }
  const float share = space / static_cast<float>(count);
  // Walks the glyphs on screen: each cluster widens by its code points'
  // expansions, before them on its left in LTR and on its right in RTL.
  Shaped& shaped = line->shaped;
  // How far the glyphs before each one on screen moved it.
  std::vector<float> moved_before(shaped.glyphs.size(), 0);
  float moved = 0;
  for (size_t i = 0; i < shaped.glyphs.size();) {
    const size_t cluster = shaped.glyphs[i].cluster;
    size_t j = i;
    while (j < shaped.glyphs.size() && shaped.glyphs[j].cluster == cluster) {
      j++;
    }
    // The cluster's code points: up to the next cluster in the text.
    size_t cluster_end = line->end;
    for (const Glyph& glyph : shaped.glyphs) {
      if (glyph.cluster > cluster && glyph.cluster < cluster_end) {
        cluster_end = glyph.cluster;
      }
    }
    int before = 0;
    int after = 0;
    for (size_t c = std::max(cluster, line->start); c < cluster_end; c++) {
      before += expansions[c - line->start].before;
      after += expansions[c - line->start].after;
    }
    // A cluster is RTL where the glyph after it on screen comes before it in
    // the text.
    bool rtl = p.rtl;
    if (j < shaped.glyphs.size()) {
      rtl = shaped.glyphs[j].cluster < cluster;
    } else if (i > 0) {
      rtl = shaped.glyphs[i - 1].cluster > cluster;
    }
    const float lead = share * static_cast<float>(rtl ? after : before);
    const float trail = share * static_cast<float>(rtl ? before : after);
    for (size_t k = i; k < j; k++) {
      moved_before[k] = moved;
      shaped.glyphs[k].pen += moved + lead;
    }
    shaped.glyphs[j - 1].advance += trail;
    moved += lead + trail;
    i = j;
  }
  // A placeholder moves with the glyphs before it on screen.
  for (auto& box : shaped.boxes) {
    float shift = moved;
    for (size_t i = 0; i < shaped.glyphs.size(); i++) {
      if (shaped.glyphs[i].pen - moved_before[i] >= box.second - 1e-3f) {
        shift = moved_before[i];
        break;
      }
    }
    box.second += shift;
  }
  shaped.width = width;
  return true;
}

// Cuts a justified `line` that max_lines clamps so that the ellipsis fits
// after what is left, as Chrome does: grapheme clusters come off the end of
// its text, in logical order, until the justified advance of the rest and
// the ellipsis fit the width, keeping at least the first. What is left
// keeps the places justifying gave it, the widened spaces that end it too.
void cut_justified(const BlinkParagraph& p, Line* line, float width) {
  const Shaped& ellipsis = p.ellipsis_shape;
  Shaped& shaped = line->shaped;
  // The extent on screen of the glyphs of the text before `end`.
  const auto extent = [&](size_t end, float* left, float* right) {
    *left = shaped.width;
    *right = 0;
    for (size_t i = 0; i < shaped.glyphs.size(); i++) {
      if (shaped.glyphs[i].cluster < end) {
        *left = std::min(*left, shaped.glyphs[i].pen);
        *right =
            std::max(*right, shaped.glyphs[i].pen + shaped.glyphs[i].advance);
      }
    }
    for (const auto& [placeholder, x] : shaped.boxes) {
      if (p.placeholder_at[placeholder] < end) {
        *left = std::min(*left, x);
        *right = std::max(*right, x + p.placeholders[placeholder].width);
      }
    }
    if (*left > *right) {
      *left = *right = p.rtl ? shaped.width : 0;
    }
  };
  size_t first = next_char(p, line->start);
  while (first < line->end &&
         !has_flag(p, first, SkUnicode::CodeUnitFlags::kGraphemeStart)) {
    first = next_char(p, first);
  }
  // The hyphen a line breaking at a soft hyphen ends with is its last
  // cluster.
  const SkUnicode::BidiLevel base = p.rtl ? 1 : 0;
  // Whether what is kept can end at `end`: not after a space of the other
  // direction than the paragraph's, which the ellipsis wouldn't follow on
  // screen.
  const auto can_end = [&](size_t end) {
    if (end <= first || end >= line->end) {
      return true;
    }
    const size_t before = previous_char(p, end);
    return !hangs(p.chars[before]) || (p.levels[before] & 1) == (base & 1);
  };
  size_t end = line->end;
  float left = 0;
  float right = 0;
  for (;;) {
    extent(end, &left, &right);
    if (end <= first ||
        (can_end(end) && fits(right - left + ellipsis.width, width))) {
      break;
    }
    do {
      end = previous_char(p, end);
    } while (end > first &&
             (!has_flag(p, end, SkUnicode::CodeUnitFlags::kGraphemeStart) ||
              !can_end(end)));
  }
  const size_t kept_end = end;
  drop_from_keeping_places(&shaped, kept_end);
  std::vector<std::pair<size_t, float>> boxes;
  for (const auto& box : shaped.boxes) {
    if (p.placeholder_at[box.first] < kept_end) {
      boxes.push_back(box);
    }
  }
  shaped.boxes = std::move(boxes);
  Shaped tail = ellipsis;
  for (Glyph& glyph : tail.glyphs) {
    glyph.cluster = kept_end;
  }
  // What is kept, from the start edge, the ellipsis after it.
  for (Glyph& glyph : shaped.glyphs) {
    glyph.pen -= left;
  }
  for (auto& box : shaped.boxes) {
    box.second -= left;
  }
  shaped.width = right - left;
  if (p.rtl) {
    prepend(&shaped, tail);
  } else {
    append(&shaped, tail);
  }
  line->end = kept_end;
}

// Shapes each hard line whole for the advances the lines are broken by, and
// measures the intrinsic widths.
void measure(BlinkParagraph* p) {
  p->measured = true;
  p->advance_sums.assign(p->text.size() + 1, 0);
  std::vector<float> advances(p->text.size(), 0);
  float max_content = 0;
  for (const HardLine& hard : p->hard_lines) {
    size_t start = hard.start;
    if (!p->keep_trailing_whitespace && !p->nowrap) {
      while (start < hard.end && collapses(p->chars[start])) {
        start = next_char(*p, start);
      }
    }
    const Shaped shaped = shape_pieces(*p, hard.start, hard.end);
    for (size_t i = 0; i < shaped.glyphs.size(); i++) {
      const size_t cluster = shaped.glyphs[i].cluster;
      if (!is_placeholder(*p, cluster)) {
        advances[cluster] += shaped.glyphs[i].advance;
      }
    }
    for (size_t at = hard.start; at < hard.end; at++) {
      if (is_placeholder(*p, at)) {
        advances[at] += p->placeholders[p->placeholder_of[at]].width;
      }
    }
    const size_t end = p->keep_trailing_whitespace
                           ? hard.end
                           : without_hanging(*p, start, hard.end);
    if (end > start) {
      max_content =
          std::max(max_content,
                   make_line(*p, start, end, end, true, false).shaped.width);
    }
  }
  double sum = 0;
  for (size_t i = 0; i < p->text.size(); i++) {
    p->advance_sums[i] = sum;
    sum += advances[i];
  }
  p->advance_sums[p->text.size()] = sum;
  if (!p->hyphen.empty()) {
    p->hyphen_shape = shape_string(*p, p->hyphen, 0, p->rtl, 0);
  }
  if (!p->ellipsis.empty()) {
    p->ellipsis_shape = shape_string(*p, p->ellipsis, 0, p->rtl, 0);
  }
  // CSS max-content and min-content, in LayoutUnits.
  p->max_content = static_cast<float>(std::ceil(max_content * 64.0) / 64);
  float min_content = 0;
  if (p->nowrap) {
    min_content = p->max_content;
  } else {
    for (const HardLine& hard : p->hard_lines) {
      for (size_t at = hard.start; at < hard.end;) {
        const size_t next = next_opportunity(*p, hard, at);
        min_content = std::max(
            min_content,
            estimate(*p, at, without_hanging(*p, at, next), next < hard.end));
        at = next;
      }
    }
    min_content = static_cast<float>(std::ceil(min_content * 64.0) / 64);
  }
  p->min_content = min_content;
}

// Breaks `hard` into lines of `width` and adds them to p->lines, up to
// `max_lines` in all (0 for no limit). Returns whether text was left out.
bool break_hard_line(BlinkParagraph* p,
                     const HardLine& hard,
                     float width,
                     size_t max_lines) {
  const auto full = [&] {
    return max_lines > 0 && p->lines.size() >= max_lines;
  };
  size_t start = hard.start;
  if (!p->keep_trailing_whitespace && !p->nowrap) {
    while (start < hard.end && collapses(p->chars[start])) {
      start = next_char(*p, start);
    }
  }
  if (start >= hard.end) {
    if (full()) {
      return true;
    }
    p->lines.push_back(make_line(*p, start, start, start, true, false));
    return false;
  }
  const auto content_end = [&](size_t from, size_t at) {
    return p->keep_trailing_whitespace && at == hard.end
               ? at
               : without_hanging(*p, from, at);
  };
  if (p->nowrap) {
    if (full()) {
      return true;
    }
    p->lines.push_back(make_line(*p, start, content_end(start, hard.end),
                                 hard.end, true, false));
    return false;
  }
  while (start < hard.end) {
    if (full()) {
      return true;
    }
    // The opportunities that fit by the advances of the whole shape.
    std::vector<size_t> fitting;
    for (size_t at = next_opportunity(*p, hard, start);;
         at = next_opportunity(*p, hard, at)) {
      if (!fits(estimate(*p, start, content_end(start, at), at < hard.end),
                width)) {
        break;
      }
      fitting.push_back(at);
      if (at >= hard.end) {
        break;
      }
    }
    size_t brk;
    size_t end;
    if (!fitting.empty()) {
      // Shaped on its own, a line can come out wider: it gives back words
      // until it fits, as long as it has one.
      Line line;
      for (;;) {
        brk = fitting.back();
        end = content_end(start, brk);
        line = make_line(*p, start, end, brk, brk >= hard.end, brk < hard.end);
        if (fits(line.shaped.width, width) || fitting.size() == 1) {
          break;
        }
        fitting.pop_back();
      }
      p->lines.push_back(std::move(line));
    } else {
      // The first word is wider than the line: it overflows the line, or
      // under overflow-wrap: break-word, is broken between grapheme clusters
      // where the line is full, keeping at least one.
      brk = next_opportunity(*p, hard, start);
      end = content_end(start, brk);
      if (p->overflow_wrap == OverflowWrap::kBreakWord) {
        size_t at = next_char(*p, start);
        while (at < end &&
               !has_flag(*p, at, SkUnicode::CodeUnitFlags::kGraphemeStart)) {
          at = next_char(*p, at);
        }
        // Never before a soft hyphen (UAX #14 LB21).
        const auto breakable = [&](size_t i) {
          return i >= end ||
                 (has_flag(*p, i, SkUnicode::CodeUnitFlags::kGraphemeStart) &&
                  p->chars[i] != 0xAD);
        };
        while (!breakable(at)) {
          at = next_char(*p, at);
        }
        size_t fitted = at;
        while (at < end) {
          at = next_char(*p, at);
          while (!breakable(at)) {
            at = next_char(*p, at);
          }
          if (!fits(estimate(*p, start, at, brk < hard.end), width)) {
            break;
          }
          fitted = at;
        }
        if (fitted < end) {
          brk = end = fitted;
        }
      }
      p->lines.push_back(
          make_line(*p, start, end, brk, brk >= hard.end, brk < hard.end));
    }
    start = brk;
  }
  return false;
}

// Where a placeholder's box goes on its line: CSS vertical-align.
float placeholder_top(const BlinkParagraph& p,
                      const effing_paragraph_placeholder& spec,
                      float top,
                      float baseline) {
  switch (spec.align) {
    case EFFING_PLACEHOLDER_MIDDLE:
      return baseline - p.x_height / 2 - spec.height / 2;
    case EFFING_PLACEHOLDER_TOP:
      return top;
    case EFFING_PLACEHOLDER_BOTTOM:
      return top + p.line_height - spec.height;
    case EFFING_PLACEHOLDER_TEXT_TOP:
      return baseline - p.content_ascent;
    case EFFING_PLACEHOLDER_TEXT_BOTTOM:
      return baseline + p.content_descent - spec.height;
    default:
      return baseline - spec.baseline_offset;
  }
}

// The length of a hard break at in[i], in bytes, or 0: LF, VT, FF, CRLF, LS
// and PS, as for SkParagraph. A CR and an LF with a placeholder between them
// are a lone CR and an LF.
size_t hard_break_at(const char* in,
                     size_t len,
                     size_t i,
                     bool placeholder_next) {
  const auto c = static_cast<unsigned char>(in[i]);
  if (c == '\r') {
    return !placeholder_next && i + 1 < len && in[i + 1] == '\n' ? 2 : 0;
  }
  if (c >= '\n' && c <= '\f') {
    return 1;
  }
  if (c == 0xE2 && i + 2 < len &&
      static_cast<unsigned char>(in[i + 1]) == 0x80 &&
      (static_cast<unsigned char>(in[i + 2]) == 0xA8 ||
       static_cast<unsigned char>(in[i + 2]) == 0xA9)) {
    return 3;
  }
  return 0;
}

}  // namespace

BlinkParagraph* blink_paragraph_create(
    const char* in,
    size_t in_len,
    skiac_font_collection* c_collection,
    const char* font_family,
    const effing_paragraph_style* s,
    const effing_paragraph_placeholder* placeholders,
    size_t placeholder_count) {
  c_collection->flushCachesIfDirty();
  auto* p = new BlinkParagraph();
  p->collection = c_collection;
  const std::vector<SkString> names = split_families(font_family);
  p->family_names.reserve(names.size());
  for (const SkString& name : names) {
    p->family_names.emplace_back(name.c_str(), name.size());
  }
  for (size_t i = 0; i < names.size(); i++) {
    p->families.push_back({p->family_names[i].data(), p->family_names[i].size(),
                           generic_of(names[i])});
  }
  p->font_size = s->font_size;
  p->weight = static_cast<float>(s->weight);
  p->slant = s->slant;
  p->letter_spacing = s->letter_spacing;
  p->rtl = static_cast<TextDirection>(s->direction) == TextDirection::kRtl;
  const auto align = static_cast<TextAlign>(s->align);
  p->align = align == TextAlign::kStart
                 ? (p->rtl ? TextAlign::kRight : TextAlign::kLeft)
             : align == TextAlign::kEnd
                 ? (p->rtl ? TextAlign::kLeft : TextAlign::kRight)
                 : align;
  p->nowrap = s->nowrap;
  p->max_lines = s->max_lines;
  if (s->ellipsis_len > 0 && (s->max_lines > 0 || s->nowrap)) {
    p->ellipsis.assign(s->ellipsis, s->ellipsis_len);
  }
  p->keep_trailing_whitespace = s->keep_trailing_whitespace;
  p->overflow_wrap = static_cast<OverflowWrap>(s->overflow_wrap);
  p->placeholders.assign(placeholders, placeholders + placeholder_count);

  // The text as it is shaped, and its hard lines.
  std::vector<size_t> emoji;
  size_t next = 0;
  size_t units = 0;
  size_t line_start = 0;
  const auto put = [&](const char* bytes, size_t n, char32_t c, size_t u16) {
    for (size_t k = 0; k < n; k++) {
      p->utf16.push_back(units);
      p->chars.push_back(k == 0 ? c : 0);
      p->placeholder_of.push_back(SIZE_MAX);
    }
    p->text.append(bytes, n);
    units += u16;
  };
  const auto put_placeholders = [&](size_t offset) {
    while (next < placeholder_count && placeholders[next].offset <= offset) {
      if (placeholders[next].line_break == EFFING_PLACEHOLDER_BREAK_EMOJI) {
        emoji.push_back(p->text.size());
      }
      const size_t at = p->text.size();
      put(kObjectReplacement, 3, 0xFFFC, 1);
      p->placeholder_of[at] = next;
      p->placeholder_at.push_back(at);
      next++;
    }
  };
  for (size_t i = 0; i < in_len;) {
    put_placeholders(i);
    const bool placeholder_next =
        next < placeholder_count && placeholders[next].offset == i + 1;
    if (const size_t brk = hard_break_at(in, in_len, i, placeholder_next)) {
      p->hard_lines.push_back({line_start, p->text.size()});
      for (size_t k = 0; k < brk; k++) {
        // The break itself is in no line.
        put(in + i + k, 1, k == 0 ? static_cast<unsigned char>(in[i]) : 0,
            k == 0 ? 1 : (brk == 2 ? 1 : 0));
      }
      line_start = p->text.size();
      i += brk;
      continue;
    }
    const char* at = in + i;
    SkUnichar c = SkUTF::NextUTF8(&at, in + in_len);
    size_t n = static_cast<size_t>(at - (in + i));
    if (c < 0) {
      c = 0xFFFD;
      n = 1;
      put("\xEF\xBF\xBD", 3, 0xFFFD, 1);
    } else if (c == '\r') {
      // A lone CR: chars has it as '\r', the text as U+2063.
      put(kInvisibleSeparator, 3, '\r', 1);
    } else {
      put(in + i, n, static_cast<char32_t>(c), c > 0xFFFF ? 2 : 1);
    }
    i += n;
  }
  put_placeholders(SIZE_MAX);
  p->utf16.push_back(units);
  p->ends_in_hard_break = !p->hard_lines.empty() &&
                          line_start == p->text.size() &&
                          p->hard_lines.back().end < p->text.size();
  if (!p->text.empty()) {
    p->hard_lines.push_back({line_start, p->text.size()});
  }

  // The line-break opportunities, with one on either side of each
  // placeholder that breaks as an inline-block does.
  if (!p->text.empty()) {
    auto unicode = make_word_break_unicode(
        static_cast<WordBreak>(s->word_break), false, emoji);
    std::string copy = p->text;
    skia_private::TArray<SkUnicode::CodeUnitFlags, true> flags;
    if (unicode &&
        unicode->computeCodeUnitFlags(
            copy.data(), static_cast<int>(copy.size()), false, &flags)) {
      p->flags.assign(flags.begin(), flags.end());
    }
    p->flags.resize(p->text.size() + 1, SkUnicode::kNoCodeUnitFlag);
    // The bidi levels, with each lone CR (U+2063 in the text) a paragraph
    // separator, as U+2029 is.
    std::string bidi_text = p->text;
    for (size_t at = 0; at < bidi_text.size(); at++) {
      if (p->chars[at] == '\r') {
        bidi_text.replace(at, 3, "\xE2\x80\xA9");
      }
    }
    std::vector<SkUnicode::BidiRegion> regions;
    p->levels.assign(p->text.size() + 1, p->rtl ? 1 : 0);
    if (unicode && unicode->getBidiRegions(
                       bidi_text.data(), static_cast<int>(bidi_text.size()),
                       p->rtl ? SkUnicode::TextDirection::kRTL
                              : SkUnicode::TextDirection::kLTR,
                       &regions)) {
      for (const SkUnicode::BidiRegion& region : regions) {
        for (size_t at = region.start; at < region.end && at < p->text.size();
             at++) {
          p->levels[at] = region.level;
        }
      }
    }
    p->unicode = unicode;
    for (size_t at = 0; at < p->text.size(); at++) {
      if (!is_placeholder(*p, at) ||
          p->placeholders[p->placeholder_of[at]].line_break ==
              EFFING_PLACEHOLDER_BREAK_EMOJI) {
        continue;
      }
      // After it, unless spaces follow it: the line breaks after those.
      for (const size_t edge : {at, at + 3}) {
        if (edge == at + 3 && edge < p->text.size() && hangs(p->chars[edge])) {
          continue;
        }
        p->flags[edge] = static_cast<SkUnicode::CodeUnitFlags>(
            p->flags[edge] | SkUnicode::kSoftLineBreakBefore);
      }
    }
  }

  // The line box, from the primary font, at the size Chrome lays it out at.
  const float font_size = effective_font_size(s->font_size);
  // The shaper's, which resolves the families as canvas text does.
  const sk_sp<SkTypeface> primary = effing_primary_face(
      c_collection, make_request(*p, std::string(), p->rtl, 0));
  if (!hhea_metrics(primary, font_size, &p->ascent, &p->descent,
                    &p->line_gap)) {
    SkFont font(primary, font_size);
    SkFontMetrics m;
    font.getMetrics(&m);
    p->ascent = -m.fAscent;
    p->descent = m.fDescent;
    p->line_gap = std::max(m.fLeading, 0.f);
  }
  p->content_ascent = round_metric(p->ascent);
  p->content_descent = round_metric(p->descent);
  p->line_height =
      s->line_height >= 0
          ? to_layout_units(s->line_height)
          : p->content_ascent + p->content_descent + round_metric(p->line_gap);
  p->x_height = placeholder_count > 0 ? x_height(primary, font_size) : 0;
  if (!p->nowrap && p->text.find("\xC2\xAD") != std::string::npos) {
    p->hyphen =
        primary && primary->unicharToGlyph(0x2010) != 0 ? "\xE2\x80\x90" : "-";
  }
  return p;
}

void blink_paragraph_layout(BlinkParagraph* p, float width) {
  const float w = std::isfinite(width) && width > 0
                      ? std::min(width, kUnbounded)
                      : kUnbounded;
  // nowrap text without an ellipsis is laid out unbounded, and aligned in
  // the width.
  const float break_width = p->nowrap && p->ellipsis.empty() ? kUnbounded : w;
  if (w == p->laid_out_width) {
    return;
  }
  p->laid_out_width = w;
  p->collection->flushCachesIfDirty();
  if (!p->measured) {
    measure(p);
  }
  p->lines.clear();
  p->exceeded_max_lines = false;
  const size_t max_lines =
      p->max_lines > 0 ? static_cast<size_t>(p->max_lines) : 0;
  // The empty line after a hard break that ends the text is not one of the
  // lines max_lines counts.
  const size_t counted = p->hard_lines.size() - (p->ends_in_hard_break ? 1 : 0);
  // Whether the last line is clamped with the ellipsis.
  bool clamped = false;
  for (size_t k = 0; k < p->hard_lines.size(); k++) {
    if (k >= counted && max_lines > 0 && p->lines.size() >= max_lines) {
      break;
    }
    bool dropped = break_hard_line(p, p->hard_lines[k], break_width, max_lines);
    if (!dropped && max_lines > 0 && p->lines.size() >= max_lines &&
        k + 1 < counted) {
      dropped = true;
    }
    if (dropped) {
      p->exceeded_max_lines = true;
      if (!p->ellipsis.empty() && !p->lines.empty()) {
        Line& last = p->lines.back();
        // Under justify, a clamped line that ends at a soft break is
        // justified as a line that isn't the last, then cut.
        if (p->align == TextAlign::kJustify && !p->nowrap && !last.hard_break &&
            w < kUnbounded && justify(*p, &last, w)) {
          cut_justified(*p, &last, w);
        } else {
          ellipsize(*p, &last, w, true);
        }
        // The clamped line ends the paragraph's lines, as a hard break
        // does.
        last.hard_break = true;
        clamped = true;
      }
      break;
    }
  }
  // nowrap lines with an ellipsis are each truncated to the width.
  if (p->nowrap && !p->ellipsis.empty()) {
    for (size_t i = 0; i < p->lines.size(); i++) {
      if (!(clamped && i + 1 == p->lines.size())) {
        ellipsize(*p, &p->lines[i], w, false);
      }
    }
  }

  const float baseline_in_box = baseline_in_line_box(
      p->line_height, p->content_ascent, p->content_descent);
  for (size_t i = 0; i < p->lines.size(); i++) {
    Line& line = p->lines[i];
    if (p->align == TextAlign::kJustify && !p->nowrap && !line.hard_break &&
        w < kUnbounded && !(clamped && i + 1 == p->lines.size())) {
      justify(*p, &line, w);
    }
    const float slack = w - line.shaped.width;
    float left = 0;
    if (w >= kUnbounded) {
    } else if (slack < 0) {
      left = p->rtl ? slack : 0;
    } else if (p->align == TextAlign::kRight) {
      left = slack;
    } else if (p->align == TextAlign::kCenter) {
      left = slack / 2;
    } else if (p->align == TextAlign::kJustify) {
      left = p->rtl ? slack : 0;
    }
    line.left = left;
    line.baseline = static_cast<float>(i) * p->line_height + baseline_in_box;
  }

  p->boxes.assign(p->placeholders.size(), {});
  for (size_t i = 0; i < p->lines.size(); i++) {
    const Line& line = p->lines[i];
    for (const auto& [placeholder, x] : line.shaped.boxes) {
      const effing_paragraph_placeholder& spec = p->placeholders[placeholder];
      effing_paragraph_placeholder_box& box = p->boxes[placeholder];
      box.visible = true;
      box.x = line.left + x;
      box.y = placeholder_top(*p, spec, static_cast<float>(i) * p->line_height,
                              line.baseline);
      box.width = spec.width;
      box.height = spec.height;
      box.line = static_cast<int>(i);
    }
  }
}

void blink_paragraph_get_metrics(const BlinkParagraph* p,
                                 effing_paragraph_metrics* m) {
  *m = {};
  m->line_count = static_cast<int>(p->lines.size());
  m->height = static_cast<float>(m->line_count) * p->line_height;
  for (const Line& line : p->lines) {
    m->longest_line = std::max(m->longest_line, line.shaped.width);
  }
  m->min_intrinsic_width = p->min_content;
  m->max_intrinsic_width = std::max(p->max_content, p->min_content);
  m->did_exceed_max_lines = p->exceeded_max_lines;
  m->line_height = p->line_height;
  m->ascent = p->ascent;
  m->descent = p->descent;
  m->line_gap = p->line_gap;
}

void blink_paragraph_get_lines(const BlinkParagraph* p,
                               effing_paragraph_line* out,
                               int count) {
  const int n = std::min(count, static_cast<int>(p->lines.size()));
  for (int i = 0; i < n; i++) {
    const Line& line = p->lines[static_cast<size_t>(i)];
    out[i].left = line.left;
    out[i].width = line.shaped.width;
    out[i].baseline = line.baseline;
    out[i].start_index = p->utf16[line.start];
    out[i].end_index = p->utf16[line.end];
    out[i].hard_break = line.hard_break;
  }
}

void blink_paragraph_get_placeholders(const BlinkParagraph* p,
                                      effing_paragraph_placeholder_box* out,
                                      int count) {
  const int n = std::min(count, static_cast<int>(p->boxes.size()));
  std::copy_n(p->boxes.begin(), std::max(n, 0), out);
}

void blink_paragraph_paint(const BlinkParagraph* p,
                           skiac_canvas* c_canvas,
                           skiac_paint* c_paint,
                           float x,
                           float y,
                           effing_painted* painted) {
  *painted = {};
  if (p->laid_out_width < 0) {
    return;
  }
  auto* canvas = reinterpret_cast<SkCanvas*>(c_canvas);
  const SkPaint& paint = *reinterpret_cast<SkPaint*>(c_paint);
  std::vector<SkGlyphID> ids;
  std::vector<SkPoint> positions;
  for (const Line& line : p->lines) {
    const Shaped& shaped = line.shaped;
    for (size_t i = 0; i < shaped.glyphs.size();) {
      const uint32_t font = shaped.glyphs[i].font;
      ids.clear();
      positions.clear();
      for (; i < shaped.glyphs.size() && shaped.glyphs[i].font == font; i++) {
        const Glyph& glyph = shaped.glyphs[i];
        ids.push_back(glyph.id);
        positions.push_back({glyph.pen + glyph.offset.fX, glyph.offset.fY});
      }
      paint_glyphs_unsnapped(canvas, shaped.fonts[font], ids.data(),
                             positions.data(), static_cast<int>(ids.size()),
                             x + line.left, y + line.baseline, paint);
    }
  }
  effing_take_text_painted(painted);
}

void blink_paragraph_destroy(BlinkParagraph* p) {
  delete p;
}

}  // namespace effing
