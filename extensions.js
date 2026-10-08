// Effing's additions, kept off the main entry so that `@effing/skia` itself
// stays a drop-in for `@napi-rs/canvas`. See docs/effing.md.
const { Paragraph, beginGroup, endGroup, fillParagraph, fontRevision, strokeParagraph } = require('./js-binding.js')

module.exports = {
  Paragraph,
  beginGroup,
  endGroup,
  fillParagraph,
  fontRevision,
  strokeParagraph,
}
