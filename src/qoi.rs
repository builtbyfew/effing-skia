//! QOI ("Quite OK Image") encoding of a canvas, `encode('qoi')`, for handing
//! frames to a process that decodes them right away (ffmpeg reads QOI) when
//! PNG's deflate costs more than the bytes it saves. A lossless format that
//! encodes in a single pass with no entropy coding: see
//! https://qoiformat.org/qoi-specification.pdf and docs/effing.md.

use napi::bindgen_prelude::*;

use crate::sk::{AlphaType, SkImage};
use crate::unpremul;

const QOI_OP_INDEX: u8 = 0x00;
const QOI_OP_DIFF: u8 = 0x40;
const QOI_OP_LUMA: u8 = 0x80;
const QOI_OP_RUN: u8 = 0xc0;
const QOI_OP_RGB: u8 = 0xfe;
const QOI_OP_RGBA: u8 = 0xff;

const HEADER_SIZE: usize = 14;
const END_MARKER: [u8; 8] = [0, 0, 0, 0, 0, 0, 0, 1];
// The longest run one QOI_OP_RUN holds; 63 and 64 would read as QOI_OP_RGB
// and QOI_OP_RGBA.
const MAX_RUN: u8 = 62;

/// Encodes `image` as a four-channel sRGB QOI image of its unpremultiplied
/// pixels, as PNG stores them and as getImageData() reads them.
pub(crate) fn encode_image(image: &SkImage) -> Result<Vec<u8>> {
  encode_peeked(image).map_or_else(|| encode_read(image), Ok)
}

/// Unpremultiplies a row at a time straight from the image's pixels, with
/// the conversion getImageData() uses, into a row that stays in cache,
/// rather than into a copy of the whole image first. None when the image
/// isn't stored as premultiplied RGBA or the CPU lacks the conversion.
fn encode_peeked(image: &SkImage) -> Option<Vec<u8>> {
  let row_fn = unpremul::row_fn()?;
  let (pixels, row_bytes) = image.peek_premul_rgba()?;
  let (width, height) = (image.width() as usize, image.height() as usize);
  let mut encoder = Encoder::new(width as u32, height as u32);
  let mut row = vec![0u32; width];
  for y in 0..height {
    let src = pixels[y * row_bytes..][..width * 4].as_ptr().cast::<u32>();
    // SAFETY: `src` spans the row's `width` pixels and is 4-byte aligned
    // (`peek_premul_rgba`), and `row` is a separate buffer of `width` pixels.
    unsafe { row_fn(row.as_mut_ptr(), src, width) };
    // SAFETY: `row`'s `width` u32s are `width * 4` initialized bytes.
    let bytes = unsafe { std::slice::from_raw_parts(row.as_ptr().cast::<u8>(), width * 4) };
    encoder.push(bytes);
  }
  Some(encoder.finish())
}

/// Reads the whole image into an unpremultiplied copy with Skia's
/// conversion, then encodes it.
fn encode_read(image: &SkImage) -> Result<Vec<u8>> {
  let pixels = image
    .read_pixels(AlphaType::Unpremultiplied)
    .ok_or_else(|| {
      Error::new(
        Status::GenericFailure,
        "Encode to qoi error, failed to get surface pixels".to_owned(),
      )
    })?;
  let mut encoder = Encoder::new(image.width() as u32, image.height() as u32);
  encoder.push(&pixels);
  Ok(encoder.finish())
}

/// A QOI encoder fed unpremultiplied RGBA pixels in order, in as many pieces
/// as suit the caller.
struct Encoder {
  out: Vec<u8>,
  // Pixels as little-endian u32s, so red is the low byte.
  index: [u32; 64],
  prev: u32,
  run: u8,
}

impl Encoder {
  fn new(width: u32, height: u32) -> Self {
    // Reserve the raw pixels' size up front: growing row by row copies the
    // output into fresh memory at each step, which costs more than the
    // encode where page faults are slow. Only an image that changes alpha at
    // most pixels (QOI_OP_RGBA is 5 bytes) outgrows it. Only the pages
    // written are touched, and the Buffer reports its length, not this
    // capacity, to V8.
    let mut out =
      Vec::with_capacity(HEADER_SIZE + width as usize * height as usize * 4 + END_MARKER.len());
    out.extend_from_slice(b"qoif");
    out.extend_from_slice(&width.to_be_bytes());
    out.extend_from_slice(&height.to_be_bytes());
    out.push(4); // channels: RGBA
    out.push(0); // colorspace: sRGB with linear alpha
    Self {
      out,
      index: [0; 64],
      prev: u32::from_le_bytes([0, 0, 0, 255]),
      run: 0,
    }
  }

  fn push(&mut self, pixels: &[u8]) {
    let Self {
      out,
      index,
      prev,
      run,
    } = self;
    for &px in pixels.as_chunks::<4>().0 {
      let px = u32::from_le_bytes(px);
      if px == *prev {
        *run += 1;
        if *run == MAX_RUN {
          out.push(QOI_OP_RUN | (*run - 1));
          *run = 0;
        }
        continue;
      }
      if *run > 0 {
        out.push(QOI_OP_RUN | (*run - 1));
        *run = 0;
      }

      let hash = hash(px);
      if index[hash] == px {
        out.push(QOI_OP_INDEX | hash as u8);
      } else {
        index[hash] = px;
        let [r, g, b, a] = px.to_le_bytes();
        let [pr, pg, pb, pa] = prev.to_le_bytes();
        if a == pa {
          // Channel differences wrap, as in the reference encoder: 255 to 0
          // is a difference of 1.
          let dr = r.wrapping_sub(pr) as i8;
          let dg = g.wrapping_sub(pg) as i8;
          let db = b.wrapping_sub(pb) as i8;
          let dr_dg = dr.wrapping_sub(dg);
          let db_dg = db.wrapping_sub(dg);
          if (-2..=1).contains(&dr) && (-2..=1).contains(&dg) && (-2..=1).contains(&db) {
            out.push(QOI_OP_DIFF | ((dr + 2) as u8) << 4 | ((dg + 2) as u8) << 2 | (db + 2) as u8);
          } else if (-32..=31).contains(&dg)
            && (-8..=7).contains(&dr_dg)
            && (-8..=7).contains(&db_dg)
          {
            out.push(QOI_OP_LUMA | (dg + 32) as u8);
            out.push(((dr_dg + 8) as u8) << 4 | (db_dg + 8) as u8);
          } else {
            out.extend_from_slice(&[QOI_OP_RGB, r, g, b]);
          }
        } else {
          out.extend_from_slice(&[QOI_OP_RGBA, r, g, b, a]);
        }
      }
      *prev = px;
    }
  }

  fn finish(mut self) -> Vec<u8> {
    if self.run > 0 {
      self.out.push(QOI_OP_RUN | (self.run - 1));
    }
    self.out.extend_from_slice(&END_MARKER);
    // The Buffer holds the whole allocation until it's collected, so give
    // back the room a frame that compressed well didn't use: copying at most
    // a quarter of the raw size costs little next to the encode.
    if self.out.len() < self.out.capacity() / 4 {
      self.out.shrink_to_fit();
    }
    self.out
  }
}

/// The spec's index position, `(r * 3 + g * 5 + b * 7 + a * 11) % 64`.
#[inline(always)]
fn hash(px: u32) -> usize {
  let [r, g, b, a] = px.to_le_bytes();
  (r.wrapping_mul(3)
    .wrapping_add(g.wrapping_mul(5))
    .wrapping_add(b.wrapping_mul(7))
    .wrapping_add(a.wrapping_mul(11))
    & 63) as usize
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::sk::{ColorSpace, Surface};

  // Random RGBA written to a surface, which stores it premultiplied like a
  // canvas or, with `premultiplied` false, as it is.
  fn noise(width: u32, height: u32, premultiplied: bool) -> SkImage {
    let mut surface = if premultiplied {
      Surface::new_rgba_premultiplied(width, height, ColorSpace::default())
    } else {
      Surface::new_rgba(width, height, ColorSpace::default())
    }
    .expect("raster surface");
    let mut seed = 7u32;
    let pixels: Vec<u8> = (0..width * height * 4)
      .map(|_| {
        seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
        (seed >> 16) as u8
      })
      .collect();
    let (w, h) = (width as usize, height as usize);
    surface.canvas.write_pixels(pixels.as_ptr(), w, h, 0, 0);
    surface.make_image_snapshot().expect("snapshot")
  }

  // Widths below, at and past the SIMD conversion's 4-, 8- and 16-pixel
  // blocks, so its scalar tails are covered too.
  const WIDTHS: [u32; 7] = [1, 3, 4, 7, 17, 33, 64];

  #[test]
  fn reading_in_place_encodes_what_reading_a_copy_does() {
    for width in WIDTHS {
      let image = noise(width, 9, true);
      match encode_peeked(&image) {
        Some(peeked) => assert!(peeked == encode_read(&image).unwrap(), "width {width}"),
        None => assert!(
          unpremul::row_fn().is_none(),
          "a canvas snapshot wasn't peeked"
        ),
      }
    }
  }

  #[test]
  fn an_image_not_stored_premultiplied_falls_back_to_reading_a_copy() {
    let image = noise(17, 9, false);
    assert!(image.peek_premul_rgba().is_none());
    assert!(encode_image(&image).unwrap() == encode_read(&image).unwrap());
  }

  #[test]
  fn pixels_fed_in_any_pieces_encode_the_same() {
    let image = noise(33, 9, true);
    let pixels = image.read_pixels(AlphaType::Unpremultiplied).unwrap();
    let whole = encode_read(&image).unwrap();
    for piece in [4, 12, 132, 1000] {
      let mut encoder = Encoder::new(33, 9);
      for chunk in pixels.chunks(piece) {
        encoder.push(chunk);
      }
      assert!(encoder.finish() == whole, "pieces of {piece} bytes");
    }
  }
}
