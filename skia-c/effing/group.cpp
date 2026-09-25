#include "group.hpp"

#include "include/core/SkCanvas.h"
#include "include/core/SkImageFilter.h"
#include "include/core/SkPaint.h"
#include "include/core/SkRect.h"

extern "C" {

void effing_canvas_save_group(skiac_canvas* c_canvas,
                              skiac_paint* c_paint,
                              skiac_image_filter* c_backdrop,
                              const float* bounds) {
  SkRect rect;
  if (bounds != nullptr) {
    rect = SkRect::MakeXYWH(bounds[0], bounds[1], bounds[2], bounds[3]);
  }
  // The backdrop is sampled past the group's edge by clamping, the way a
  // browser extends it at the viewport edge.
  SkCanvas::SaveLayerRec rec(bounds != nullptr ? &rect : nullptr,
                             reinterpret_cast<SkPaint*>(c_paint),
                             reinterpret_cast<SkImageFilter*>(c_backdrop),
                             SkTileMode::kClamp, nullptr, 0);
  auto* canvas = reinterpret_cast<SkCanvas*>(c_canvas);
  canvas->saveLayer(rec);
  if (bounds != nullptr) {
    // Layer bounds are only a size hint to Skia; the clip is ours to apply.
    // It lives inside the layer, so the restore undoes it.
    canvas->clipRect(rect);
  }
}

}  // extern "C"
