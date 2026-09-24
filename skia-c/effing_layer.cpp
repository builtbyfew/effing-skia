// Effing layer primitive: SkCanvas::saveLayer with the paint and backdrop
// options CSS compositing needs, which the Canvas 2D API has no way to ask for.
#include "effing_layer.hpp"

#include "include/core/SkCanvas.h"
#include "include/core/SkImageFilter.h"
#include "include/core/SkPaint.h"

extern "C" {

void effing_canvas_save_layer(skiac_canvas* c_canvas,
                              float opacity,
                              int blend_mode,
                              skiac_image_filter* filter,
                              skiac_image_filter* backdrop,
                              const float* bounds) {
  auto canvas = reinterpret_cast<SkCanvas*>(c_canvas);
  SkPaint paint;
  paint.setAlphaf(opacity);
  paint.setBlendMode(static_cast<SkBlendMode>(blend_mode));
  if (filter != nullptr) {
    paint.setImageFilter(
        sk_ref_sp(reinterpret_cast<SkImageFilter*>(filter)));
  }
  SkRect rect;
  if (bounds != nullptr) {
    rect = SkRect::MakeXYWH(bounds[0], bounds[1], bounds[2], bounds[3]);
  }
  // The backdrop is sampled past the layer's edge by clamping, the way a
  // browser extends it at the viewport edge.
  SkCanvas::SaveLayerRec rec(bounds != nullptr ? &rect : nullptr, &paint,
                             reinterpret_cast<SkImageFilter*>(backdrop),
                             SkTileMode::kClamp, nullptr, 0);
  canvas->saveLayer(rec);
}

}  // extern "C"
