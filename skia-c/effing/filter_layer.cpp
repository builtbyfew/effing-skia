#include "filter_layer.hpp"

#include "include/core/SkBBHFactory.h"
#include "include/core/SkCanvas.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPicture.h"
#include "include/core/SkPictureRecorder.h"
#include "include/core/SkRect.h"

#include <vector>

namespace {

// Everything a layer could hold: SkRectPriv::MakeLargeS32, the extent Skia
// gives an unbounded device.
SkRect everything() {
  return SkRect::Make(
      SkIRect::MakeLTRB(-(1 << 29), -(1 << 29), 1 << 29, 1 << 29));
}

// A bounding box hierarchy that finds every op. SkPictureRecorder makes the
// union of the ops' bounds the picture's cull rect whenever it has one, which
// is all a filter layer needs from it. An R-tree would also let
// SkPicture::playback skip the ops outside the canvas's clip, but the canvas
// is often a recording, whose clip need not be the one the layer is finally
// drawn under (composited_pass records at identity, for one), and a filter
// layer's content past the clip still feeds the filter. Playing back every op
// draws what the draw itself would have.
class AllOps final : public SkBBoxHierarchy {
 public:
  void insert(const SkRect[], int count) override { fCount = count; }

  void search(const SkRect&, std::vector<int>* results) const override {
    for (int i = 0; i < fCount; i++) {
      results->push_back(i);
    }
  }

  size_t bytesUsed() const override { return sizeof(*this); }

 private:
  int fCount = 0;
};

}  // namespace

extern "C" {

void effing_filter_layer_begin_content(skiac_picture_recorder* c_recorder) {
  reinterpret_cast<SkPictureRecorder*>(c_recorder)
      ->beginRecording(everything(), sk_make_sp<AllOps>());
}

void effing_canvas_draw_filter_layer(skiac_canvas* c_canvas,
                                     skiac_paint* c_paint,
                                     skiac_picture* c_content) {
  auto* canvas = reinterpret_cast<SkCanvas*>(c_canvas);
  auto* content = reinterpret_cast<SkPicture*>(c_content);
  // The bounds are the layer's content, before the filter: SkCanvas sizes
  // the layer to what the filter needs of it to fill the clip, past the
  // clip's edge by the filter's reach, as it does without bounds, and no
  // larger than the content. The filter's output still covers the clip.
  const SkRect bounds = content->cullRect();
  // Content that covers the clip, such as a background or a draw Skia can't
  // bound, would save next to nothing, and gets the unbounded layer: where a
  // layer starts moves the rounding of what is drawn into it, by a level
  // here and there, so a bounded one is not always the same to the bit.
  SkRect device;
  canvas->getTotalMatrix().mapRect(&device, bounds);
  const bool covers_clip =
      device.contains(SkRect::Make(canvas->getDeviceClipBounds()));
  canvas->saveLayer(covers_clip ? nullptr : &bounds,
                    reinterpret_cast<SkPaint*>(c_paint));
  content->playback(canvas);
  canvas->restore();
}

}  // extern "C"
