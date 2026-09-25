// Effing's compositing group: SkCanvas::saveLayer with the backdrop and bounds
// options CSS compositing needs, which the Canvas 2D API has no way to ask for.
#ifndef EFFING_GROUP_HPP
#define EFFING_GROUP_HPP

#include "../skia_c.hpp"

extern "C" {
// Begins a group that is composited on restore with `paint`'s alpha, blend
// mode and image filter. A `backdrop` filter initializes the group with the
// filtered content behind it. `bounds` (x, y, w, h in local space) is a size
// hint that also clips the group's content. Both may be null. Owes one
// restore.
void effing_canvas_save_group(skiac_canvas* canvas,
                              skiac_paint* paint,
                              skiac_image_filter* backdrop,
                              const float* bounds);
}

#endif  // EFFING_GROUP_HPP
