#include "group.hpp"

#include "include/core/SkBlendMode.h"
#include "include/core/SkCanvas.h"
#include "include/core/SkImageFilter.h"
#include "include/core/SkMatrix.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPicture.h"
#include "include/core/SkRect.h"

#include <optional>

extern "C" {

void effing_canvas_save_group(skiac_canvas* c_canvas,
                              skiac_paint* c_paint,
                              skiac_image_filter* c_backdrop,
                              const float* bounds) {
  SkRect rect;
  if (bounds != nullptr) {
    rect = SkRect::MakeXYWH(bounds[0], bounds[1], bounds[2], bounds[3]);
  }
  auto* canvas = reinterpret_cast<SkCanvas*>(c_canvas);
  if (c_paint == nullptr) {
    canvas->save();
  } else {
    // The backdrop is sampled past the group's edge by clamping, the way a
    // browser extends it at the viewport edge.
    SkCanvas::SaveLayerRec rec(bounds != nullptr ? &rect : nullptr,
                               reinterpret_cast<SkPaint*>(c_paint),
                               reinterpret_cast<SkImageFilter*>(c_backdrop),
                               SkTileMode::kClamp, nullptr, 0);
    canvas->saveLayer(rec);
  }
  if (bounds != nullptr) {
    // Layer bounds are only a size hint to Skia; the clip is ours to apply.
    // It lives inside the layer, so the restore undoes it.
    canvas->clipRect(rect);
  }
}

bool effing_group_fits_content(skiac_paint* c_paint, skiac_matrix* c_matrix) {
  const auto* paint = reinterpret_cast<SkPaint*>(c_paint);
  const std::optional<SkBlendMode> mode = paint->asBlendMode();
  if (!mode) {
    return false;
  }
  switch (*mode) {
    // Where the layer is transparent these still change what is behind it:
    // they clear it or scale it by the layer's alpha.
    case SkBlendMode::kClear:
    case SkBlendMode::kSrc:
    case SkBlendMode::kSrcIn:
    case SkBlendMode::kDstIn:
    case SkBlendMode::kSrcOut:
    case SkBlendMode::kDstATop:
    case SkBlendMode::kModulate:
      return false;
    default:
      break;
  }
  const SkImageFilter* filter = paint->getImageFilter();
  // Under a rotation or skew SkCanvas filters a layer in a space of its own
  // and resamples the result, which then depends on where the layer starts.
  return filter == nullptr ||
         (filter->canComputeFastBounds() &&
          reinterpret_cast<SkMatrix*>(c_matrix)->isScaleTranslate());
}

void effing_canvas_clip_bounds(skiac_canvas* c_canvas, const float* bounds) {
  reinterpret_cast<SkCanvas*>(c_canvas)->clipRect(
      SkRect::MakeXYWH(bounds[0], bounds[1], bounds[2], bounds[3]));
}

void effing_group_content_bounds(skiac_paint* c_paint,
                                 skiac_matrix* c_matrix,
                                 const float* clip,
                                 float width,
                                 float height,
                                 float* out) {
  SkRect rect = SkRect::MakeWH(width, height);
  if (clip != nullptr &&
      !rect.intersect(SkRect::MakeLTRB(clip[0], clip[1], clip[2], clip[3]))) {
    rect.setEmpty();
  }
  // A filtered layer holds what the filter needs to fill the clip, past the
  // clip's edge, the way SkCanvas sizes one: a blur at the edge of the clip
  // or the canvas takes in what is drawn just outside it.
  const SkImageFilter* filter =
      reinterpret_cast<SkPaint*>(c_paint)->getImageFilter();
  if (filter != nullptr && !rect.isEmpty()) {
    rect = SkRect::Make(filter->filterBounds(
        rect.roundOut(), *reinterpret_cast<SkMatrix*>(c_matrix),
        SkImageFilter::kReverse_MapDirection));
  }
  out[0] = rect.x();
  out[1] = rect.y();
  out[2] = rect.width();
  out[3] = rect.height();
}

void effing_canvas_composite_group(skiac_canvas* c_canvas,
                                   skiac_picture* c_content,
                                   skiac_paint* c_paint,
                                   skiac_matrix* c_matrix) {
  auto* canvas = reinterpret_cast<SkCanvas*>(c_canvas);
  auto* content = reinterpret_cast<SkPicture*>(c_content);
  // The cull rect of a picture recorded with a bounding box hierarchy is the
  // union of what it draws, so the layer covers that and no more.
  const SkRect bounds = content->cullRect();
  const SkMatrix& matrix = *reinterpret_cast<SkMatrix*>(c_matrix);
  SkMatrix inverse;
  if (bounds.isEmpty() || !matrix.invert(&inverse)) {
    return;
  }
  // The layer opens under the group's transform, which its filter is
  // specified in, as an up-front saveLayer would have; the content was
  // recorded in device space.
  const SkRect local = inverse.mapRect(bounds);
  canvas->save();
  canvas->setMatrix(matrix);
  canvas->saveLayer(&local, reinterpret_cast<SkPaint*>(c_paint));
  canvas->resetMatrix();
  canvas->drawPicture(content);
  canvas->restore();
  canvas->restore();
}

}  // extern "C"
