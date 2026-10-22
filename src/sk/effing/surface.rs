//! A raster surface's content generation, and new surfaces like it:
//! `skia-c/effing/surface.cpp`.

use super::super::{Surface, ffi};

unsafe extern "C" {
  fn effing_surface_generation_id(surface: *mut ffi::skiac_surface) -> u32;
  fn effing_surface_make_like(surface: *mut ffi::skiac_surface) -> *mut ffi::skiac_surface;
}

impl Surface {
  /// The surface's content generation: it changes whenever anything draws
  /// on the surface or writes its pixels.
  pub fn generation_id(&self) -> u32 {
    unsafe { effing_surface_generation_id(self.ptr) }
  }

  /// A new raster surface with this one's size, image info and surface
  /// properties, cleared to transparent black. Only for raster surfaces.
  pub fn make_like(&self) -> Option<Surface> {
    unsafe { Surface::from_ptr(effing_surface_make_like(self.ptr)) }
  }
}
