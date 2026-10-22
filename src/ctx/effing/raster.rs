//! Encodes that rasterise on the encode pool rather than the JS thread. See
//! "Rasterising async encodes on the pool" in `docs/effing.md`.
//!
//! A raster canvas records its draws, and an encode used to flush the
//! recording onto the surface, on the JS thread, before it handed a snapshot
//! to the pool. The flush is where all the rasterisation happens. While the
//! surface still holds nothing but the transparent black it started with,
//! the encode instead hands the pool the recording's unflushed layers and a
//! new surface like the canvas's, and the pool plays the layers onto that:
//! the same pictures, played the same way onto the same pixels as the flush
//! would have, so the same bytes. The canvas keeps its recording unflushed,
//! for whatever reads or draws on it next.

use napi::bindgen_prelude::*;

use crate::avif::Config;
use crate::ctx::{Context, ContextData};
use crate::gif::GifConfig;
use crate::sk::{SkImage, SkPicture, Surface};

/// What `encode()` encodes to: `ContextData` without the image, which an
/// async encode may only have once the pool has rasterised it.
pub(crate) enum EncodeFormat {
  Png,
  Jpeg(u8),
  Webp(u8),
  Avif(Config, u32, u32),
  Gif(GifConfig, u32, u32),
  Qoi,
}

impl EncodeFormat {
  pub(crate) fn with_image(self, image: SkImage) -> ContextData {
    match self {
      EncodeFormat::Png => ContextData::Png(image),
      EncodeFormat::Jpeg(quality) => ContextData::Jpeg(image, quality),
      EncodeFormat::Webp(quality) => ContextData::Webp(image, quality),
      EncodeFormat::Avif(config, width, height) => ContextData::Avif(image, config, width, height),
      EncodeFormat::Gif(config, width, height) => ContextData::Gif(image, config, width, height),
      EncodeFormat::Qoi => ContextData::Qoi(image),
    }
  }
}

/// What an async encode encodes: a snapshot of the flushed surface, or the
/// recording to rasterise first.
pub(crate) enum EncodeSource {
  Snapshot(SkImage),
  Replay(Replay),
}

/// Unflushed layers to play onto a blank surface like the canvas's.
pub(crate) struct Replay {
  surface: Surface,
  layers: Vec<SkPicture>,
}

// SAFETY: the surface is new and only this value reaches it, so it moves to
// the pool thread whole. The layers are finished pictures: SkPicture is
// immutable once recorded and its reference count is atomic, so the pool can
// play them while the canvas's recording, which holds them too, carries on
// (or plays them itself) on the JS thread. What they refer to (images,
// typefaces, paths, shaders, nested pictures) is just as immutable and
// reference-counted, and Skia's shared caches are thread-safe; worker threads
// already rasterise concurrently in one process.
unsafe impl Send for Replay {}

impl EncodeSource {
  /// The image to encode: on the pool, so a replay rasterises there.
  pub(crate) fn into_image(self) -> Result<SkImage> {
    let image = match self {
      EncodeSource::Snapshot(image) => Some(image),
      EncodeSource::Replay(Replay { surface, layers }) => {
        for layer in &layers {
          layer.playback(&surface.canvas);
        }
        surface.make_image_snapshot()
      }
    };
    image.ok_or_else(|| {
      Error::new(
        Status::GenericFailure,
        "Create image snapshot failed".to_owned(),
      )
    })
  }
}

impl Context {
  /// Takes what an async encode of the canvas as it is now encodes. That is
  /// the recording's unflushed layers, for the pool to rasterise, while the
  /// surface is still blank; otherwise, or when the canvas has no recording,
  /// it flushes and snapshots the surface, as the sync encodes do.
  pub(crate) fn encode_source(&mut self) -> Result<EncodeSource> {
    if let Some(replay) = self.take_replay() {
      return Ok(EncodeSource::Replay(replay));
    }
    self.flush();
    self
      .surface
      .make_image_snapshot()
      .map(EncodeSource::Snapshot)
      .ok_or_else(|| {
        Error::new(
          Status::GenericFailure,
          "Create image snapshot failed".to_owned(),
        )
      })
  }

  fn take_replay(&mut self) -> Option<Replay> {
    // Only a blank surface can be recreated by a new one: anything a flush
    // or a direct write left on it would be missing underneath the layers.
    if self.blank_generation != Some(self.surface.generation_id()) {
      return None;
    }
    let layers = self
      .page_recorder
      .as_ref()?
      .borrow_mut()
      .unflushed_layers_for_replay()?;
    // Nothing recorded: the blank surface's own snapshot is the image.
    if layers.is_empty() {
      return None;
    }
    let surface = self.surface.make_like()?;
    Some(Replay { surface, layers })
  }

  /// The surface was cleared to transparent black: blank again.
  pub(crate) fn note_surface_cleared(&mut self) {
    if self.page_recorder.is_some() {
      self.blank_generation = Some(self.surface.generation_id());
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::sk::ColorSpace;

  fn drawn() -> Context {
    let mut ctx = Context::new(8, 8, ColorSpace::default()).expect("raster context");
    ctx.fill_rect(1.0, 1.0, 4.0, 4.0).unwrap();
    ctx
  }

  fn pixels(image: SkImage) -> Vec<u8> {
    image.peek_premul_rgba().expect("raster pixels").0.to_vec()
  }

  fn flushed(ctx: &mut Context) -> Vec<u8> {
    ctx.flush();
    pixels(ctx.surface.make_image_snapshot().unwrap())
  }

  fn alpha_at(ctx: &mut Context, x: f32, y: f32) -> u8 {
    ctx
      .get_image_data(x, y, 1.0, 1.0, ColorSpace::default())
      .expect("pixels")[3]
  }

  // The pool plays the recording onto a new surface; the canvas keeps it
  // unflushed and flushes it to the same pixels when read.
  #[test]
  fn a_blank_canvas_replays_its_recording_to_the_same_pixels() {
    let mut ctx = drawn();
    let source = ctx.encode_source().unwrap();
    assert!(matches!(source, EncodeSource::Replay(_)));
    let replayed = pixels(source.into_image().unwrap());
    assert_eq!(replayed, flushed(&mut ctx));
    assert!(replayed.iter().any(|&byte| byte != 0));
  }

  #[test]
  fn draws_after_the_encode_are_not_in_it() {
    let mut ctx = drawn();
    let source = ctx.encode_source().unwrap();
    let expected = flushed(&mut drawn());
    ctx.fill_rect(5.0, 5.0, 3.0, 3.0).unwrap();
    assert_eq!(pixels(source.into_image().unwrap()), expected);
    assert_eq!(alpha_at(&mut ctx, 6.0, 6.0), 255);
    assert_eq!(alpha_at(&mut ctx, 2.0, 2.0), 255);
  }

  // Once anything is on the surface, a new one can't stand in for it.
  #[test]
  fn a_flushed_canvas_encodes_a_snapshot() {
    let mut ctx = drawn();
    assert_eq!(alpha_at(&mut ctx, 2.0, 2.0), 255);
    ctx.fill_rect(5.0, 5.0, 3.0, 3.0).unwrap();
    let source = ctx.encode_source().unwrap();
    assert!(matches!(source, EncodeSource::Snapshot(_)));
    let image = pixels(source.into_image().unwrap());
    let (corner, middle) = ((6 * 8 + 6) * 4 + 3, (2 * 8 + 2) * 4 + 3);
    assert_eq!((image[corner], image[middle]), (255, 255));
  }

  // A second encode of the same recording flushes it instead of playing it
  // all again.
  #[test]
  fn the_second_encode_flushes() {
    let mut ctx = drawn();
    assert!(matches!(
      ctx.encode_source().unwrap(),
      EncodeSource::Replay(_)
    ));
    ctx.fill_rect(5.0, 5.0, 3.0, 3.0).unwrap();
    let source = ctx.encode_source().unwrap();
    assert!(matches!(source, EncodeSource::Snapshot(_)));
    let image = pixels(source.into_image().unwrap());
    let (corner, middle) = ((6 * 8 + 6) * 4 + 3, (2 * 8 + 2) * 4 + 3);
    assert_eq!((image[corner], image[middle]), (255, 255));
  }

  #[test]
  fn a_full_clear_makes_the_canvas_blank_again() {
    let mut ctx = drawn();
    assert!(matches!(
      ctx.encode_source().unwrap(),
      EncodeSource::Replay(_)
    ));
    ctx.flush();
    ctx.clear_rect(0.0, 0.0, 8.0, 8.0).unwrap();
    ctx.fill_rect(5.0, 5.0, 3.0, 3.0).unwrap();
    let source = ctx.encode_source().unwrap();
    assert!(matches!(source, EncodeSource::Replay(_)));
    let image = pixels(source.into_image().unwrap());
    let (corner, middle) = ((6 * 8 + 6) * 4 + 3, (2 * 8 + 2) * 4 + 3);
    assert_eq!((image[corner], image[middle]), (255, 0));
  }

  #[test]
  fn a_canvas_with_nothing_recorded_encodes_a_snapshot() {
    let mut ctx = Context::new(8, 8, ColorSpace::default()).expect("raster context");
    let source = ctx.encode_source().unwrap();
    assert!(matches!(source, EncodeSource::Snapshot(_)));
    assert!(pixels(source.into_image().unwrap()).iter().all(|&b| b == 0));
  }
}
