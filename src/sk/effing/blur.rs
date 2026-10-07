//! The canvas blur, as Chrome's software canvas blurs: `skia-c/effing/blur.cpp`.

use std::ptr;

use super::super::{ImageFilter, ffi};

unsafe extern "C" {
  fn effing_image_filter_make_canvas_blur(
    sigma_x: f32,
    sigma_y: f32,
    chained_filter: *mut ffi::skiac_image_filter,
  ) -> *mut ffi::skiac_image_filter;
  fn effing_image_filter_make_canvas_drop_shadow(
    dx: f32,
    dy: f32,
    sigma_x: f32,
    sigma_y: f32,
    color: u32,
    shadow_only: bool,
    chained_filter: *mut ffi::skiac_image_filter,
  ) -> *mut ffi::skiac_image_filter;
}

/// Which blur a filter's `blur()` and `drop-shadow()` run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Blur {
  /// Skia's, whose lengths scale with the transform of the layer the filter
  /// runs in: a group's filters.
  Skia,
  /// Chrome's software canvas's, in the pixels of a layer opened at the
  /// device identity: `ctx.filter` and image-filter shadows. Chromium builds
  /// Skia to blur with three boxes at every sigma, where Skia's default is a
  /// Gaussian kernel below sigma 2.
  Canvas,
}

fn wrap(raw_ptr: *mut ffi::skiac_image_filter) -> Option<ImageFilter> {
  if raw_ptr.is_null() {
    None
  } else {
    Some(ImageFilter(raw_ptr))
  }
}

impl ImageFilter {
  /// `make_blur` with `blur`'s blur.
  pub fn make_blur_with(
    blur: Blur,
    sigma_x: f32,
    sigma_y: f32,
    chained_filter: Option<&ImageFilter>,
  ) -> Option<Self> {
    match blur {
      Blur::Skia => Self::make_blur(sigma_x, sigma_y, chained_filter),
      Blur::Canvas => wrap(unsafe {
        effing_image_filter_make_canvas_blur(
          sigma_x,
          sigma_y,
          chained_filter.map(|c| c.0).unwrap_or(ptr::null_mut()),
        )
      }),
    }
  }

  /// `make_drop_shadow`, or `make_drop_shadow_only` when `shadow_only`, with
  /// `blur`'s blur.
  #[allow(clippy::too_many_arguments)]
  pub fn make_drop_shadow_with(
    blur: Blur,
    dx: f32,
    dy: f32,
    sigma_x: f32,
    sigma_y: f32,
    color: u32,
    shadow_only: bool,
    chained_filter: Option<&ImageFilter>,
  ) -> Option<Self> {
    match (blur, shadow_only) {
      (Blur::Skia, false) => {
        Self::make_drop_shadow(dx, dy, sigma_x, sigma_y, color, chained_filter)
      }
      (Blur::Skia, true) => {
        Self::make_drop_shadow_only(dx, dy, sigma_x, sigma_y, color, chained_filter)
      }
      (Blur::Canvas, _) => wrap(unsafe {
        effing_image_filter_make_canvas_drop_shadow(
          dx,
          dy,
          sigma_x,
          sigma_y,
          color,
          shadow_only,
          chained_filter.map(|c| c.0).unwrap_or(ptr::null_mut()),
        )
      }),
    }
  }
}
