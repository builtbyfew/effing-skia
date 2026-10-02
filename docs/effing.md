# Effing extensions

`@effing/skia` is effing's fork of [`@napi-rs/canvas`](https://github.com/napi-rs/canvas).
The main entry is a drop-in for upstream: same classes, same context, same
types. Effing's additions live in a separate entry, `@effing/skia/extensions`,
so that swapping the backend later only touches the code that imports it.
One behaviour is changed, and only behind an opt-in: text rendering under
`textRendering = 'geometricPrecision'`.

```ts
import { createCanvas } from '@effing/skia' // upstream's API, unchanged
import { beginGroup, endGroup, Paragraph, fillParagraph } from '@effing/skia/extensions'
```

## Where the code lives

Fork code is kept out of upstream files so that upstream merges stay trivial.
Each layer has an `effing` directory with one file per feature, and each
upstream file has at most a few marked hook lines.

| Layer                  | Fork code                                                       | Upstream hooks                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C++ bridge to Skia     | `skia-c/effing/{text,paragraph,group}.{hpp,cpp}`                | `skia-c/skia_c.cpp` (include + two `text_rendering` checks)                                                                                                                           |
| Rust wrappers          | `src/sk/effing.rs`, `src/sk/effing/{text,paragraph,group}.rs`   | `src/sk.rs` (`mod effing`)                                                                                                                                                            |
| Rust 2D context (napi) | `src/ctx/effing.rs`, `src/ctx/effing/{text,paragraph,group}.rs` | `src/ctx.rs` (`mod effing`, `save_with`, `group_saves`, `end_group_content`, `account_unsnapped_text`)                                                                                |
| Deferred recording     | `src/page_recorder/effing.rs` (groups in the recording)         | `src/page_recorder.rs` (`mod effing`, `groups`, the save replay, `close_group_content`, `get_recording_canvas`, the recording-limit check, `BYTES_PER_RECORDED_OP` made `pub(crate)`) |
| Build                  |                                                                 | `build.rs` (`EFFING_SOURCES`)                                                                                                                                                         |
| JS surface             | `extensions.js`, `extensions.d.ts`, `__test__/effing-*`         | `js-binding.js` (exports; hand-maintained, like `index.d.ts`)                                                                                                                         |
| Packaging              | `npm/*` (regenerated with `napi create-npm-dirs`)               | `package.json`, `.github/workflows/CI.yaml` (publish check)                                                                                                                           |

C symbols are prefixed `effing_`; C++ helpers live in `namespace effing`. The
napi bindings are functions that take the context as their first argument
rather than methods on it, which is what keeps `SKRSContext2D` identical to
upstream's.

`package.json` has an `exports` map, which upstream does not: Node's ESM
resolver only finds `@effing/skia/extensions` (no file extension) through
one. Its two wildcard entries keep every path that resolves in upstream
resolving here, with or without `.js`.

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

The other `textRendering` values behave as upstream. Skia caches shaped
text under a key that ignores hinting, so the fork marks its unhinted
paragraphs apart (`effing::make_unhinted`): measuring or drawing a text under
`auto` and under `geometricPrecision` gives each its own result, in either
order.

Upstream caps the deferred recording at 32 MiB and charges each draw with an
estimate of what it records; its text estimate is a text blob and the
typeface it keeps alive. Outline paths are larger, so the painter tallies
what it draws (path sizes, draw calls, and the typefaces of glyph-mask runs)
and the end of upstream's `draw_text` charges that tally on top
(`account_unsnapped_text`). The tally is per thread, which keeps upstream's
C signature unchanged.

## `Paragraph`

```ts
import { Paragraph, fillParagraph, strokeParagraph } from '@effing/skia/extensions'

const paragraph = new Paragraph('The quick brown fox…', {
  fontFamily: '"Inter", sans-serif',
  fontSize: 16,
  lineHeight: 24,
  textAlign: 'center',
  maxLines: 2,
  ellipsis: '…',
})
const layout = paragraph.layout(320) // { height, lines: [{ left, width, baseline, … }], … }
fillParagraph(ctx, paragraph, x, y) // top-left corner at (x, y)
strokeParagraph(ctx, paragraph, x, y)
```

A `Paragraph` is a single-style paragraph laid out natively by SkParagraph
(line breaking, shaping, bidi, font fallback), with effing's CSS line model on
top:

- Every line box is exactly `lineHeight` tall (`normal` is the primary font's
  hhea ascender + descender), and the baseline sits in the box by CSS
  half-leading. Fallback fonts never grow a line.
- `textAlign` is applied per line relative to the layout width. A line wider
  than the box is start-aligned and overflows the end edge, as in CSS, for
  every alignment. `justify` is Skia's, for wrapped text only: the lines of
  `noWrap` text all end at a hard break or the text, which CSS never
  justifies.
- `minIntrinsicWidth` is the widest word, or for `noWrap` text the widest
  line, as CSS min-content is.
- `noWrap` breaks only at hard breaks; with an `ellipsis` it truncates each
  line to the width instead. `maxLines` truncates with the `ellipsis` too.
  Without either, the `ellipsis` does nothing, as `text-overflow` doesn't on
  wrapped text.
- Glyphs are unhinted and painted unsnapped, exactly as `fillText` does under
  `geometricPrecision`; the two agree pixel for pixel.

`layout(width)` must be called before painting, which throws otherwise. It
returns the paragraph's
metrics and one entry per line: `left` and `baseline` from the paragraph's
top-left corner, the advance `width` without trailing whitespace, the range
of the line's text in UTF-16 units (JS string indices), and whether it ends
at a hard break.

`fillParagraph`/`strokeParagraph` use the context's current fill or stroke
style, line settings, shadow, filter, clip and transform, like `fillText`.
The style's own font settings are all a paragraph has; `ctx.font`,
`ctx.letterSpacing` and friends are ignored.

## Compositing groups: `beginGroup` / `endGroup`

```ts
import { beginGroup, endGroup } from '@effing/skia/extensions'

beginGroup(ctx, { opacity: 0.5, blendMode: 'multiply', filter: 'blur(2px)' })
// … any drawing on ctx …
endGroup(ctx)
```

Everything drawn between the two calls is composited as one when the group
ends, with the group's `opacity`, `blendMode` (a `globalCompositeOperation`
value) and CSS `filter`. That is what CSS `opacity`, `mix-blend-mode` and
`filter` mean on an element, and what per-draw `globalAlpha`,
`globalCompositeOperation` and `ctx.filter` cannot give once draws overlap.
`backdropFilter` starts the group from the filtered content behind it,
clamped at the edges like a browser does at the viewport edge, for CSS
`backdrop-filter`. `bounds` (`[x, y, width, height]` in the current
coordinate space) clips the group's content. A non-numeric `opacity`, an
unknown `blendMode` or malformed `bounds` throw; `opacity` outside 0 to 1 is
clamped.

On a raster canvas a group's offscreen buffer is sized to what it draws, so
a translucent element costs about as much as its own area, not the canvas's
(`src/page_recorder/effing.rs`): the group's draws are recorded on their own
and, when it ends, composited through a buffer the size of their bounds, as
Skia computes them for the recording (clips, stroke widths, shadows and
filters included). A group's filter still takes in what is drawn past the
clip or the canvas edge, as an up-front buffer would. The buffer covers the
canvas instead, as Skia sizes it, where it has to: with a `backdropFilter`,
which paints the backdrop across the whole buffer; with a `blendMode` that
changes what is behind the group where it draws nothing (`clear`, `copy`,
`source-in`, `source-out`, `destination-in`, `destination-atop`,
`modulate`); with a
filter whose output bounds Skia can't compute, or one under a rotation or
skew, where the filtered buffer is resampled and the result would depend on
where it starts; and on a PDF canvas.

A group that composites nothing (opacity 1, `source-over`, no filters) is a
plain save with the `bounds` clip, with no offscreen buffer. That is the only
kind of group an SVG canvas can hold, since Skia's SVG device has no layers;
`beginGroup` throws on one otherwise.

`beginGroup` saves the context state like `save()`, and `endGroup` restores
it like `restore()`. `endGroup` throws if the innermost save was not made by
`beginGroup`; a plain `restore()` closes a group as well. Reading the
canvas's pixels while a group is open (`getImageData`, encoding, drawing the
canvas into another) or writing them (`putImageData`) composites what the
group holds so far; the rest of the group is composited on its own when it
ends, with the same options but no backdrop filter, which the content behind
it already has. The deferred recording's 32 MiB cap (from upstream 1.0.10)
is suspended while a group that composites is open, so a group holding a
lot, such as a large photo, is not split; the recording is flushed once the
group ends. Until then everything the group draws stays in memory, so a
group left open across a long run of large images holds all of them.

This is deliberately not the proposed Canvas 2D `beginLayer`/`endLayer`: that
API takes the layer's alpha and blend mode from `globalAlpha` and
`globalCompositeOperation` and resets them inside the layer, while a group is
configured explicitly and leaves the state alone.

## Releasing

Versions are upstream's version with an `-effing.N` suffix, so the lineage
stays visible: `1.0.9-effing.1` is the first fork release on upstream 1.0.9,
and a rebase onto upstream 1.0.10 restarts at `1.0.10-effing.1`. Consumers
pin exact versions.

The package publishes from CI on a push to `main` whose commit message is
the bare version, the way upstream does. To cut a release:

```sh
# on main, with package.json's "version" set to the new version
yarn run version            # syncs npm/*/package.json, updates CHANGELOG.md, stages both
git commit -m "1.0.9-effing.1"
git push                    # CI builds, tests, then publishes
```

(`yarn run version` is the `version` script; plain `yarn version` is Yarn's
own command and does something else.) The publish job authenticates with
npm trusted publishing, the way upstream does: it holds no token, and npm
accepts the publish because each of the eight packages names the `CI.yaml`
workflow of `builtbyfew/effing-skia` as its trusted publisher. A package has
to exist before it can be given one, so a package for a new target needs a
first publish by hand, then
`npm trust github <package> --repo builtbyfew/effing-skia --file CI.yaml --allow-publish`
(npm 11.15 or later, logged in with 2FA); `npm trust list <package>` shows
what is configured. The platform packages under `npm/` are published first by
`napi prepublish`, which `prepublishOnly` runs. To semver an `-effing.N`
version is a prerelease, which npm 11 refuses to publish without a tag, so
the publish step sets `npm_config_tag=latest` in the environment; a
`--tag latest` flag would not reach the platform publishes.
`napi create-npm-dirs` leaves `icudtl.dat` out of the `files` of
`npm/win32-x64-msvc/package.json`; put it back after regenerating, or the
Windows package ships without ICU data and text shaping fails there.

The prebuilt Skia libraries still come from upstream's GitHub releases,
keyed on the `skia` submodule commit, so the fork never needs to build Skia
itself as long as the submodule matches an upstream release.

### Targets

The fork builds and publishes seven targets, the platforms effing supports
(the same set as `effing-ffmpeg-builds`, with both glibc and musl on Linux
because effing runs on Alpine and Debian images): Linux x64 and arm64 for gnu
and musl, macOS x64 and arm64, and Windows x64. Upstream's armv7, riscv64,
Android and Windows ARM64 targets are dropped from `napi.targets`, `npm/` and
the CI matrix.

## Changelog

Changes to the fork's public surface, for `@effing/canvas` to follow.

### 1.0.10-effing.2

- A group's offscreen buffer on a raster canvas is sized to what the group
  draws rather than to the canvas, with the exceptions listed under
  compositing groups. Ten translucent rows on a 1080x1080 frame went from
  about 4.8 ms to 0.5 ms, the same as passing `bounds`, and ten blurred rows
  from about 200 ms to 12 ms. `bounds` is no longer needed for speed, only
  to clip. Results are the same pixels, except that a group with a single
  draw may round differently by one level: 1.0.10-effing.1 folded such a
  group's opacity into the draw.
- The 32 MiB recording cap waits while a group that composites is open, so a
  large image inside a translucent, filtered or blended group no longer
  shows through what the group draws over it. 1.0.10-effing.1 split such a
  group once its content passed the cap.

### 1.0.10-effing.1

- Based on upstream 1.0.10: Skia chrome/m156, a use-after-free fix for
  `restore()` reviving a garbage-collected `CanvasPattern`, and a 32 MiB cap
  on the deferred recording, past which it is flushed to the surface.
- `fillParagraph` and `strokeParagraph` count toward that cap with what they
  record: the glyph outline paths, plus the typeface of any color or bitmap
  glyphs, which are drawn as text. So do `fillText` and `strokeText` under
  `geometricPrecision`, which upstream's estimate undercounts. A group open
  when the cap is reached is split as if the canvas had been read (see
  above).

### 1.0.9-effing.1

- Only seven targets are published: Linux x64 and arm64 (gnu and musl),
  macOS x64 and arm64, and Windows x64.
- The package is `@effing/skia`; the platform packages are
  `@effing/skia-<platform>`.
- Effing's additions moved to `@effing/skia/extensions` as functions taking
  the context: `beginGroup(ctx, options)`, `endGroup(ctx)`,
  `fillParagraph(ctx, paragraph, x, y)`, `strokeParagraph(ctx, paragraph, x, y)`,
  plus the `Paragraph` class. They are no longer methods on the context or
  exports of the main entry, whose types now match upstream's exactly.
- `beginLayer(options)` / `endLayer()` became `beginGroup` / `endGroup` with
  the same options. `endGroup` throws when the innermost save is not a group
  (it used to be a plain `restore()`).
- `ParagraphLine` no longer carries `ascent`, `descent` and `height`; they
  are constant across lines and live on `ParagraphLayout` as `ascent`,
  `descent` and `lineHeight`.
- `ParagraphStyle.fontStyle`, `textAlign` and `direction` reject invalid
  values instead of falling back to the default.
- `Paragraph` accepts text and an ellipsis containing U+0000 instead of
  throwing, like `fillText`.
- The `EFFING_GP_TEXT=mask` environment switch is gone; `geometricPrecision`
  always fills outlines.
- `fillParagraph` and `strokeParagraph` throw when the paragraph has not been
  laid out; that used to crash the process.
- `fillText`, `strokeText` and `measureText` under `geometricPrecision` no
  longer reuse the hinted layout of the same text and font from another
  `textRendering`, nor the other way round. Results used to depend on which
  was called first.
- A `Paragraph` line wider than the layout width is start-aligned, as in
  CSS; `center` and `right` used to give it a negative `left`.
- `Paragraph.layout().minIntrinsicWidth` of `noWrap` text is the widest
  line, no longer the widest word.
- `justify` lines start where `left` lines do; they used to sit half the
  `letterSpacing` to the right, past the width. On `noWrap` text, `justify`
  now paints exactly like `start`, with no half-pixel drift on multi-run RTL
  lines.
- `beginGroup` throws on a non-numeric `opacity` or malformed `bounds`
  instead of taking them as fully transparent or absent, and on an SVG canvas
  for a group that composites. A group that composites nothing no longer
  allocates a layer.
