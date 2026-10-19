#include "pixels.hpp"

#include "include/core/SkImage.h"
#include "include/core/SkPixmap.h"

extern "C" {

bool effing_image_peek_premul_rgba(skiac_image* c_image,
                                   const uint8_t** pixels,
                                   size_t* row_bytes) {
  SkPixmap pixmap;
  if (!reinterpret_cast<SkImage*>(c_image)->peekPixels(&pixmap) ||
      pixmap.colorType() != kRGBA_8888_SkColorType ||
      pixmap.alphaType() != kPremul_SkAlphaType) {
    return false;
  }
  *pixels = static_cast<const uint8_t*>(pixmap.addr());
  *row_bytes = pixmap.rowBytes();
  return true;
}
}
