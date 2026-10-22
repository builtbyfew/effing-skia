#include "surface.hpp"

#include "include/core/SkSurface.h"

extern "C" {

uint32_t effing_surface_generation_id(skiac_surface* c_surface) {
  return reinterpret_cast<SkSurface*>(c_surface)->generationID();
}

skiac_surface* effing_surface_make_like(skiac_surface* c_surface) {
  auto surface = reinterpret_cast<SkSurface*>(c_surface);
  // A raster surface's makeSurface is SkSurfaces::Raster with the same info
  // and props, so its pixels start zeroed like the original's did.
  auto like = surface->makeSurface(surface->imageInfo());
  return like ? reinterpret_cast<skiac_surface*>(like.release()) : nullptr;
}
}
