// Effing's canvas blur: the Gaussian blur of `ctx.filter`'s `blur()` and
// `drop-shadow()` and of a drawn image's shadow, computed as Chrome's software
// canvas computes it.
#ifndef EFFING_BLUR_HPP
#define EFFING_BLUR_HPP

#include "../skia_c.hpp"

extern "C" {
// SkImageFilters::Blur(sigma_x, sigma_y, input) as Chrome's raster canvas
// blurs: Chromium builds Skia with SK_AVOID_SLOW_RASTER_PIPELINE_BLURS, which
// takes SkBlurEngine's 8888 blur to its three-box approximation at every
// sigma, where Skia's default is a true Gaussian kernel below sigma 2. The
// sigmas are in the space of the layer the filter runs in, so this is only
// right for a layer opened at the device identity.
skiac_image_filter* effing_image_filter_make_canvas_blur(
    float sigma_x,
    float sigma_y,
    skiac_image_filter* c_image_filter);

// SkImageFilters::DropShadow, or DropShadowOnly when `shadow_only`, with its
// blur as above.
skiac_image_filter* effing_image_filter_make_canvas_drop_shadow(
    float dx,
    float dy,
    float sigma_x,
    float sigma_y,
    uint32_t color,
    bool shadow_only,
    skiac_image_filter* c_image_filter);
}

#endif  // EFFING_BLUR_HPP
