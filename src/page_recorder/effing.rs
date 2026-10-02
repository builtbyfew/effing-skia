//! Effing's compositing groups in the recording (`src/ctx/effing/group.rs`).
//!
//! A group whose layer can be sized to its content records its draws on
//! their own, starting from the group's clip and transform in device space.
//! When it ends, the content is composited onto the recording below through
//! a layer the size of what it drew, rather than one the size of the canvas,
//! which is what an up-front `saveLayer` would need without bounds. Other
//! groups open their layer up front, in the recording.
//!
//! The recording below sees a plain save for a content-sized group, so the
//! save stack stays in step with the context's. A flush or putImageData
//! closes the open content recordings first, compositing what they hold so
//! far, and `replay_saves` starts them over in the resumed recording.

use super::PageRecorder;
use crate::picture_recorder::PictureRecorder;
use crate::sk::Canvas;
use crate::sk::effing::group::GroupLayer;

/// A group open in the recording.
pub(super) struct OpenGroup {
  /// The save depth that opened it.
  pub(super) depth: usize,
  layer: GroupLayer,
  /// Whether its layer is sized to its content.
  fits_content: bool,
  /// Its draws since the group opened or the recording last resumed, while
  /// it fits its content.
  content: Option<PictureRecorder>,
}

/// The canvas draws go to: the innermost open content recording, or else
/// `current`.
pub(super) fn innermost<'a>(
  groups: &'a mut [OpenGroup],
  current: &'a mut PictureRecorder,
) -> Option<&'a mut Canvas> {
  match groups
    .iter_mut()
    .rev()
    .find_map(|group| group.content.as_mut())
  {
    Some(content) => content.get_recording_canvas(),
    None => current.get_recording_canvas(),
  }
}

impl PageRecorder {
  /// Marks the latest save as opening `layer`'s group. With `fits_content`
  /// the save was a plain one and the group's draws are recorded on their
  /// own from here; otherwise it opened the layer.
  pub fn begin_group(&mut self, layer: GroupLayer, fits_content: bool) {
    let mut group = OpenGroup {
      depth: self.save_count.saturating_sub(1),
      layer,
      fits_content,
      content: None,
    };
    if fits_content {
      group.content = Some(self.start_content(&group.layer));
    }
    self.groups.push(group);
  }

  /// Composites the group whose save is being restored, if it was recorded
  /// on its own. Called before the save is restored.
  pub fn end_group(&mut self) {
    let depth = self.save_count.saturating_sub(1);
    if let Some(index) = self.groups.iter().rposition(|group| group.depth == depth) {
      self.composite_content(index);
    }
  }

  /// Whether each open group, outermost first, is sized to its content.
  /// Test-only introspection.
  #[cfg(test)]
  pub(crate) fn groups_fitting_content(&self) -> Vec<bool> {
    self.groups.iter().map(|group| group.fits_content).collect()
  }

  /// Whether a group that composites is open. Flushing the recording now
  /// would composite it in parts, so the recording limit waits for it.
  pub(super) fn holds_composited_group(&self) -> bool {
    self.groups.iter().any(|group| group.layer.paint.is_some())
  }

  /// Composites every open content recording onto the recording below it,
  /// innermost first, so that `current` holds everything drawn: before it is
  /// finished. `replay_saves` starts them over.
  pub(super) fn close_group_content(&mut self) {
    for index in (0..self.groups.len()).rev() {
      self.composite_content(index);
    }
  }

  /// Replays the save stack onto a resumed recording, opening each group
  /// again: a content-sized group gets a plain save and a new content
  /// recording, any other its layer. Leaves the innermost recording at the
  /// innermost group's state; the caller applies the current clip and
  /// transform.
  pub(super) fn replay_saves(&mut self) {
    for depth in 0..self.save_count {
      let index = self.groups.iter().position(|group| group.depth == depth);
      // Only the groups below this depth have started over.
      let split = index.unwrap_or(self.groups.len());
      let (below, group) = self.groups.split_at_mut(split);
      let Some(canvas) = innermost(below, &mut self.current) else {
        return;
      };
      match group.first() {
        Some(group) if group.fits_content => group.layer.reopen_save(canvas),
        Some(group) => group.layer.reopen(canvas),
        None => canvas.save(),
      }
      if let Some(index) = index
        && self.groups[index].fits_content
      {
        let content = self.start_content(&self.groups[index].layer);
        self.groups[index].content = Some(content);
      }
    }
  }

  fn start_content(&self, layer: &GroupLayer) -> PictureRecorder {
    let mut content = PictureRecorder::new();
    let [x, y, width, height] = layer.content_bounds(self.width, self.height);
    // Recorded with a bounding box hierarchy (PictureRecorder's default), so
    // the finished picture's cull rect is the union of what it draws.
    content.begin_recording(x, y, width, height);
    if let Some(canvas) = content.get_recording_canvas() {
      layer.begin_content(canvas);
    }
    content
  }

  fn composite_content(&mut self, index: usize) {
    let Some(mut content) = self.groups[index].content.take() else {
      return;
    };
    let Some(picture) = content.finish_recording_as_picture() else {
      return;
    };
    let (below, group) = self.groups.split_at_mut(index);
    let layer = &group[0].layer;
    let (Some(canvas), Some(paint)) = (innermost(below, &mut self.current), layer.paint.as_ref())
    else {
      return;
    };
    canvas.composite_group(&picture, paint, &layer.transform);
  }
}
