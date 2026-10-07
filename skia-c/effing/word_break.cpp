// SkParagraph takes its line-break opportunities from the SkUnicode it is
// built with, so break-all, keep-all, a word that break-word breaks and the
// text around placeholders wrap ICU's in one that moves them before
// SkParagraph sees them. A piece of a paragraph can also be handed the bidi
// levels its text has in the whole paragraph. Nothing else changes: shaping
// and grapheme clusters are ICU's.
#include "word_break.hpp"

#include <algorithm>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "modules/skunicode/include/SkUnicode_icu.h"

namespace effing {

namespace {

using Flags = SkUnicode::CodeUnitFlags;

// The code point at `text[*i]`, moving `*i` past it; U+FFFD for a byte that
// doesn't start one. SkParagraph's text is valid UTF-8.
SkUnichar next_code_point(const char* text, size_t len, size_t* i) {
  const auto byte = [&](size_t k) {
    return *i + k < len ? static_cast<unsigned char>(text[*i + k]) : 0;
  };
  const unsigned char c = byte(0);
  size_t n = c < 0x80 ? 1 : c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 0;
  if (n == 0 || *i + n > len) {
    *i += 1;
    return 0xFFFD;
  }
  SkUnichar code = n == 1 ? c : c & (0x7F >> n);
  for (size_t k = 1; k < n; k++) {
    code = (code << 6) | (byte(k) & 0x3F);
  }
  *i += n;
  return code;
}

std::string to_utf8(SkUnichar c) {
  std::string out;
  if (c < 0x80) {
    out += static_cast<char>(c);
  } else if (c < 0x800) {
    out += static_cast<char>(0xC0 | (c >> 6));
    out += static_cast<char>(0x80 | (c & 0x3F));
  } else if (c < 0x10000) {
    out += static_cast<char>(0xE0 | (c >> 12));
    out += static_cast<char>(0x80 | ((c >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (c & 0x3F));
  } else {
    out += static_cast<char>(0xF0 | (c >> 18));
    out += static_cast<char>(0x80 | ((c >> 12) & 0x3F));
    out += static_cast<char>(0x80 | ((c >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (c & 0x3F));
  }
  return out;
}

// How a character takes part in CSS word-break: break-all and keep-all.
enum class Letter : uint8_t {
  // Not a letter: spaces, punctuation, symbols, combining marks, emoji.
  kNone,
  // A letter or digit that ICU keeps together with its neighbours (Latin,
  // Thai and the like): line breaking classes AL, NU and SA.
  kWord,
  // A letter ICU breaks around anyway: CJK ideographs, kana, Hangul
  // (classes ID, H2, H3, JL, JV and JT).
  kCjk,
};

// Whether ICU's line breaker allows a break at `at` in `text`.
bool icu_breaks(SkBreakIterator* lines, const std::string& text, int at) {
  if (!lines->setText(text.data(), static_cast<int>(text.size()))) {
    return false;
  }
  for (auto pos = lines->first(); !lines->isDone(); pos = lines->next()) {
    if (pos == at) {
      return true;
    }
    if (pos > at) {
      break;
    }
  }
  return false;
}

// Classifies `c` by how ICU breaks lines around it, since SkUnicode doesn't
// expose line breaking classes: a letter allows breaks on either side of an
// ideograph (unlike opening and closing punctuation, quotes, hyphens, marks
// and spaces) and none before a percent sign (unlike em dashes, which are
// B2); a CJK letter allows breaks next to a Latin letter too.
Letter classify(SkBreakIterator* lines, SkUnichar c) {
  const std::string ch = to_utf8(c);
  const int len = static_cast<int>(ch.size());
  const std::string ideograph = "\xE4\xB8\x80";  // U+4E00
  if (!icu_breaks(lines, ideograph + ch, 3) ||
      !icu_breaks(lines, ch + ideograph, len) ||
      icu_breaks(lines, ch + "%", len)) {
    return Letter::kNone;
  }
  if (icu_breaks(lines, "a" + ch, 1) && icu_breaks(lines, ch + "a", len)) {
    return Letter::kCjk;
  }
  return Letter::kWord;
}

class WordBreakUnicode final : public SkUnicode {
 public:
  WordBreakUnicode(sk_sp<SkUnicode> icu,
                   WordBreak mode,
                   bool break_first_word,
                   std::vector<size_t> ideographs,
                   std::vector<BidiRegion> bidi)
      : fIcu(std::move(icu)),
        fMode(mode),
        fBreakFirstWord(break_first_word),
        fIdeographs(std::move(ideographs)),
        fBidi(std::move(bidi)) {
    std::sort(fIdeographs.begin(), fIdeographs.end());
  }

  SkString toUpper(const SkString& s) override { return fIcu->toUpper(s); }
  SkString toUpper(const SkString& s, const char* locale) override {
    return fIcu->toUpper(s, locale);
  }
  bool isControl(SkUnichar c) override { return fIcu->isControl(c); }
  bool isWhitespace(SkUnichar c) override { return fIcu->isWhitespace(c); }
  bool isSpace(SkUnichar c) override { return fIcu->isSpace(c); }
  bool isTabulation(SkUnichar c) override { return fIcu->isTabulation(c); }
  bool isHardBreak(SkUnichar c) override { return fIcu->isHardBreak(c); }
  bool isEmoji(SkUnichar c) override { return fIcu->isEmoji(c); }
  bool isEmojiComponent(SkUnichar c) override {
    return fIcu->isEmojiComponent(c);
  }
  bool isEmojiModifierBase(SkUnichar c) override {
    return fIcu->isEmojiModifierBase(c);
  }
  bool isEmojiModifier(SkUnichar c) override {
    return fIcu->isEmojiModifier(c);
  }
  bool isRegionalIndicator(SkUnichar c) override {
    return fIcu->isRegionalIndicator(c);
  }
  bool isIdeographic(SkUnichar c) override { return fIcu->isIdeographic(c); }

  std::unique_ptr<SkBidiIterator> makeBidiIterator(
      const uint16_t text[],
      int count,
      SkBidiIterator::Direction direction) override {
    return fIcu->makeBidiIterator(text, count, direction);
  }
  std::unique_ptr<SkBidiIterator> makeBidiIterator(
      const char text[],
      int count,
      SkBidiIterator::Direction direction) override {
    return fIcu->makeBidiIterator(text, count, direction);
  }
  std::unique_ptr<SkBreakIterator> makeBreakIterator(const char locale[],
                                                     BreakType type) override {
    return fIcu->makeBreakIterator(locale, type);
  }
  std::unique_ptr<SkBreakIterator> makeBreakIterator(BreakType type) override {
    return fIcu->makeBreakIterator(type);
  }

  // The levels the text has in context, when it was given them for text of
  // its length.
  bool getBidiRegions(const char utf8[],
                      int utf8Units,
                      TextDirection dir,
                      std::vector<BidiRegion>* results) override {
    if (!fBidi.empty() &&
        fBidi.back().end == static_cast<Position>(utf8Units)) {
      results->insert(results->end(), fBidi.begin(), fBidi.end());
      return true;
    }
    return fIcu->getBidiRegions(utf8, utf8Units, dir, results);
  }
  bool getWords(const char utf8[],
                int utf8Units,
                const char* locale,
                std::vector<Position>* results) override {
    return fIcu->getWords(utf8, utf8Units, locale, results);
  }
  bool getUtf8Words(const char utf8[],
                    int utf8Units,
                    const char* locale,
                    std::vector<Position>* results) override {
    return fIcu->getUtf8Words(utf8, utf8Units, locale, results);
  }
  bool getSentences(const char utf8[],
                    int utf8Units,
                    const char* locale,
                    std::vector<Position>* results) override {
    return fIcu->getSentences(utf8, utf8Units, locale, results);
  }

  // SkParagraph asks for the UTF-8 flags; those are adjusted.
  bool computeCodeUnitFlags(
      char utf8[],
      int utf8Units,
      bool replaceTabs,
      skia_private::TArray<Flags, true>* results) override {
    if (!fIcu->computeCodeUnitFlags(utf8, utf8Units, replaceTabs, results)) {
      return false;
    }
    this->adjust(utf8, utf8Units, results);
    return true;
  }
  // Unused by SkParagraph, which keeps its text as UTF-8: ICU's as they are.
  bool computeCodeUnitFlags(
      char16_t utf16[],
      int utf16Units,
      bool replaceTabs,
      skia_private::TArray<Flags, true>* results) override {
    return fIcu->computeCodeUnitFlags(utf16, utf16Units, replaceTabs, results);
  }

  void reorderVisual(const BidiLevel runLevels[],
                     int levelsCount,
                     int32_t logicalFromVisual[]) override {
    fIcu->reorderVisual(runLevels, levelsCount, logicalFromVisual);
  }

 private:
  // The first code point of a grapheme.
  struct Grapheme {
    size_t start;
    size_t length;  // of the code point, in bytes
    SkUnichar c;
  };

  // break-all treats letters and digits as ideographs (CSS Text 3): ICU
  // breaks the text with each letter replaced by one, so that a break is
  // allowed between any two letters, and around punctuation as it is around
  // an ideograph. keep-all suppresses the breaks ICU allows between two
  // letters when one of them is CJK; between Thai letters, the breaks ICU
  // finds with its dictionary stay.
  void adjust(const char* utf8,
              int utf8Units,
              skia_private::TArray<Flags, true>* results) {
    const auto len = static_cast<size_t>(utf8Units);
    std::vector<Grapheme> graphemes;
    for (size_t i = 0; i < len;) {
      const size_t start = i;
      const SkUnichar c = next_code_point(utf8, len, &i);
      if (graphemes.empty() || ((*results)[start] & kGraphemeStart)) {
        graphemes.push_back({start, i - start, c});
      }
    }
    if (!fIdeographs.empty() && fMode != WordBreak::kBreakAll) {
      this->placeholders_as_ideographs(utf8, len, results);
    }
    if (fMode != WordBreak::kNormal) {
      const auto letters = this->letters(graphemes);
      if (fMode == WordBreak::kBreakAll) {
        this->break_all(utf8, len, graphemes, letters, results);
      } else {
        keep_all(graphemes, letters, results);
      }
    }
    if (fBreakFirstWord) {
      break_first_word(graphemes, results);
    }
  }

  // Whether the U+FFFC at `at` is a placeholder that breaks lines as an
  // emoji.
  bool ideograph_at(size_t at) const {
    return std::binary_search(fIdeographs.begin(), fIdeographs.end(), at);
  }

  // A placeholder of fIdeographs (U+FFFC in SkParagraph's text) breaks lines
  // as an emoji does, UAX #14 class ID, where ICU takes U+FFFC for class CB,
  // which breaks before a hyphen, a percent sign or an ellipsis after it and
  // after a currency or plus sign before it. effing lays emoji out as
  // placeholders. ICU breaks the text with each such U+FFFC replaced by an
  // ideograph, which is as long in UTF-8.
  void placeholders_as_ideographs(const char* utf8,
                                  size_t len,
                                  skia_private::TArray<Flags, true>* results) {
    std::string text(utf8, len);
    bool any = false;
    for (const size_t at : fIdeographs) {
      if (at + 3 <= len && text.compare(at, 3, kObjectReplacement) == 0) {
        text.replace(at, 3, kIdeograph);
        any = true;
      }
    }
    if (any) {
      this->rebreak(text, [](size_t at) { return at; }, results);
    }
  }

  // Replaces the soft line breaks in `results` by ICU's in `text`, with
  // each offset in it at `to_utf8(offset)` in SkParagraph's text, or none
  // for an offset with no counterpart there (SIZE_MAX).
  template <typename ToUtf8>
  void rebreak(const std::string& text,
               ToUtf8 to_utf8,
               skia_private::TArray<Flags, true>* results) {
    auto lines = fIcu->makeBreakIterator(BreakType::kLines);
    if (!lines || !lines->setText(text.data(), static_cast<int>(text.size()))) {
      return;
    }
    std::vector<bool> soft(results->size());
    for (int i = 0; i < results->size(); i++) {
      auto& flags = (*results)[i];
      soft[i] = flags & kSoftLineBreakBefore;
      flags = static_cast<Flags>(flags & ~kSoftLineBreakBefore);
    }
    for (auto pos = lines->first(); !lines->isDone(); pos = lines->next()) {
      const size_t at = pos > 0 ? to_utf8(static_cast<size_t>(pos)) : SIZE_MAX;
      if (at == SIZE_MAX) {
        continue;
      }
      // ICU's own flags take some breaks of the hard kind for soft ones (a
      // lone CR's), which stay as they were.
      auto& flags = (*results)[at];
      if (lines->status() < static_cast<int>(LineBreakType::kHardLineBreak) ||
          soft[at]) {
        flags = static_cast<Flags>(flags | kSoftLineBreakBefore);
      }
    }
  }

  static void keep_all(const std::vector<Grapheme>& graphemes,
                       const std::vector<Letter>& letters,
                       skia_private::TArray<Flags, true>* results) {
    for (size_t g = 1; g < graphemes.size(); g++) {
      const Letter before = letters[g - 1];
      const Letter after = letters[g];
      if (before != Letter::kNone && after != Letter::kNone &&
          (before == Letter::kCjk || after == Letter::kCjk)) {
        auto& flags = (*results)[graphemes[g].start];
        flags = static_cast<Flags>(flags & ~kSoftLineBreakBefore);
      }
    }
  }

  // Lets a line break between any two grapheme clusters of the text's first
  // word, up to its first opportunity, but not before the spaces after it,
  // which hang, nor before a soft hyphen, which a line breaks after (UAX #14
  // LB21), as Chrome has it.
  void break_first_word(const std::vector<Grapheme>& graphemes,
                        skia_private::TArray<Flags, true>* results) {
    for (size_t g = 1; g < graphemes.size(); g++) {
      auto& flags = (*results)[graphemes[g].start];
      if (flags & (kSoftLineBreakBefore | kHardLineBreakBefore) ||
          fIcu->isWhitespace(graphemes[g].c)) {
        return;
      }
      if (graphemes[g].c == 0x00AD) {
        continue;
      }
      flags = static_cast<Flags>(flags | kSoftLineBreakBefore);
    }
  }

  void break_all(const char* utf8,
                 size_t len,
                 const std::vector<Grapheme>& graphemes,
                 const std::vector<Letter>& letters,
                 skia_private::TArray<Flags, true>* results) {
    // The text with every letter (and placeholder) an ideograph, and the
    // offset in `utf8` of each grapheme's offset in it.
    std::string text;
    text.reserve(len + len / 2);
    std::unordered_map<size_t, size_t> offsets;
    for (size_t g = 0; g < graphemes.size(); g++) {
      const size_t start = graphemes[g].start;
      const size_t end =
          g + 1 < graphemes.size() ? graphemes[g + 1].start : len;
      offsets[text.size()] = start;
      // Chrome also breaks before a hyphen-minus or a vertical line and
      // after a plus sign; taking them for letters comes closest. Not before
      // a hyphen-minus after an emoji, though.
      const SkUnichar c = graphemes[g].c;
      const bool placeholder = c == 0xFFFC && this->ideograph_at(start);
      const bool after_placeholder = g > 0 && graphemes[g - 1].c == 0xFFFC &&
                                     this->ideograph_at(graphemes[g - 1].start);
      if (letters[g] == Letter::kNone && !placeholder &&
          (c != '-' || after_placeholder) && c != '|' && c != '+') {
        text.append(utf8 + start, end - start);
      } else {
        text.append(kIdeograph);
        const size_t rest = start + graphemes[g].length;
        text.append(utf8 + rest, end - rest);
      }
    }
    offsets[text.size()] = len;
    this->rebreak(
        text,
        [&](size_t at) {
          const auto found = offsets.find(at);
          return found == offsets.end() ? SIZE_MAX : found->second;
        },
        results);
  }

  // Classifies each grapheme's first code point, through a cache shared by
  // every paragraph: probing ICU takes a few breaker runs per character.
  std::vector<Letter> letters(const std::vector<Grapheme>& graphemes) {
    static std::mutex mutex;
    static std::unordered_map<SkUnichar, Letter> cache;
    std::vector<Letter> out;
    out.reserve(graphemes.size());
    std::unique_ptr<SkBreakIterator> lines;
    std::lock_guard<std::mutex> lock(mutex);
    for (const Grapheme& grapheme : graphemes) {
      const SkUnichar c = grapheme.c;
      // Emoji are symbols, not letters, whatever their line breaking class.
      if (fIcu->isWhitespace(c) || fIcu->isControl(c) ||
          (c >= 0x80 && fIcu->isEmoji(c)) || fIcu->isRegionalIndicator(c)) {
        out.push_back(Letter::kNone);
        continue;
      }
      auto found = cache.find(c);
      if (found == cache.end()) {
        if (!lines) {
          lines = fIcu->makeBreakIterator(BreakType::kLines);
        }
        const Letter letter = lines ? classify(lines.get(), c) : Letter::kNone;
        found = cache.emplace(c, letter).first;
      }
      out.push_back(found->second);
    }
    return out;
  }

  static constexpr const char* kIdeograph = "\xE4\xB8\x80";  // U+4E00
  static constexpr const char* kObjectReplacement = "\xEF\xBF\xBC";

  sk_sp<SkUnicode> fIcu;
  WordBreak fMode;
  bool fBreakFirstWord;
  // The UTF-8 offsets of the placeholders that break lines as emoji, sorted.
  std::vector<size_t> fIdeographs;
  // The text's bidi levels in context, or empty for ICU's own.
  std::vector<BidiRegion> fBidi;
};

}  // namespace

sk_sp<SkUnicode> make_word_break_unicode(
    WordBreak mode,
    bool break_first_word,
    std::vector<size_t> ideographs,
    std::vector<SkUnicode::BidiRegion> bidi) {
  auto icu = SkUnicodes::ICU::Make();
  if (!icu || (mode == WordBreak::kNormal && !break_first_word &&
               ideographs.empty() && bidi.empty())) {
    return icu;
  }
  return sk_make_sp<WordBreakUnicode>(std::move(icu), mode, break_first_word,
                                      std::move(ideographs), std::move(bidi));
}

std::string bidi_cache_tag(const std::vector<SkUnicode::BidiRegion>& bidi) {
  if (bidi.empty()) {
    return std::string();
  }
  std::string tag = "effing-bidi:";
  for (const auto& region : bidi) {
    tag += " " + std::to_string(region.start) + "-" +
           std::to_string(region.end) + ":" + std::to_string(region.level);
  }
  return tag;
}

std::string word_break_cache_tag(WordBreak mode, bool break_first_word) {
  std::string tag;
  if (mode == WordBreak::kBreakAll) {
    tag = "break-all";
  } else if (mode == WordBreak::kKeepAll) {
    tag = "keep-all";
  }
  if (break_first_word) {
    tag += tag.empty() ? "first-word" : ", first-word";
  }
  return tag.empty() ? tag : "effing-word-break: " + tag;
}

}  // namespace effing
