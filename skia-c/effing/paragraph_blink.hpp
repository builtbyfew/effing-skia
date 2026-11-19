// Effing's paragraphs laid out with upstream's Blink-style shaper
// (skia-c/shaper.cpp), the one fillText, strokeText and measureText use,
// instead of SkParagraph. The paragraph API is the same (paragraph.hpp); a
// paragraph takes this engine when its style asks for it
// (effing_paragraph_style::engine). See docs/effing.md.
#ifndef EFFING_PARAGRAPH_BLINK_HPP
#define EFFING_PARAGRAPH_BLINK_HPP

#include <cstddef>

#include "paragraph.hpp"

namespace effing {

struct BlinkParagraph;

// As effing_paragraph_create and the calls after it.
BlinkParagraph* blink_paragraph_create(
    const char* text,
    size_t text_len,
    skiac_font_collection* collection,
    const char* font_family,
    const effing_paragraph_style* style,
    const effing_paragraph_placeholder* placeholders,
    size_t placeholder_count);
void blink_paragraph_layout(BlinkParagraph* p, float width);
void blink_paragraph_get_metrics(const BlinkParagraph* p,
                                 effing_paragraph_metrics* metrics);
void blink_paragraph_get_lines(const BlinkParagraph* p,
                               effing_paragraph_line* lines,
                               int count);
void blink_paragraph_get_placeholders(const BlinkParagraph* p,
                                      effing_paragraph_placeholder_box* boxes,
                                      int count);
void blink_paragraph_paint(const BlinkParagraph* p,
                           skiac_canvas* canvas,
                           skiac_paint* paint,
                           float x,
                           float y,
                           effing_painted* painted);
void blink_paragraph_destroy(BlinkParagraph* p);

}  // namespace effing

#endif  // EFFING_PARAGRAPH_BLINK_HPP
