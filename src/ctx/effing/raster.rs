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
//! for whatever reads or draws on it next. When the encode resolves, a canvas
//! that hasn't changed since swaps layers a flush would have consolidated for
//! the image the pool rendered, as the flush would have.

use napi::bindgen_prelude::*;

use crate::avif::Config;
use crate::ctx::{CanvasRenderingContext2D, Context, ContextData};
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
  /// Set when a flush would have consolidated the layers, for the canvas to
  /// take the rendered image in their place (`Context::adopt_replayed`).
  consolidate: Option<CanvasState>,
}

/// The canvas as an encode took its layers: its surface's generation, which
/// is unique to the surface and changes with any write to it (a flush, a
/// clear), and its recording's content version, which changes with every
/// draw and `reset()`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct CanvasState {
  generation: u32,
  content_version: u64,
}

/// The image the pool rendered from a canvas's layers, for the canvas to keep
/// in their place if it's still as the encode found it.
pub(crate) struct Replayed {
  image: SkImage,
  state: CanvasState,
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
  /// Whether the canvas can take the rendered image in place of its layers
  /// (`Replayed`), so the encode should hand it back.
  pub(crate) fn consolidates(&self) -> bool {
    matches!(
      self,
      EncodeSource::Replay(Replay {
        consolidate: Some(_),
        ..
      })
    )
  }

  /// The image to encode: on the pool, so a replay rasterises there. With
  /// it, the image again for the canvas when it `consolidates()`.
  pub(crate) fn into_image(self) -> Result<(SkImage, Option<Replayed>)> {
    let image = match self {
      EncodeSource::Snapshot(image) => Some((image, None)),
      EncodeSource::Replay(Replay {
        surface,
        layers,
        consolidate,
      }) => {
        for layer in &layers {
          layer.playback(&surface.canvas);
        }
        surface.make_image_snapshot().map(|image| {
          let replayed = consolidate.map(|state| Replayed {
            image: image.clone(),
            state,
          });
          (image, replayed)
        })
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

/// The canvas an async encode was taken from, for handing it the rendered
/// image when the encode resolves. Weak: an encode doesn't keep the canvas
/// alive.
pub(crate) struct EncodedCanvas(WeakReference<CanvasRenderingContext2D>);

// SAFETY: it only travels with the encode's resolve callback, which runs on
// the JS thread it was made on, and only that dereferences it. Dropping it
// elsewhere (a rejected encode) releases a `std::sync::Weak` and nothing of
// napi's.
unsafe impl Send for EncodedCanvas {}

impl EncodedCanvas {
  /// `None` if napi-rs doesn't know the context, which only means the canvas
  /// keeps its layers.
  pub(crate) fn new(env: &Env, ctx: &ClassInstance<CanvasRenderingContext2D>) -> Option<Self> {
    // The context's napi-rs reference, by the pointer it wraps (as napi-rs's
    // own `FromNapiValue for Reference` finds it): strong only for as long as
    // it takes to make the weak one. (Not by `ctx.value`: that's a handle
    // from the canvas's constructor, whose scope has ended.)
    let wrapped = std::ptr::from_ref::<CanvasRenderingContext2D>(ctx).cast_mut();
    let strong =
      unsafe { Reference::<CanvasRenderingContext2D>::from_value_ptr(wrapped.cast(), env.raw()) };
    strong.ok().map(|strong| EncodedCanvas(strong.downgrade()))
  }

  /// On the JS thread, as the encode resolves: hands the canvas the image,
  /// if the canvas is still alive.
  pub(crate) fn adopt(mut self, replayed: Replayed) {
    if let Some(ctx) = self.0.get_mut() {
      ctx.context.adopt_replayed(replayed);
    }
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
    let generation = self.surface.generation_id();
    if self.blank_generation != Some(generation) {
      return None;
    }
    let mut recorder = self.page_recorder.as_ref()?.borrow_mut();
    let layers = recorder.unflushed_layers_for_replay()?;
    // Nothing recorded: the blank surface's own snapshot is the image.
    if layers.is_empty() {
      return None;
    }
    let surface = self.surface.make_like()?;
    recorder.note_replayed_off_thread();
    let consolidate = recorder.should_consolidate().then(|| CanvasState {
      generation,
      content_version: recorder.content_version(),
    });
    Some(Replay {
      surface,
      layers,
      consolidate,
    })
  }

  /// Takes the image the pool rendered from the canvas's unflushed layers in
  /// their place, as `flush()` consolidates them, if the canvas is as the
  /// encode found it: nothing drawn, flushed, cleared or resized since. That
  /// releases what the layers pinned (sources drawn, `putImageData` copies),
  /// as the flush `encode()` did before. The image stands in for the layers
  /// as they were: unflushed, onto a still blank surface, so a later flush or
  /// encode plays it like them, to the same pixels.
  pub(crate) fn adopt_replayed(&mut self, Replayed { image, state }: Replayed) {
    let generation = self.surface.generation_id();
    let Some(recorder) = self.page_recorder.as_ref() else {
      return;
    };
    let mut recorder = recorder.borrow_mut();
    let now = CanvasState {
      generation,
      content_version: recorder.content_version(),
    };
    if now == state && self.blank_generation == Some(generation) {
      recorder.consolidate_unflushed_with_snapshot(image);
    }
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
    let replayed = pixels(source.into_image().unwrap().0);
    assert_eq!(replayed, flushed(&mut ctx));
    assert!(replayed.iter().any(|&byte| byte != 0));
  }

  #[test]
  fn draws_after_the_encode_are_not_in_it() {
    let mut ctx = drawn();
    let source = ctx.encode_source().unwrap();
    let expected = flushed(&mut drawn());
    ctx.fill_rect(5.0, 5.0, 3.0, 3.0).unwrap();
    assert_eq!(pixels(source.into_image().unwrap().0), expected);
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
    let image = pixels(source.into_image().unwrap().0);
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
    let image = pixels(source.into_image().unwrap().0);
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
    let image = pixels(source.into_image().unwrap().0);
    let (corner, middle) = ((6 * 8 + 6) * 4 + 3, (2 * 8 + 2) * 4 + 3);
    assert_eq!((image[corner], image[middle]), (255, 0));
  }

  // A direct write to the surface, such as the `alpha: false` base fill or
  // a Lottie frame, isn't in the recording: a new surface would miss it.
  #[test]
  fn a_canvas_written_to_directly_encodes_a_snapshot() {
    let mut ctx = Context::new(8, 8, ColorSpace::default()).expect("raster context");
    let mut base = ctx.fill_paint().unwrap();
    base.set_color(255, 255, 255, 255);
    ctx.with_surface_canvas(|canvas| canvas.draw_rect(0.0, 0.0, 8.0, 8.0, &base));
    ctx.fill_rect(1.0, 1.0, 4.0, 4.0).unwrap();
    let source = ctx.encode_source().unwrap();
    assert!(matches!(source, EncodeSource::Snapshot(_)));
    let image = pixels(source.into_image().unwrap().0);
    let (corner, middle) = ((6 * 8 + 6) * 4, (2 * 8 + 2) * 4);
    assert_eq!(&image[corner..corner + 4], &[255, 255, 255, 255]);
    assert_eq!(&image[middle..middle + 4], &[0, 0, 0, 255]);
  }

  #[test]
  fn a_canvas_with_nothing_recorded_encodes_a_snapshot() {
    let mut ctx = Context::new(8, 8, ColorSpace::default()).expect("raster context");
    let source = ctx.encode_source().unwrap();
    assert!(matches!(source, EncodeSource::Snapshot(_)));
    assert!(
      pixels(source.into_image().unwrap().0)
        .iter()
        .all(|&b| b == 0)
    );
  }

  fn recorder(ctx: &Context) -> std::cell::RefMut<'_, crate::page_recorder::PageRecorder> {
    ctx.page_recorder.as_ref().unwrap().borrow_mut()
  }

  // Two layers, unflushed: a flush would consolidate them.
  fn drawn_in_two_layers() -> Context {
    let mut ctx = drawn();
    ctx.get_picture().expect("a picture"); // promotes the first layer
    ctx.fill_rect(5.0, 5.0, 3.0, 3.0).unwrap();
    ctx
  }

  // As a flush consolidates the layers, the canvas takes the image the pool
  // rendered in their place, unflushed, and plays it to the same pixels.
  #[test]
  fn an_unchanged_canvas_takes_the_replayed_image_in_place_of_its_layers() {
    let mut ctx = drawn_in_two_layers();
    let expected = flushed(&mut drawn_in_two_layers());
    let source = ctx.encode_source().unwrap();
    assert!(source.consolidates());
    let (image, replayed) = source.into_image().unwrap();
    assert_eq!(pixels(image), expected);
    ctx.adopt_replayed(replayed.expect("the image for the canvas"));
    assert_eq!(recorder(&ctx).layer_count(), 1);
    assert_eq!(recorder(&ctx).consolidations(), 1);
    // Still blank and unflushed, so the next encode plays it on the pool.
    let source = ctx.encode_source().unwrap();
    assert!(matches!(source, EncodeSource::Replay(_)));
    assert_eq!(pixels(source.into_image().unwrap().0), expected);
    assert_eq!(flushed(&mut ctx), expected);
  }

  #[test]
  fn a_canvas_drawn_on_since_the_encode_keeps_its_layers() {
    let mut ctx = drawn_in_two_layers();
    let (_, replayed) = ctx.encode_source().unwrap().into_image().unwrap();
    ctx.fill_rect(0.0, 6.0, 1.0, 1.0).unwrap();
    ctx.adopt_replayed(replayed.unwrap());
    assert_eq!(recorder(&ctx).consolidations(), 0);
    assert_eq!(alpha_at(&mut ctx, 0.0, 6.0), 255);
    assert_eq!(alpha_at(&mut ctx, 6.0, 6.0), 255);
  }

  #[test]
  fn a_canvas_flushed_since_the_encode_keeps_its_layers() {
    let mut ctx = drawn_in_two_layers();
    let (_, replayed) = ctx.encode_source().unwrap().into_image().unwrap();
    assert_eq!(alpha_at(&mut ctx, 6.0, 6.0), 255);
    let consolidations = recorder(&ctx).consolidations();
    ctx.adopt_replayed(replayed.unwrap());
    assert_eq!(recorder(&ctx).consolidations(), consolidations);
  }

  #[test]
  fn a_canvas_cleared_since_the_encode_stays_clear() {
    let mut ctx = drawn_in_two_layers();
    let (_, replayed) = ctx.encode_source().unwrap().into_image().unwrap();
    ctx.clear_rect(0.0, 0.0, 8.0, 8.0).unwrap();
    ctx.adopt_replayed(replayed.unwrap());
    assert_eq!(recorder(&ctx).consolidations(), 0);
    assert_eq!(alpha_at(&mut ctx, 2.0, 2.0), 0);
  }

  // A single layer isn't consolidated by a flush either: nothing to hand back.
  #[test]
  fn a_single_layer_is_not_handed_back() {
    let mut ctx = drawn();
    let source = ctx.encode_source().unwrap();
    assert!(!source.consolidates());
    assert!(source.into_image().unwrap().1.is_none());
  }
}
