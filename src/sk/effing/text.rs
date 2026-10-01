//! The unsnapped text painter: `skia-c/effing/text.cpp`.

unsafe extern "C" {
  fn effing_take_text_painted(painted: *mut Painted);
}

/// Mirrors `effing_painted`: what the painter drew, for a recording's byte
/// budget.
#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
pub struct Painted {
  /// The outline paths and text blobs drawn, estimated like `Path::estimated_bytes`.
  pub bytes: usize,
  /// Draw calls made, one per run.
  pub ops: usize,
  /// The unique IDs of the typefaces text-blob runs keep alive; only the
  /// first 16 are listed.
  pub typefaces: [u32; 16],
  /// How many typefaces the text-blob runs keep alive.
  pub typeface_count: usize,
}

impl Painted {
  /// The listed typeface IDs.
  pub fn listed_typefaces(&self) -> &[u32] {
    &self.typefaces[..self.typeface_count.min(self.typefaces.len())]
  }
}

/// What `fillText`/`strokeText` under `geometricPrecision` drew on this thread
/// since the last call; starts the tally over.
pub fn take_text_painted() -> Painted {
  let mut painted = Painted::default();
  unsafe { effing_take_text_painted(&mut painted) };
  painted
}
