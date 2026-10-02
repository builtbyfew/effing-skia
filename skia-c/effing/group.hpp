// Effing's compositing group: SkCanvas::saveLayer with the backdrop and bounds
// options CSS compositing needs, which the Canvas 2D API has no way to ask for.
#ifndef EFFING_GROUP_HPP
#define EFFING_GROUP_HPP

#include "../skia_c.hpp"

extern "C" {
// Begins a group that is composited on restore with `paint`'s alpha, blend
// mode and image filter, or, with a null `paint`, a plain save: a group that
// composites nothing needs no layer, and a vector device may not have one. A
// `backdrop` filter initializes the group with the filtered content behind
// it. `bounds` (x, y, w, h in local space) is a size hint that also clips the
// group's content. All may be null. Owes one restore.
void effing_canvas_save_group(skiac_canvas* canvas,
                              skiac_paint* paint,
                              skiac_image_filter* backdrop,
                              const float* bounds);

// Whether a group composited with `paint` under `matrix` leaves everything
// outside what it draws alone, so that its layer can be sized to its content:
// true unless the blend mode changes the destination where the layer is
// transparent (clear, src, src-in, dst-in, src-out, dst-atop, modulate), or
// the image filter's output bounds can't be computed or `matrix` rotates or
// skews, where the filtered layer is resampled.
bool effing_group_fits_content(skiac_paint* paint, skiac_matrix* matrix);

// Clips `canvas` to `bounds` (x, y, w, h in local space).
void effing_canvas_clip_bounds(skiac_canvas* canvas, const float* bounds);

// The device-space region a group's content is recorded in, as x, y, w, h in
// `out`: the canvas within `clip`, the device-space bounds of the clip as
// left, top, right, bottom (null for none), or, when
// `paint` has an image filter, what that filter needs under `matrix` to fill
// it, as SkCanvas sizes a filtered layer. The clip itself is left to the
// layer the content is played into, which takes it from the canvas as an
// up-front layer would have.
void effing_group_content_bounds(skiac_paint* paint,
                                 skiac_matrix* matrix,
                                 const float* clip,
                                 float width,
                                 float height,
                                 float* out);

// Composites a group's `content`, recorded in device space, onto `canvas`
// with `paint`, through a layer the size of what `content` draws, opened
// under the group's `matrix`. Nothing is drawn when it draws nothing.
void effing_canvas_composite_group(skiac_canvas* canvas,
                                   skiac_picture* content,
                                   skiac_paint* paint,
                                   skiac_matrix* matrix);
}

#endif  // EFFING_GROUP_HPP
