//! Effing layer primitive: `ctx.beginLayer(options)` / `ctx.endLayer()`.
//!
//! Everything drawn in between is composited as one group when the layer ends,
//! with the layer's opacity, blend mode and CSS filter — CSS `opacity`,
//! `mix-blend-mode` and `filter` semantics, which per-draw `globalAlpha` and
//! `ctx.filter` can't give when draws overlap. A `backdropFilter` starts the
//! layer from the filtered content behind it, clamped at the edges, for CSS
//! `backdrop-filter`.
//!
//! `beginLayer` saves the context state like `save()`, and `endLayer` restores
//! it like `restore()`. Reading this canvas's pixels (getImageData, encoding,
//! drawing it into another canvas) while a layer is open composites the layer
//! early.

use std::result;
use std::str::FromStr;

use napi::bindgen_prelude::*;

use super::{CanvasRenderingContext2D, Context};
use crate::error::SkError;
use crate::filter::{css_filter, css_filters_to_image_filter};
use crate::sk::{BlendMode, ImageFilter};

#[napi(object)]
pub struct LayerOptions {
  /// Group opacity, 0 to 1.
  pub opacity: Option<f64>,
  /// A `globalCompositeOperation` value, e.g. `multiply` or `screen`.
  pub blend_mode: Option<String>,
  /// A CSS `filter` value applied to the whole group.
  pub filter: Option<String>,
  /// A CSS `filter` value applied to the content behind the layer, which the
  /// layer starts from.
  pub backdrop_filter: Option<String>,
  /// Optional `[x, y, width, height]` in the current coordinate space: a size
  /// hint that also clips the layer's content.
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
  fn begin_layer(&mut self, options: &LayerOptions) -> result::Result<(), SkError> {
    let opacity = options.opacity.unwrap_or(1.0).clamp(0.0, 1.0) as f32;
    let blend_mode = match options.blend_mode.as_deref() {
      Some(mode) => BlendMode::from_str(mode)?,
      None => BlendMode::SourceOver,
    };
    let filter = parse_filter(options.filter.as_deref());
    let backdrop = parse_filter(options.backdrop_filter.as_deref());
    let bounds = match options.bounds.as_deref() {
      Some([x, y, w, h]) => Some([*x as f32, *y as f32, *w as f32, *h as f32]),
      _ => None,
    };
    self.with_canvas_state(|canvas| {
      canvas.effing_save_layer(opacity, blend_mode, filter.as_ref(), backdrop.as_ref(), bounds);
    });
    self.states.push(self.state.clone());
    self.sync_transform_to_recorder();
    self.sync_clip_to_recorder();
    if let Some(ref recorder) = self.page_recorder {
      recorder.borrow_mut().increment_save();
    }
    Ok(())
  }
}

#[napi]
impl CanvasRenderingContext2D {
  /// Starts a compositing group; see the module docs.
  #[napi]
  pub fn begin_layer(&mut self, options: Option<LayerOptions>) -> Result<()> {
    let options = options.unwrap_or(LayerOptions {
      opacity: None,
      blend_mode: None,
      filter: None,
      backdrop_filter: None,
      bounds: None,
    });
    self.context.begin_layer(&options)?;
    Ok(())
  }

  /// Ends the innermost group started by `beginLayer`, compositing it.
  #[napi]
  pub fn end_layer(&mut self) {
    self.context.restore();
  }
}
