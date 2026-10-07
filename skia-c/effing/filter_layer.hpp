// Effing's filter layer sized to its content: the layer upstream's
// Context::composited_filter_layer draws `ctx.filter` and image-filter
// shadows through, sized to what the draw paints rather than to the canvas.
#ifndef EFFING_FILTER_LAYER_HPP
#define EFFING_FILTER_LAYER_HPP

#include "../skia_c.hpp"

extern "C" {
// Begins recording a filtered draw on `recorder`, in the space of the layer
// it is drawn through. The finished picture's cull rect is the union of what
// it draws, as SkRecordFillBounds computes it (with the paint's stroke, mask
// filter and path effect), or everything when it draws something Skia can't
// bound, such as drawPaint. Unlike a picture recorded with an R-tree, it
// plays back every op wherever it is played.
void effing_filter_layer_begin_content(skiac_picture_recorder* recorder);

// Draws `content`, recorded as above, through a layer composited with
// `paint`, sized to what `content` draws. Content that covers the canvas's
// clip gets an unbounded layer instead. `paint` must leave what is behind the
// layer alone where the layer is transparent, which effing_group_fits_content
// checks.
void effing_canvas_draw_filter_layer(skiac_canvas* canvas,
                                     skiac_paint* paint,
                                     skiac_picture* content);
}

#endif  // EFFING_FILTER_LAYER_HPP
