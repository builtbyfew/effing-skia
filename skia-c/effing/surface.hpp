// Effing's access to a raster surface's content generation and to new
// surfaces like it, for encodes that rasterise the recording off the JS
// thread (src/ctx/effing/raster.rs).
#ifndef EFFING_SURFACE_HPP
#define EFFING_SURFACE_HPP

#include "../skia_c.hpp"

extern "C" {
// `surface`'s content generation: it changes whenever anything draws on the
// surface or writes its pixels, through its canvas or the surface itself.
uint32_t effing_surface_generation_id(skiac_surface* surface);

// A new surface with `surface`'s size, image info (colour type, alpha type,
// colour space) and surface properties, cleared to transparent black, or
// nullptr if it can't be allocated.
skiac_surface* effing_surface_make_like(skiac_surface* surface);
}

#endif  // EFFING_SURFACE_HPP
