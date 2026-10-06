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
| C++ bridge to Skia     | `skia-c/effing/{text,paragraph,word_break,group}.{hpp,cpp}`     | `skia-c/skia_c.cpp` (include + two `text_rendering` checks)                                                                                                                           |
| Rust wrappers          | `src/sk/effing.rs`, `src/sk/effing/{text,paragraph,group}.rs`   | `src/sk.rs` (`mod effing`)                                                                                                                                                            |
| Rust 2D context (napi) | `src/ctx/effing.rs`, `src/ctx/effing/{text,paragraph,group}.rs` | `src/ctx.rs` (`mod effing`, `save_with`, `group_saves`, `end_group_content`, `account_unsnapped_text`)                                                                                |
| Deferred recording     | `src/page_recorder/effing.rs` (groups in the recording)         | `src/page_recorder.rs` (`mod effing`, `groups`, the save replay, `close_group_content`, `get_recording_canvas`, the recording-limit check, `BYTES_PER_RECORDED_OP` made `pub(crate)`) |
| Build                  |                                                                 | `build.rs` (`EFFING_SOURCES`, `SK_RELEASE`)                                                                                                                                           |
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
  overflowWrap: 'break-word',
})
const layout = paragraph.layout(320) // { height, lines: [{ left, width, baseline, … }], … }
fillParagraph(ctx, paragraph, x, y) // top-left corner at (x, y)
strokeParagraph(ctx, paragraph, x, y)
```

A `Paragraph` is a single-style paragraph laid out natively by SkParagraph
(line breaking, shaping, bidi, font fallback), with effing's CSS line model on
top:

- Every line box is exactly `lineHeight` tall (`normal`, when it is omitted,
  is the primary font's hhea ascender + descender), and the baseline sits in
  the box by CSS half-leading. Fallback fonts never grow a line. A
  `lineHeight` of 0 collapses the line boxes, as CSS `line-height: 0` does:
  the paragraph is 0px tall and every line's baseline sits at
  `(ascent - descent) / 2`, the glyphs overflowing above and below.
- `textAlign` is applied per line relative to the layout width. A line wider
  than the box is start-aligned and overflows the end edge, as in CSS, for
  every alignment. `justify` is Skia's, for wrapped text only: the lines of
  `noWrap` text all end at a hard break or the text, which CSS never
  justifies. A justified paragraph laid out again, at any width, gets the
  lines a fresh one gets and paints as one does
  (`__test__/effing-paragraph-relayout.spec.ts`). SkParagraph would keep
  the last layout's justification in the lines it formats again at the
  same width, which then paint unjustified, and measure trailing spaces
  with it when it breaks them at a new width, so the fork breaks a
  justified paragraph's lines anew each time.
- `minIntrinsicWidth` is the widest word, or for `noWrap` text the widest
  line, as CSS min-content is.
- `maxIntrinsicWidth` is the widest line between hard breaks, its trailing
  whitespace hanging and, in wrapping text, the spaces and tabs that start
  it collapsed, unless whitespace is kept, as CSS max-content is
  (`__test__/effing-paragraph-metrics.spec.ts`). It is measured once, from
  the whole text, so neither the width nor the layouts before change it,
  and `maxLines` and the `ellipsis` leave it alone, as line clamping leaves
  Chrome's, except that `noWrap` text with an `ellipsis` is measured as it
  is laid out, a line at a time, and a line shaped on its own can come out
  wider or narrower (an RTL line with fallback fonts, by 14px in one
  case). It is rounded up to the 0.01px SkParagraph's line breaker tells
  apart, so the text laid out at it breaks only at hard breaks; under a
  negative `letterSpacing` it can be wider than the widest line, by what
  the breaker needs (a character with no advance of its own, such as a
  combining mark, has a negative width there). `noWrap` text with an
  `ellipsis` and `maxLines` shapes the hard lines it drops, once, to
  measure them, where it used to shape only the lines it shows: 2000
  dropped lines take about 14ms more on the first layout.
- `wordBreak` and `overflowWrap` say where lines may break within and around
  words (below).
- `noWrap` breaks only at hard breaks; with an `ellipsis` it truncates each
  line to the width instead. `maxLines` truncates with the `ellipsis` too.
  Without either, the `ellipsis` does nothing, as `text-overflow` doesn't on
  wrapped text.
- A truncated line keeps at least its first grapheme cluster (in `noWrap`
  text, with any spaces before it), with the `ellipsis` after it, both overflowing the line when
  not even they fit, as Chrome's `-webkit-line-clamp` and `text-overflow`
  do (`__test__/effing-paragraph-ellipsis.spec.ts`). SkParagraph would
  instead empty the line and drop the ellipsis, and, under `justify`, never
  return from laying out such a line when it has more than one run (a
  placeholder, a fallback font or another direction), or crash:
  `TextLine::createEllipsis` never tries keeping no cluster at all, and
  `TextLine::justify` then walks the runs of the emptied line over a cluster
  range that ends before it starts. So the fork lays out an ellipsized
  paragraph start-aligned first, justifies it only when no line was emptied,
  and lays an emptied line out anew, as a piece of its own, after the lines
  before it, which stay justified. Where this differs from Chrome:
  - Chrome aligns a clamped line by its own text, before it puts the
    ellipsis after that text and truncates the two to fit the width, so
    under `right` and `center` the ellipsis can end up past the end edge.
    `'ab\ncd'` with `maxLines: 1`, right-aligned at 100px, has "ab" at the
    right edge and the ellipsis after it, outside the box, where the
    `overflow: hidden` used with line clamping hides it, and
    `'aaaa bbbb cccc'` is "aaaa bbb…" from 10px to 110px. The fork aligns
    the line it shows, ellipsis included, and start-aligns it when it
    overflows, as it does any line: "ab…" from 60px to 100px and
    "aaaa bbb…" from 0 to 100px. Matching Chrome would put the ellipsis
    where Chrome hides it, and the fork clips nothing.
  - The cluster kept is the first in the text, which in a line of mixed
    directions need not be the one Chrome keeps, the first on screen.
  - A line of nothing but spaces keeps none of them: it is the ellipsis
    alone, at the line's start, where Chrome keeps the spaces before it.
    Wrapped text has such lines only with `keepTrailingWhitespace`, or from
    spaces that end the text after a hard break (below).
  - `text-overflow` clips the line, ellipsis included, to the box; the fork
    clips nothing, so a `noWrap` line's kept cluster and ellipsis show past
    the width, as a clamped line's do in Chrome.
- The hard breaks are SkParagraph's: LF, VT, FF, CRLF, LS (U+2028) and PS
  (U+2029). A lone CR and NEL (U+0085) are not breaks. Chrome's
  `white-space: pre` breaks at LF and CRLF only and draws VT, FF, LS and PS
  inline, so a caller after Chrome's result replaces those first.
- A lone CR, one not part of a CRLF, is laid out as nothing, as Chrome lays
  it out under `white-space: pre` and `pre-wrap`: no width and no glyph,
  where SkParagraph would draw the font's missing glyph, and no line-break
  opportunity beside it but after the spaces before it, so `'aaaa\rbbbb'`
  stays one line (`__test__/effing-paragraph-whitespace.spec.ts`).
  SkParagraph is given U+2063 INVISIBLE SEPARATOR in its place, which
  HarfBuzz hides and the line breaker takes for a letter. So the CR still
  takes `letterSpacing`, which Chrome doesn't add, and where a line breaks
  after spaces before it, the next line starts at the CR, where Chrome ends
  the first line after it; it shows nothing either way. Under
  `white-space: normal` Chrome makes a lone CR a space, collapsed with the
  spaces around it, which a caller after that does itself.
- A hard break that ends the text gives an empty last line, as SkParagraph
  lays it out: `'ab\n'` has two lines. That line starts and ends at the end
  of the text (`[3, 3)` here), after the break, whatever the break, as an
  empty line between two hard breaks starts after the first. Chrome gives
  `white-space: pre` text ending in a newline one line, so a caller that
  wants that drops the final break, or the last line.
- Whitespace at the end of a line hangs: it is left out of the line's width
  and alignment, as CSS does for `white-space: normal`. With
  `keepTrailingWhitespace`, spaces and tabs before a hard break or the end of
  the text count instead, as `white-space: pre` and `pre-wrap` keep them;
  spaces at a soft wrap still hang. The line then includes them in its
  `width` and `endIndex` and in `longestLine`, and is aligned and, when it
  overflows, start-aligned with them; in RTL they lie left of the text. This
  matches Chrome, which treats `pre` and `pre-wrap` alike here
  (`__test__/effing-paragraph-whitespace.spec.ts`), except that a tab is one
  space wide (SkParagraph replaces it), where Chrome advances to the next tab
  stop, and that whether an `ellipsis` truncates a line ignores its kept
  whitespace.
- Spaces and tabs that start a line, at the start of the text or after a
  hard break, collapse away, as `white-space: normal` and `pre-line` remove
  them: `'  ab'` is "ab" at the line's start, and `' cd ef'` at 25px is
  "cd" and "ef", with no line of its own for the space ("c…" with
  `maxLines: 1` and an ellipsis). The lines' `startIndex` is after them.
  With `keepTrailingWhitespace` they stay, as `pre-wrap` keeps them; so do
  spaces that end the text after a hard break, which SkParagraph puts on a
  line of their own, and those of `noWrap` text, which keeps all its spaces
  as `white-space: pre` does (CSS `nowrap` collapses them, so a caller after
  that collapses them itself). Such text is laid out in pieces, as below, a
  piece ending at the hard break before such spaces.
- Glyphs are unhinted and painted unsnapped, exactly as `fillText` does under
  `geometricPrecision`; the two agree pixel for pixel.

`layout(width)` must be called before painting, which throws otherwise. It
returns the paragraph's
metrics and one entry per line: `left` and `baseline` from the paragraph's
top-left corner, the advance `width` without trailing whitespace (unless
it is kept), the range of the line's text in UTF-16 units (JS string
indices), and whether it ends at a hard break.

`fillParagraph`/`strokeParagraph` use the context's current fill or stroke
style, line settings, shadow, filter, clip and transform, like `fillText`.
The style's own font settings are all a paragraph has; `ctx.font`,
`ctx.letterSpacing` and friends are ignored.

### Inline placeholders

```ts
const em = 20
const paragraph = new Paragraph(['Hello ', { width: em, height: em, lineBreak: 'emoji' }, ' world'], style)
const { placeholders } = paragraph.layout(320) // [{ x, y, width, height, line }]
fillParagraph(ctx, paragraph, x, y)
ctx.drawImage(emoji, x + placeholders[0].x, y + placeholders[0].y, em, em)
```

The text can be an array of strings and placeholders: inline boxes that take
their `width` on the line and draw nothing, for whatever the caller draws
there, such as emoji images. `layout()` returns one entry per
placeholder in `placeholders`, in order: its box from the paragraph's
top-left corner and its line, or `null` when `maxLines` or an ellipsis cut it
off. In the lines' `startIndex`/`endIndex`, each placeholder counts as one
UTF-16 unit, as if the text had U+FFFC in its place.

A placeholder's `lineBreak` says how lines break around it, as Chrome
breaks them (`__test__/effing-paragraph-placeholders.spec.ts`):

- `box`, the default, as around an inline-block or an image: on either side
  of it, even before the "!" after it, so `Hi [img]! ok` at 55px is
  `Hi [img] | ! ok`. A placeholder is a word of its own. (Chrome differs
  after a hyphen that follows the box, `[img]-|ab`, which ICU keeps
  together.)
- `emoji`, as around an emoji (UAX #14 class ID), for an emoji drawn in the
  box: between it and a letter, another placeholder or a space, but not
  between it and the punctuation that sticks to a word, so `Hi 🎉! ok`
  breaks as `Hi | 🎉! | ok` and `(🎉)` stays whole. SkParagraph's line
  breaker takes every placeholder for a word of its own and ends a line on
  either side of it wherever the line is full, so where it ends one beside
  an `emoji` placeholder at no opportunity, the text is laid out in pieces
  (below), the line ending at its last opportunity instead.

The two mix in a paragraph. SkParagraph's cache keys a paragraph on its
placeholders' sizes but not their `lineBreak`, so the strut's font families
carry a tag for the paragraphs with `emoji` ones.

Skia places a placeholder along its line; effing places it vertically by its
`verticalAlign`, the CSS `vertical-align` keywords, in effing's line box:
`baseline` (the default) puts the box's own baseline, `baselineOffset` below
its top (defaulting to its `height`: the bottom edge, as for an image), on
the line's baseline; `middle` puts its middle half the primary font's
x-height above the baseline; `top`/`bottom` align it with the line box; and
`text-top`/`text-bottom` with the primary font's hhea ascent/descent. These
match Chrome's inline-block placement (`__test__/effing-paragraph-placeholders.spec.ts`),
except that Chrome rounds the ascent and descent to whole pixels. A CSS
`vertical-align: <length>` is a `baselineOffset` of the box's height plus
that length. Letter spacing is not added to a placeholder, as Chrome doesn't
add it to an inline-block.

Unlike in CSS, a placeholder never grows its line box: lines stay exactly
`lineHeight` tall, as with fallback fonts, and a box taller than its place
in the line overflows it. So a tall box aligned `bottom` or `text-bottom`
can start above its line box, where CSS would grow the line to fit it.

Malformed content throws with a message naming the item and the field: a
missing or non-numeric `width` or `height`, a negative or non-finite size
(including one too large for the 32-bit float the layout uses), an unknown
`verticalAlign`, or an item that is not a string or a placeholder object.
`null` for `verticalAlign` or `baselineOffset` means the default.

### Word breaking

`wordBreak` and `overflowWrap` follow the CSS properties of the same name,
and default to `normal` as they do:

| Option         | Value        | Lines break                                                                                                                      |
| -------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `wordBreak`    | `normal`     | between words                                                                                                                    |
|                | `break-all`  | between any two letters or digits too                                                                                            |
|                | `keep-all`   | never between two letters where one is CJK                                                                                       |
| `overflowWrap` | `normal`     | a word wider than the line sits on a line of its own and overflows it                                                            |
|                | `break-word` | such a word starts a line of its own and is broken between grapheme clusters where the line is full, the text after it following |

A word is what lies between two line-break opportunities: ICU's, which also
break after hyphens and between CJK characters, as `wordBreak` adjusts them.
Around an `emoji` placeholder they are an emoji's (above), so `🎉!` is
one word; a `box` placeholder is a word of its own.
`minIntrinsicWidth` is the widest word, measured from SkParagraph's
clusters, so a single letter under `break-all` and a run of CJK under
`keep-all`. `overflowWrap: 'break-word'` leaves it
alone, as CSS `overflow-wrap: break-word` does. CSS's deprecated
`word-break: break-word` is `overflowWrap: 'break-word'` here; Chrome gives
it, as `overflow-wrap: anywhere`, a single letter as its min-content.

How:

- `break-all` and `keep-all` hand SkParagraph their own line-break
  opportunities through the SkUnicode it is built with (`word_break.cpp`):
  ICU's, with every letter taken for an ideograph under `break-all`, so that
  punctuation stays with its letter as it does next to an ideograph, and
  without those between two letters where one is CJK under `keep-all`.
  Emoji are not letters. Characters are classified by probing ICU's line
  breaker, since SkUnicode doesn't expose line-breaking classes.
- SkParagraph breaks a word that doesn't fit wherever the line ends, inside
  grapheme clusters too. So at a width where some word doesn't fit, layout
  splits the text into pieces, each a paragraph of its own laid out once
  (`split_around_long_words` in `paragraph.cpp`): under `normal`, the text
  before the word, the word with the spaces after it, laid out at the
  unbounded width, and the text after it; under `break-word`, a piece from
  each such word on, in which a line may also break between any two
  grapheme clusters of that word. A grapheme cluster wider than the line
  overflows it whole. The pieces are painted on effing's lines like the
  whole paragraph, and `layout` at the width it last laid out at returns at
  once. A layout at another width reuses the pieces it can, already shaped,
  and under `maxLines` a piece holds no more text than its lines can show,
  so a long text clamped to a few lines lays out in about the time an
  unsplit one does. The first layout of a split paragraph shapes its text
  twice, as a whole and in pieces. As with SkParagraph, the empty line after
  a hard break that ends the text shows if there is room and is not one of
  the lines `maxLines` counts.
- Each piece takes the bidi levels its text has in the whole paragraph,
  through its SkUnicode, rather than resolving them anew: on its own, a
  placeholder, punctuation or digits at its start or end would take the
  paragraph's direction instead of that of the text around them, and land
  on the other side of an Arabic word in an LTR paragraph, say. A piece
  that ends at a soft break gets a placeholder after it that no line has
  room for, and only the lines before that, so that its last line is
  justified like any line that isn't the paragraph's last.
- With `emoji` placeholders, where SkParagraph may end a line beside one at
  no opportunity, the text is laid out a window of about eight lines at a
  time: a piece ends at the last opportunity of such a line, or else
  before the window's last line, and the next piece starts there. The work
  then grows with the text, rather than with its square, as laying out all
  the text after each such line again would.
- SkParagraph caches the opportunities with the shaped text, under a key
  that leaves them out, so the strut's font families carry a tag for each
  set of them. SkParagraph also leaves out of its cache a paragraph whose
  first or last 40 bytes are those of the last one it cached (it takes it
  for text being edited), so laying out the same long text under two modes
  in turn shapes it anew each time.

The tests in `__test__/effing-word-break.spec.ts` hold Chrome's line breaks.
Known differences from Chrome:

- A line ending inside a word, or between CJK characters, can differ in
  width by the kerning between the two characters at the break, which
  Chrome drops and Skia keeps (0.4px in the tests).
- `break-all` follows CSS Text, which treats letters as ideographs; Chrome
  departs from that around some punctuation (it also breaks before `-` and
  `|` and after `+`, which the fork follows, and not after `–`, which it
  doesn't), and breaks Devanagari conjuncts (स्|ते) where ICU's grapheme
  clusters keep them whole. Around punctuation, ICU's and Chrome's
  opportunities differ anyway, in every mode.
- With `maxLines` and an `ellipsis`, the last line is that line's own text
  with the ellipsis after it, as Chrome's `-webkit-line-clamp` shows it,
  whether the lines run out at a soft break, a word too wide for its line or
  a hard break: without the spaces that hang at its end (unless
  `keepTrailingWhitespace` keeps them, as `pre-wrap` does), and where the
  two don't fit, with grapheme clusters taken off its end until they do
  ("aaaa bbb…", "ab …", "Overlong…"). An empty line is the ellipsis alone.
  Such a paragraph is laid out in pieces: SkParagraph would fill the last
  line with the start of the text after it ("ab cd e…" for Chrome's "ab
  cd…") and leave a line that ends at a hard break without the ellipsis.

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

### Unreleased

- A lone CR is laid out as nothing, as Chrome lays it out under
  `white-space: pre` and `pre-wrap`: it used to be drawn as the font's
  missing glyph (a box 15px wide at 20px in Liberation Sans) and be a
  line-break opportunity. `'a\rb'` now measures and paints as `'ab'`, and
  `'aaaa\rbbbb'` stays on one line. A CRLF is still a hard break.
- With `keepTrailingWhitespace`, the last line `maxLines` shows with an
  `ellipsis` ends before a CRLF that ends it, as before an LF: it used to
  keep the CR as trailing whitespace, drawn as the font's missing glyph
  before the ellipsis where the font maps none to it, and in its
  `endIndex` (`'ab\r\ncd'` was `[0, 3)`, now `[0, 2)`, "ab…").

### 1.0.10-effing.4

- `ParagraphPlaceholder.lineBreak`: `'box'` (the default) breaks lines
  around the placeholder as before, as Chrome does around an inline-block
  or an image, on either side even before a "!"; `'emoji'` breaks them as
  Chrome does around an emoji, keeping the placeholder with the punctuation
  next to it, so `Hi 🎉! ok` breaks as `Hi | 🎉! | ok`, not `Hi 🎉 | ! ok`,
  and `(🎉)` stays whole. `@effing/canvas` should pass `lineBreak: 'emoji'`
  for the emoji it lays out as placeholders. `minIntrinsicWidth` counts an
  emoji placeholder and its punctuation as one word.
- When `maxLines` cuts wrapping text off at a hard break, the last line
  shown has the `ellipsis` after it, as Chrome's `-webkit-line-clamp` has
  it: `'ab\ncd'` with `maxLines: 1` is "ab…", no longer "ab", and an empty
  last line is "…". Text split around a word too wide for the line already
  did this.
- The last line `maxLines` shows with an `ellipsis` is that line's own text
  with the ellipsis after it, cut to fit, as Chrome's line clamp has it: it
  used to take in the start of the next line's text (`'ab cd efgh ij'` at
  95px is "ab cd…", not "ab cd e…"), and to keep a hanging space before the
  ellipsis (`'aaaa bb cccc'` at 100px is "aaaa bb…", not "aaaa bb …").
- **Breaking:** spaces and tabs that start a line of wrapping text, at the
  start of the text or after a hard break, collapse away unless
  `keepTrailingWhitespace` is set, as CSS `white-space: normal` has it:
  `' cd ef'` at 25px no longer starts with a line of its own for the space
  (with `maxLines: 1` and an ellipsis it is "c…", not "…"), and
  `'ab\n  cd'` starts its second line at "cd". Such a line's `startIndex`
  is now after the spaces. A caller that passes leading spaces it wants
  kept sets `keepTrailingWhitespace`; `noWrap` text keeps them anyway.
- Text laid out in pieces (around a word too wide for the line, say) keeps
  the bidi levels it has as a whole: a placeholder, punctuation or digits
  at the edge of a piece used to take the paragraph's direction, and land
  on the wrong side of the Arabic or Hebrew around them. The line before a
  word too wide for the line is now justified under `justify`.
- `maxIntrinsicWidth` is CSS max-content: the widest line between hard
  breaks, trailing whitespace hanging and, in wrapping text, leading spaces
  and tabs collapsed (as the layout collapses them), unless whitespace is
  kept, measured once from the whole text and rounded up to 0.01px. It used
  to be SkParagraph's sum
  of the lines broken at the last layout's width, trailing whitespace
  included, so it changed with the width and, where a word too wide for its
  line split the text, kept an earlier layout's figure, by up to hundreds of
  px. `minIntrinsicWidth` of `noWrap` text, which is the same figure,
  follows. `maxLines` and the `ellipsis` leave it alone, except that
  `noWrap` text with an `ellipsis`, laid out a line at a time, is measured
  as its lines shape on their own. `noWrap` text with an `ellipsis` and
  `maxLines` shapes the lines past `maxLines` once to measure them, which
  costs its first layout about 14ms for 2000 dropped lines.
- With an `ellipsis`, only the line SkParagraph ellipsized is measured by its
  painted runs, to include the ellipsis. Every line was, so a line whose run
  ends past it, as an RTL line ending in a zero-width space does under a
  negative `letterSpacing`, came out wider than without the ellipsis.
- The empty last line after a hard break that ends the text starts and ends
  at the end of the text, `[length, length)`, for every kind of hard break.
  It used to cover the break's last unit, `[length - 1, length)`, except in
  `noWrap` text with an `ellipsis`.
- `noWrap` text with an `ellipsis` and `maxLines` counts its lines as other
  text does: the empty line after a hard break that ends the text no longer
  sets `didExceedMaxLines`, and an empty first line that is all `maxLines`
  keeps is a line (it used to leave the paragraph with none).

### 1.0.10-effing.3

- `new Paragraph(text, style)` takes an array of strings and placeholders
  (`{ width, height, verticalAlign?, baselineOffset? }`) as its text, and
  `layout()` returns where each placeholder went in `placeholders`. A plain
  string works as before; `layout()` then returns `placeholders: []`.
- `ParagraphStyle.keepTrailingWhitespace` counts spaces and tabs before a
  hard break or the end of the text in the line's width and alignment, for
  `white-space: pre` and `pre-wrap`.
- **Breaking:** `lineHeight: 0` collapses the line boxes instead of meaning
  `normal`. Pass `undefined` (or omit it, or pass `null`) for `normal`;
  `@effing/canvas`'s `lineHeight ?? 0` must become `lineHeight`. A negative
  or non-finite `lineHeight`, or one too large for a 32-bit float, throws
  instead of meaning `normal`.
- A `fontSize` that is not a finite number > 0, a non-finite
  `letterSpacing`, and a negative, NaN or fractional `maxLines` throw. They
  used to give NaN metrics, nonsense, or (for a negative `maxLines`) no
  limit. `maxLines` of `Infinity`, like 0 or omitted, is still unlimited.
- A lone CR and NEL are no longer hard breaks for `noWrap` text with an
  `ellipsis`, matching the rest of the paragraph and SkParagraph.
- `ParagraphStyle.wordBreak` (`normal`, `break-all` or `keep-all`) and
  `ParagraphStyle.overflowWrap` (`normal` or `break-word`), as the CSS
  properties; see word breaking under `Paragraph`.
- **Breaking:** a word wider than the line overflows it on a line of its
  own, as CSS's default `overflow-wrap: normal` has it; it used to be broken
  mid-way. `overflowWrap: 'break-word'` breaks it, but only after starting it
  on a line of its own (it used to be broken right after the words before
  it), and only between grapheme clusters.
- `minIntrinsicWidth` is the widest word, measured from SkParagraph's
  clusters, where Skia's figure was off: for text without spaces that fits
  on a line (it was the whole text), and for a word at the end of the text
  that doesn't fit the line (it was short by its last letter).
- The bridge is compiled with `SK_RELEASE`, as Skia is. Under `SK_DEBUG` it
  saw classes such as `FontCollection`, `SkTextBlob` and the typefaces at
  other sizes than Skia was built with.
- `layout()` no longer hangs (or crashes) on a justified paragraph with an
  `ellipsis` whose last line SkParagraph could not ellipsize, because not
  even its first cluster fits beside the ellipsis. Such a line, wrapped or
  `noWrap`, now keeps its first grapheme cluster with the ellipsis after
  it, both overflowing, as Chrome's line clamp has it; it used to come out
  empty, without the ellipsis.
- A justified paragraph laid out again, at any width, gets the line widths
  of a fresh one and paints as one does. It used to keep the previous
  layout's justification in its line widths, which moved RTL lines.

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
