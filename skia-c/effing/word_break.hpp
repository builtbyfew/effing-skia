// CSS word breaking for effing's paragraphs: the line-break opportunities
// SkParagraph is offered for `word-break: break-all` and `keep-all`, and
// within a word that `overflow-wrap: break-word` breaks. Where such a word
// goes is up to the paragraph's layout, in paragraph.cpp.
#ifndef EFFING_WORD_BREAK_HPP
#define EFFING_WORD_BREAK_HPP

#include <string>

#include "include/core/SkRefCnt.h"
#include "modules/skunicode/include/SkUnicode.h"

namespace effing {

// Where lines may break between letters: CSS word-break. Mirrors
// `effing_paragraph_style::word_break`.
enum class WordBreak : int {
  // ICU's opportunities: between words.
  kNormal = 0,
  // Between any two letters too.
  kBreakAll = 1,
  // Never between two letters where one is CJK.
  kKeepAll = 2,
};

// What happens to a word wider than the line: CSS overflow-wrap. Mirrors
// `effing_paragraph_style::overflow_wrap`. paragraph.cpp handles it.
enum class OverflowWrap : int {
  // It sits on a line of its own and overflows it.
  kNormal = 0,
  // It starts a line of its own and is broken where that line is full.
  kBreakWord = 1,
};

// The SkUnicode a paragraph breaks its lines with under `mode`: ICU's, with
// the opportunities adjusted for kBreakAll and kKeepAll. With
// `break_first_word`, a line may also break between any two grapheme
// clusters of the text's first word, which is how an overflow-wrap:
// break-word word is broken.
sk_sp<SkUnicode> make_word_break_unicode(WordBreak mode, bool break_first_word);

// A font family name for a paragraph's strut, which nothing resolves, that
// keeps SkParagraph's cache apart for each set of opportunities, or empty
// for ICU's own. The cache keeps the opportunities along with the shaped text
// but keys them on the text and style alone, the strut's font families
// included, so the same text broken two ways would share an entry.
std::string word_break_cache_tag(WordBreak mode, bool break_first_word);

}  // namespace effing

#endif  // EFFING_WORD_BREAK_HPP
