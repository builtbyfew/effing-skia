# Effing extensions

This is effing's fork of [`@napi-rs/canvas`](https://github.com/napi-rs/canvas).
It adds what effing's CSS-like renderer needs and the Canvas 2D API cannot
express, and changes one behaviour. Everything else is upstream.

## Where the code lives

Fork code is kept out of upstream files so that upstream merges stay trivial.
Each layer has an `effing` directory with one file per feature, and each
upstream file has at most a few marked hook lines.

| Layer                  | Fork code                                                  | Upstream hooks                                              |
| ---------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| C++ bridge to Skia     | `skia-c/effing/{text,paragraph,group}.{hpp,cpp}`           | `skia-c/skia_c.cpp` (include + two `text_rendering` checks) |
| Rust wrappers          | `src/sk/effing.rs`, `src/sk/effing/{paragraph,group}.rs`   | `src/sk.rs` (`mod effing`)                                  |
| Rust 2D context (napi) | `src/ctx/effing.rs`, `src/ctx/effing/{paragraph,group}.rs` | `src/ctx.rs` (`mod effing`, `save_with`, `group_saves`)     |
| Build                  |                                                            | `build.rs` (`EFFING_SOURCES`)                               |
| JS surface             | `__test__/effing-*.spec.ts`, this file                     | `index.js`, `js-binding.js`, `index.d.ts` (hand-maintained) |

C symbols are prefixed `effing_`; C++ helpers live in `namespace effing`.

## Unsnapped text under `textRendering = 'geometricPrecision'`

Upstream `fillText`/`strokeText` draws hinted glyph masks that Skia snaps to
the pixel grid, so text moves by up to half a pixel depending on where it
lands and at what scale the canvas is rasterized. Under
`ctx.textRendering = 'geometricPrecision'` the fork instead lays the text out
unhinted and fills each glyph outline as a path at its exact position. Text
then follows sub-pixel coordinates and lands in the same place whether the
canvas is drawn at 1x or any other scale, which is what a video renderer
producing several resolutions needs. Runs with glyphs that have no outline
(color or bitmap emoji) fall back to masks with baseline snapping off.

The other `textRendering` values behave as upstream.

## `Paragraph`

```ts
import { Paragraph } from '@napi-rs/canvas'

const paragraph = new Paragraph('The quick brown fox…', {
  fontFamily: '"Inter", sans-serif',
  fontSize: 16,
  lineHeight: 24,
  textAlign: 'center',
  maxLines: 2,
  ellipsis: '…',
})
const layout = paragraph.layout(320) // { height, lines: [{ left, width, baseline, … }], … }
ctx.fillParagraph(paragraph, x, y) // top-left corner at (x, y)
ctx.strokeParagraph(paragraph, x, y)
```

A `Paragraph` is a single-style paragraph laid out natively by SkParagraph
(line breaking, shaping, bidi, font fallback), with effing's CSS line model on
top:

- Every line box is exactly `lineHeight` tall (`normal` is the primary font's
  hhea ascender + descender), and the baseline sits in the box by CSS
  half-leading. Fallback fonts never grow a line.
- `textAlign` is applied per line relative to the layout width, so `noWrap`
  lines wider than the box overflow the way CSS does. `justify` is Skia's.
- `noWrap` breaks only at hard breaks; with an `ellipsis` it truncates to the
  width instead. `maxLines` truncates with the `ellipsis` too.
- Glyphs are unhinted and painted unsnapped, exactly as `fillText` does under
  `geometricPrecision`; the two agree pixel for pixel.

`layout(width)` must be called before painting. It returns the paragraph's
metrics and one entry per line: `left` and `baseline` from the paragraph's
top-left corner, the advance `width` without trailing whitespace, the UTF-8
byte range of the line's text, and whether it ends at a hard break.

`fillParagraph`/`strokeParagraph` use the context's current fill or stroke
style, line settings, shadow, filter, clip and transform, like `fillText`.
The style's own font settings are all a paragraph has; `ctx.font`,
`ctx.letterSpacing` and friends are ignored.

## Compositing groups: `beginGroup` / `endGroup`

```ts
ctx.beginGroup({ opacity: 0.5, blendMode: 'multiply', filter: 'blur(2px)' })
// … any drawing …
ctx.endGroup()
```

Everything drawn between the two calls is composited as one when the group
ends, with the group's `opacity`, `blendMode` (a `globalCompositeOperation`
value) and CSS `filter`. That is what CSS `opacity`, `mix-blend-mode` and
`filter` mean on an element, and what per-draw `globalAlpha`,
`globalCompositeOperation` and `ctx.filter` cannot give once draws overlap.
`backdropFilter` starts the group from the filtered content behind it,
clamped at the edges like a browser does at the viewport edge, for CSS
`backdrop-filter`. `bounds` (`[x, y, width, height]` in the current
coordinate space) sizes the group's buffer and clips its content.

`beginGroup` saves the context state like `save()`, and `endGroup` restores
it like `restore()`. `endGroup` throws if the innermost save was not made by
`beginGroup`; a plain `restore()` closes a group as well. Reading the
canvas's pixels while a group is open (`getImageData`, encoding, drawing the
canvas into another) composites the group early.

This is deliberately not the proposed Canvas 2D `beginLayer`/`endLayer`: that
API takes the layer's alpha and blend mode from `globalAlpha` and
`globalCompositeOperation` and resets them inside the layer, while a group is
configured explicitly and leaves the state alone.

## Changelog

Changes to the fork's public surface, for `@effing/canvas` to follow.

### Unreleased

- `beginLayer(options)` / `endLayer()` are now `beginGroup(options)` /
  `endGroup()` with the same options. `endGroup()` throws when the innermost
  save is not a group (it used to be a plain `restore()`).
- `ParagraphLine` no longer carries `ascent`, `descent` and `height`; they
  are constant across lines and live on `ParagraphLayout` as `ascent`,
  `descent` and `lineHeight`.
- `ParagraphStyle.fontStyle`, `textAlign` and `direction` now reject invalid
  values instead of falling back to the default.
- The `EFFING_GP_TEXT=mask` environment switch is gone; `geometricPrecision`
  always fills outlines.
- Types for `Paragraph`, `fillParagraph`, `strokeParagraph`, `beginGroup` and
  `endGroup` are in `index.d.ts`.
