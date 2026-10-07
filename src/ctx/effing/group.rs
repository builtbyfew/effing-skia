//! Compositing groups: `beginGroup(ctx, options)` / `endGroup(ctx)` from
//! `extensions.js`.
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
//! open composites what it holds so far; the rest of the group is composited
//! on its own when it ends, with the same options and without the backdrop
//! filter, which the content behind it already has.

use std::str::FromStr;

use napi::bindgen_prelude::*;

use super::super::{Backend, CanvasRenderingContext2D, Context};
use crate::filter::{CssTrim, css_filter, css_filters_to_image_filter};
use crate::sk::effing::group::GroupLayer;
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
  let value = value?.css_trim();
  if value.is_empty() || value.eq_ignore_ascii_case("none") {
    return None;
  }
  let (rest, filters) = css_filter(value).ok()?;
  if filters.is_empty() || !rest.css_trim().is_empty() {
    return None;
  }
  css_filters_to_image_filter(filters)
}

/// A group's options, parsed. `paint` carries what the group's layer
/// composites with; it is `None` when there is nothing to composite (opacity
/// 1, source-over, no filters), where a plain save does.
struct Group {
  paint: Option<Paint>,
  backdrop: Option<ImageFilter>,
  bounds: Option<[f32; 4]>,
}

fn invalid(message: String) -> Error {
  Error::new(Status::GenericFailure, format!("beginGroup(): {message}"))
}

fn parse_group(options: &GroupOptions) -> Result<Group> {
  let opacity = options.opacity.unwrap_or(1.0);
  if !opacity.is_finite() {
    return Err(invalid(format!("opacity must be a number, got {opacity}")));
  }
  // Quantized like globalAlpha is.
  let alpha = (opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
  let blend_mode = match options.blend_mode.as_deref() {
    Some(mode) => BlendMode::from_str(mode)?,
    None => BlendMode::SourceOver,
  };
  let filter = parse_filter(options.filter.as_deref());
  let backdrop = parse_filter(options.backdrop_filter.as_deref());
  let bounds = match options.bounds.as_deref() {
    None => None,
    Some(&[x, y, w, h]) if [x, y, w, h].iter().all(|v| v.is_finite()) => {
      Some([x as f32, y as f32, w as f32, h as f32])
    }
    Some(bounds) => {
      return Err(invalid(format!(
        "bounds must be [x, y, width, height], got {bounds:?}"
      )));
    }
  };
  let composites =
    alpha != 255 || blend_mode != BlendMode::SourceOver || filter.is_some() || backdrop.is_some();
  let paint = composites.then(|| {
    let mut paint = Paint::new();
    paint.set_alpha(alpha);
    paint.set_blend_mode(blend_mode);
    if let Some(ref filter) = filter {
      paint.set_image_filter(filter);
    }
    paint
  });
  Ok(Group {
    paint,
    backdrop,
    bounds,
  })
}

impl Context {
  fn begin_group(&mut self, group: Group) -> Result<()> {
    if group.paint.is_some() && self.backend == Backend::Svg {
      // SkSVGDevice has no layers: whatever is drawn into one is lost.
      return Err(invalid(
        "an SVG canvas cannot composite a group; only `bounds` is supported on one".to_owned(),
      ));
    }
    let Group {
      paint,
      backdrop,
      bounds,
    } = group;
    // In a recording, a group is drawn on its own and its layer sized to
    // what it drew when it ends (see src/page_recorder/effing.rs), unless
    // the layer has to cover more: a backdrop fills the whole layer, and some
    // blend modes and filters change what is behind it outside the content.
    let fits_content = self.page_recorder.is_some()
      && backdrop.is_none()
      && paint
        .as_ref()
        .is_some_and(|paint| paint.group_fits_content(&self.state.transform));
    if fits_content {
      self.save_with(|canvas| canvas.save());
    } else {
      self.save_with(|canvas| canvas.save_group(paint.as_ref(), backdrop.as_ref(), bounds));
    }
    self.group_saves.push(self.states.len() - 1);
    if let Some(ref recorder) = self.page_recorder {
      let layer = GroupLayer {
        paint,
        bounds,
        transform: self.state.transform.clone(),
        clip: self.state.clip_path.clone(),
      };
      recorder.borrow_mut().begin_group(layer, fits_content);
    }
    // save()'s closing flush, now that a flush would reopen the layer.
    self.flush_if_recording_limit_exceeded();
    Ok(())
  }

  /// The `restore()` hook for a group's save, before it is restored:
  /// composites a group drawn on its own.
  pub(crate) fn end_group_content(&self) {
    if let Some(ref recorder) = self.page_recorder {
      recorder.borrow_mut().end_group();
    }
  }

  /// Whether the innermost save was made by `begin_group`.
  fn in_group(&self) -> bool {
    !self.states.is_empty() && self.group_saves.last() == Some(&(self.states.len() - 1))
  }
}

// Exposed as functions taking the context rather than as methods on it, so the
// context's own surface stays identical to upstream's; see extensions.js.

/// Starts a compositing group on `ctx`; see the module docs.
#[napi]
pub fn begin_group(
  ctx: &mut CanvasRenderingContext2D,
  options: Option<GroupOptions>,
) -> Result<()> {
  let options = options.unwrap_or(GroupOptions {
    opacity: None,
    blend_mode: None,
    filter: None,
    backdrop_filter: None,
    bounds: None,
  });
  ctx.context.begin_group(parse_group(&options)?)
}

/// Ends the innermost group started by `beginGroup` on `ctx`, compositing it.
#[napi]
pub fn end_group(ctx: &mut CanvasRenderingContext2D) -> Result<()> {
  if !ctx.context.in_group() {
    return Err(Error::new(
      Status::GenericFailure,
      "endGroup() called without a matching beginGroup()",
    ));
  }
  ctx.context.restore();
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::sk::ColorSpace;

  fn alpha_at(ctx: &mut Context, x: f32, y: f32) -> u8 {
    ctx
      .get_image_data(x, y, 1.0, 1.0, ColorSpace::default())
      .expect("pixels")[3]
  }

  fn set_recording_limit(ctx: &Context, bytes: usize) {
    ctx
      .page_recorder
      .as_ref()
      .unwrap()
      .borrow_mut()
      .set_recording_limit(bytes);
  }

  // The save that opens a group can be the op that reaches the recording
  // cap. The flush it triggers has to reopen the group's layer rather than a
  // plain save, or nothing drawn in the group is composited with it.
  #[test]
  fn group_opened_at_the_recording_cap_still_composites() {
    let mut ctx = Context::new(4, 4, ColorSpace::default()).expect("raster context");
    let pending = ctx.page_recorder.as_ref().unwrap().borrow().pending_bytes();
    set_recording_limit(&ctx, pending + 1);
    ctx
      .begin_group(parse_group(&translucent()).unwrap())
      .unwrap();
    ctx.fill_rect(0.0, 0.0, 4.0, 4.0).unwrap();
    ctx.restore();
    let alpha = alpha_at(&mut ctx, 1.0, 1.0);
    assert!((127..=129).contains(&alpha), "alpha {alpha}");
  }

  fn translucent() -> GroupOptions {
    GroupOptions {
      opacity: Some(0.5),
      blend_mode: None,
      filter: None,
      backdrop_filter: None,
      bounds: None,
    }
  }

  fn consolidations(ctx: &Context) -> u64 {
    ctx
      .page_recorder
      .as_ref()
      .unwrap()
      .borrow()
      .consolidations()
  }

  // A group's layer is sized to what it draws unless the layer has to cover
  // more: a backdrop, a blend mode that changes what is behind the group
  // where it draws nothing, or a filter under a rotation, which resamples.
  #[test]
  fn groups_fit_their_content_where_compositing_allows() {
    let options =
      |opacity, blend_mode: Option<&str>, filter: Option<&str>, backdrop: bool| GroupOptions {
        opacity,
        blend_mode: blend_mode.map(str::to_owned),
        filter: filter.map(str::to_owned),
        backdrop_filter: backdrop.then(|| "blur(2px)".to_owned()),
        bounds: None,
      };
    let cases = [
      (options(Some(0.5), None, None, false), false, true),
      (options(None, Some("multiply"), None, false), false, true),
      (options(None, None, Some("blur(2px)"), false), false, true),
      (options(None, None, Some("blur(2px)"), false), true, false),
      (options(None, Some("copy"), None, false), false, false),
      (
        options(None, Some("destination-in"), None, false),
        false,
        false,
      ),
      (options(None, None, None, true), false, false),
      (options(None, None, None, false), false, false),
    ];
    for (options, rotated, fits) in cases {
      let mut ctx = Context::new(8, 8, ColorSpace::default()).expect("raster context");
      if rotated {
        ctx.rotate(0.3);
      }
      ctx.begin_group(parse_group(&options).unwrap()).unwrap();
      let recorder = ctx.page_recorder.as_ref().unwrap().borrow();
      assert_eq!(
        recorder.groups_fitting_content(),
        [fits],
        "{:?} {:?} {:?} rotated: {rotated}",
        options.opacity,
        options.blend_mode,
        options.filter
      );
    }
  }

  // Flushing an open group would composite it in parts; the recording limit
  // waits for it to end. Overlapping draws then composite once: the second
  // rect hides the first.
  #[test]
  fn the_recording_limit_waits_for_an_open_group() {
    let mut ctx = Context::new(4, 4, ColorSpace::default()).expect("raster context");
    ctx
      .begin_group(parse_group(&translucent()).unwrap())
      .unwrap();
    set_recording_limit(&ctx, 1);
    ctx.fill_rect(0.0, 0.0, 4.0, 4.0).unwrap();
    ctx.state.fill_style = crate::pattern::Pattern::from_color("#00f").unwrap();
    ctx.fill_rect(0.0, 0.0, 4.0, 4.0).unwrap();
    assert_eq!(consolidations(&ctx), 0, "no flush while the group is open");
    ctx.restore();
    ctx.flush_if_recording_limit_exceeded();
    assert_eq!(consolidations(&ctx), 1, "the flush comes once it ends");
    let data = ctx
      .get_image_data(1.0, 1.0, 1.0, 1.0, ColorSpace::default())
      .expect("pixels");
    assert_eq!(data[0], 0, "no black from the first rect: {data:?}");
    assert!((127..=129).contains(&data[3]), "alpha: {data:?}");
  }
}
