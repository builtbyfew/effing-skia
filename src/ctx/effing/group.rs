//! Compositing groups: `ctx.beginGroup(options)` / `ctx.endGroup()`.
//!
//! Everything drawn in between is composited as one when the group ends, with
//! the group's opacity, blend mode and CSS filter: the semantics of CSS
//! `opacity`, `mix-blend-mode` and `filter`, which per-draw `globalAlpha`,
//! `globalCompositeOperation` and `ctx.filter` can't give when draws overlap.
//! A `backdropFilter` starts the group from the filtered content behind it,
//! clamped at the edges, for CSS `backdrop-filter`.
//!
//! `beginGroup` saves the context state like `save()` and `endGroup` restores
//! it like `restore()`; `endGroup` throws if the innermost save isn't a group,
//! while `restore()` closes a group too. Reading the canvas's pixels
//! (getImageData, encoding, drawing it into another canvas) while a group is
//! open composites the group early.

use std::result;
use std::str::FromStr;

use napi::bindgen_prelude::*;

use super::super::{CanvasRenderingContext2D, Context};
use crate::error::SkError;
use crate::filter::{css_filter, css_filters_to_image_filter};
use crate::sk::{BlendMode, ImageFilter, Paint};

#[napi(object)]
pub struct GroupOptions {
  /// Group opacity, 0 to 1.
  pub opacity: Option<f64>,
  /// A `globalCompositeOperation` value, e.g. `multiply` or `screen`.
  pub blend_mode: Option<String>,
  /// A CSS `filter` value applied to the whole group.
  pub filter: Option<String>,
  /// A CSS `filter` value applied to the content behind the group, which the
  /// group starts from.
  pub backdrop_filter: Option<String>,
  /// `[x, y, width, height]` in the current coordinate space: a size hint
  /// that also clips the group's content.
  pub bounds: Option<Vec<f64>>,
}

/// A CSS filter list as an image filter; `None` for `none`, empty or invalid.
fn parse_filter(value: Option<&str>) -> Option<ImageFilter> {
  let value = value?.trim();
  if value.is_empty() || value.eq_ignore_ascii_case("none") {
    return None;
  }
  let (rest, filters) = css_filter(value).ok()?;
  if filters.is_empty() || !rest.trim().is_empty() {
    return None;
  }
  css_filters_to_image_filter(filters)
}

impl Context {
  fn begin_group(&mut self, options: &GroupOptions) -> result::Result<(), SkError> {
    let mut paint = Paint::new();
    // Quantized like globalAlpha is.
    paint.set_alpha((options.opacity.unwrap_or(1.0).clamp(0.0, 1.0) * 255.0).round() as u8);
    if let Some(mode) = options.blend_mode.as_deref() {
      paint.set_blend_mode(BlendMode::from_str(mode)?);
    }
    if let Some(filter) = parse_filter(options.filter.as_deref()) {
      paint.set_image_filter(&filter);
    }
    let backdrop = parse_filter(options.backdrop_filter.as_deref());
    let bounds = match options.bounds.as_deref() {
      Some([x, y, w, h]) => Some([*x as f32, *y as f32, *w as f32, *h as f32]),
      _ => None,
    };
    self.save_with(|canvas| canvas.save_group(&paint, backdrop.as_ref(), bounds));
    self.group_saves.push(self.states.len() - 1);
    Ok(())
  }

  /// Whether the innermost save was made by `begin_group`.
  fn in_group(&self) -> bool {
    !self.states.is_empty() && self.group_saves.last() == Some(&(self.states.len() - 1))
  }
}

#[napi]
impl CanvasRenderingContext2D {
  /// Starts a compositing group; see the module docs.
  #[napi]
  pub fn begin_group(&mut self, options: Option<GroupOptions>) -> Result<()> {
    let options = options.unwrap_or(GroupOptions {
      opacity: None,
      blend_mode: None,
      filter: None,
      backdrop_filter: None,
      bounds: None,
    });
    self.context.begin_group(&options)?;
    Ok(())
  }

  /// Ends the innermost group started by `beginGroup`, compositing it.
  #[napi]
  pub fn end_group(&mut self) -> Result<()> {
    if !self.context.in_group() {
      return Err(Error::new(
        Status::GenericFailure,
        "endGroup() called without a matching beginGroup()",
      ));
    }
    self.context.restore();
    Ok(())
  }
}
