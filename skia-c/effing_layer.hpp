#ifndef EFFING_LAYER_HPP
#define EFFING_LAYER_HPP

#include "skia_c.hpp"

extern "C" {
// Begins a layer that is composited on restore with `opacity`, `blend_mode`
// (an SkBlendMode) and `filter`. A `backdrop` filter initializes the layer
// with the filtered content behind it. `bounds` (x, y, w, h in local space)
// is an optional hint that also clips the layer's content. Filters and
// bounds may be null.
void effing_canvas_save_layer(skiac_canvas* canvas,
                              float opacity,
                              int blend_mode,
                              skiac_image_filter* filter,
                              skiac_image_filter* backdrop,
                              const float* bounds);
}

#endif  // EFFING_LAYER_HPP
