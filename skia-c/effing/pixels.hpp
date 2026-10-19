// Effing's direct access to an image's pixels, for encoders written in Rust
// (QOI) that read them row by row rather than from a full readPixels copy.
#ifndef EFFING_PIXELS_HPP
#define EFFING_PIXELS_HPP

#include "../skia_c.hpp"

extern "C" {
// Points `pixels` and `row_bytes` at `image`'s pixels, without a copy, when
// it is a raster image stored as premultiplied RGBA 8888 (a raster canvas
// snapshot is), and returns whether it did. The pixels live as long as the
// image and don't change: a later draw on the canvas copies the surface's
// pixels before it writes.
bool effing_image_peek_premul_rgba(skiac_image* image,
                                   const uint8_t** pixels,
                                   size_t* row_bytes);
}

#endif  // EFFING_PIXELS_HPP
