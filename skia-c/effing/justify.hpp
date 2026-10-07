// Effing's justification: the lines of a paragraph under `textAlign:
// 'justify'` spread over the width as Chrome spreads them under CSS
// `text-align: justify` (and `text-justify: auto`), where SkParagraph would
// spread them its own way. See docs/effing.md.
#ifndef EFFING_JUSTIFY_HPP
#define EFFING_JUSTIFY_HPP

#include "modules/skparagraph/include/Paragraph.h"

namespace effing {

// Justifies the lines of `paragraph`, laid out start-aligned (TextAlign::kLeft)
// at `width`, that SkParagraph would justify: those narrower than the width
// that end at a soft break, without an ellipsis, before the paragraph's
// last. A line is spread at Chrome's justification opportunities, each
// given an equal share of the space it lacks, and is left start-aligned
// when it has none. The line's state is left as SkParagraph's
// TextLine::justify leaves it: the clusters moved by the run's
// justification shifts (which ParagraphImpl::resetShifts clears), and the
// line as wide as the width.
void justify_lines(skia::textlayout::Paragraph* paragraph, float width);

}  // namespace effing

#endif  // EFFING_JUSTIFY_HPP
