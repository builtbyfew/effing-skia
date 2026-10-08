# Effing extensions

`@effing/skia` is effing's fork of [`@napi-rs/canvas`](https://github.com/napi-rs/canvas).
The main entry is a drop-in for upstream: same classes, same context, same
types. Effing's additions live in a separate entry, `@effing/skia/extensions`,
so that swapping the backend later only touches the code that imports it.
Some behaviours are changed: text rendering under
`textRendering = 'geometricPrecision'`, only behind that opt-in; registered
fonts taking precedence over system fonts of the same family (see registered
fonts over system fonts); and CSS filters, `drop-shadow()`'s blur among them,
read and drawn as in Chrome (see filtered draws).

```ts
import { createCanvas } from '@effing/skia' // upstream's API, unchanged
import { beginGroup, endGroup, Paragraph, fillParagraph } from '@effing/skia/extensions'
```

## Where the code lives

Fork code is kept out of upstream files so that upstream merges stay trivial.
Each layer has an `effing` directory with one file per feature, and each
upstream file has at most a few marked hook lines.

| Layer                  | Fork code                                                                              | Upstream hooks                                                                                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C++ bridge to Skia     | `skia-c/effing/{text,paragraph,justify,word_break,group,filter_layer,fonts}.{hpp,cpp}` | `skia-c/skia_c.cpp` (include + four `text_rendering` checks, the face `setAlias` takes), `skia-c/skia_c.hpp` (include, `RegisteredFont::shadowable_names`, the font provider's `onMatchFamily` and `onCreateStyleSet`, `shadowable_faces` and system flag, the `setAlias` replay, the asset font manager) |
| Rust wrappers          | `src/sk/effing.rs`, `src/sk/effing/{text,paragraph,group,filter_layer,fonts}.rs`       | `src/sk.rs` (`mod effing`)                                                                                                                                                                                                                                                                                |
| Rust 2D context (napi) | `src/ctx/effing.rs`, `src/ctx/effing/{text,paragraph,group,filter_layer}.rs`           | `src/ctx.rs` (`mod effing`, `save_with`, `group_saves`, `end_group_content`, `account_unsnapped_text`, `draw_fitted_filter_layer`), `src/filter.rs` (`drop-shadow()`, filter lists)                                                                                                                       |
| Global fonts (napi)    | `src/global_fonts/effing.rs` (`loadSystemFontsFromDir`, `fontRevision`)                | `src/global_fonts.rs` (`mod effing`, `load_fonts_from_dir`'s `system`), `src/font.rs` (any `font-weight`)                                                                                                                                                                                                 |
| Deferred recording     | `src/page_recorder/effing.rs` (groups in the recording)                                | `src/page_recorder.rs` (`mod effing`, `groups`, the save replay, `close_group_content`, `get_recording_canvas`, the recording-limit check, `BYTES_PER_RECORDED_OP` made `pub(crate)`)                                                                                                                     |
| Build                  |                                                                                        | `build.rs` (`EFFING_SOURCES`, `SK_RELEASE`)                                                                                                                                                                                                                                                               |
| JS surface             | `extensions.js`, `extensions.d.ts`, `__test__/effing-*`                                | `js-binding.js` (exports; hand-maintained, like `index.d.ts`), `index.js` (system font directories)                                                                                                                                                                                                       |
| Packaging              | `npm/*` (regenerated with `napi create-npm-dirs`)                                      | `package.json`, `.github/workflows/CI.yaml` (publish check)                                                                                                                                                                                                                                               |

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

Under `geometricPrecision`, `fillText`, `strokeText` and `measureText` lay
the text out at the font size floored to 1/100px, as Chrome's canvas does,
to the nearest 1/64px, as a `Paragraph` does (see the font size under
`Paragraph`): at 17.3px the text is as wide as at 17.29px. The other `textRendering` values keep
upstream's exact size.

Under `geometricPrecision`, `fillText`, `strokeText` and `measureText` also
leave out the letter spacing Chrome doesn't add, after default-ignorable code
points, as a `Paragraph` does (see letter spacing under `Paragraph`).

The text's `measureText` bounding box (`actualBoundingBoxLeft` and
`actualBoundingBoxRight`) is upstream's, which counts SkParagraph's
half-letter-spacing shift of the line twice. Text that starts with such a
code point has no shift, so at a letter spacing of 10px `'ab'` has an
`actualBoundingBoxLeft` of 10 and `'\u200Bab'` one of 0, and their
`actualBoundingBoxRight` differs by 5, though the two paint the same ink:
the change moves upstream's error rather than adding one. The `width` is
right in both.

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

- Every line box is exactly `lineHeight` tall, and the baseline sits in the
  box by CSS half-leading as Chrome computes it. `normal`, when it is
  omitted, is Chrome's `line-height: normal` (on macOS, where CoreText
  reads hhea): the primary font's hhea ascent, descent and line gap each
  rounded to whole pixels and summed, with the baseline the rounded ascent
  plus half the rounded gap, floored, below the line's top. Fallback fonts never
  grow a line. A `lineHeight` of 0 collapses the line boxes, as CSS
  `line-height: 0` does: the paragraph is 0px tall and the glyphs of every
  line overflow it above and below.
- The half-leading is Chrome's (Blink's `CalculateLeadingSpace`): the
  ascent and descent are rounded to whole pixels, the leading is the line
  height less their sum, and the half above the text is floored to whole
  pixels, the odd pixel and any fraction going below, also when the
  leading is negative. So a line's baseline sits
  `round(ascent) + floor((lineHeight - round(ascent) - round(descent)) / 2)`
  below its top, always a whole pixel. `lineHeight` itself is rounded to
  the 1/64px Chrome lays out in (`ParagraphLayout.lineHeight` reports it
  so: 33.3 is 33.296875), so the lines of a fractional line height stack
  as Chrome's do. For Liberation Sans at 20px (ascent 18.1, descent 4.24)
  that's 22 in a 30px line, 22 in a 30.5px one (the next line's at 52.5),
  and 7 for a line height of 0, where the half-leading of the unrounded
  metrics put it at 21.93 and 6.93, as measured in Chrome 154.
  `__test__/effing-paragraph-half-leading.spec.ts` checks the baselines
  Chrome gives five of the fonts in `__test__/fonts` at 9 sizes and 13 line
  heights (585 cases, including 0, smaller than the text, and fractional),
  the 1/64px rounding, and `normal` for all 17 fonts there and two with a
  line gap set (152 cases).
- The layout reports the primary font's hhea `ascent`, `descent` and
  `lineGap` in px at the font size, for the caller's own line boxes.
  `lineGap` is 0 for a negative gap, as Chrome takes it; `normal` is
  `round(ascent) + round(descent) + round(lineGap)`. They come from
  the hhea table even when the font sets `USE_TYPO_METRICS`, where FreeType's
  `SkFontMetrics` would give the OS/2 typo values (Iosevka Slab: a hhea gap
  of 68 units, a typo gap of 0). They are the primary font's, the first of
  `fontFamily` there is, whatever the text, so an empty paragraph or one of
  placeholders only reports them too. A font without a hhea table falls back
  to `SkFontMetrics` (`fLeading` for the gap).
- The text is laid out at the font size Chrome lays it out at: `fontSize`
  floored to 1/100px, in float arithmetic, as Blink's
  `FontDescription::EffectiveFontSize` computes it, so 17.3 (17.2999992 as
  a float, which times 100 is 1729.99988) is 17.29, 17.305 is 17.30 and
  13.333 is 13.33. A size that floors to 0 keeps its size. The metrics
  above, the line boxes and the advances are those of that size: Noto Sans
  Devanagari at 17.3px has an ascent of 15.49, which rounds to 15, so its
  lines are 22px with the baseline at 15, as in Chrome, where the exact
  size gave 15.50, 23px lines and a baseline at 16.
  `__test__/effing-font-size.spec.ts` checks Chrome's line height and
  baseline at the 188 sizes from 8 to 40px where the floor changes them in
  five fonts. Where the fork still differs from Chrome:
  - Chrome caches a face's font data under `unsigned(size × 100)`, which for
    some floored sizes is the 1/100px below (17.30 × 100 is 1729.99988 in
    float), so in a page that used 17.29 first it lays 17.30 out at 17.29,
    and the other way round. The fork takes the floored size, as Chrome
    does with a face it hasn't used at the size below.
  - Skia's FreeType takes a size in 1/64px, truncated, and lays the glyphs
    out at that size, where Chrome on macOS, effing's reference, takes them
    from CoreText at the floored size exactly. So the fork gives Skia the
    floored size to the nearest 1/64px (`effing::freetype_font_size`), whose
    advances and outlines come closest to CoreText's; the metrics above, the
    x-height and the line boxes are the floored size's. Noto Sans
    Devanagari text Chrome measures 78.7732px wide at 17.3px (17.29) is
    78.8042px here (17.296875). Over 16 fonts at 26 fractional sizes, the
    widths are 0.041px off Chrome's on average and 0.14px at most, where
    the exact size truncated to 1/64px was 0.053px and 0.27px off (0.063px
    and 0.27px for the floored size truncated). Chrome on Linux, which
    uses FreeType too, truncates as plain FreeType does, so the fork's
    widths are a little further from its own.
  - A metric within 0.0001px below a half pixel can round the other way:
    Chrome rounds Noto Sans Devanagari's descent at 37.99px, 15.49992, up
    to 16 (3 of the 622 sizes measured).
- `textAlign` is applied per line relative to the layout width. A line wider
  than the box is start-aligned and overflows the end edge, as in CSS, for
  every alignment. `justify` is for wrapped text only: the lines of
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
  measure them, where it used to shape only the lines it shows (2000
  dropped lines take about 14ms more on the first layout), and the last
  line it keeps once more, without the `ellipsis` it ends with.
- `wordBreak` and `overflowWrap` say where lines may break within and around
  words (below).
- `noWrap` breaks only at hard breaks; with an `ellipsis` it truncates each
  line to the width instead. `maxLines` truncates with the `ellipsis` too.
  Without either, the `ellipsis` does nothing, as `text-overflow` doesn't on
  wrapped text. In `noWrap` text, the last line `maxLines` keeps has the
  `ellipsis` after its text whenever lines are dropped after it, as Chrome's
  `-webkit-line-clamp` has it under `white-space: pre`, truncated with it to
  fit the width: `'ab\ncd'` with `maxLines: 1` is "ab…", and `'\ncd'` "…".
  The spaces and tabs that end the line stay before the ellipsis with
  `keepTrailingWhitespace` ("ab …" for `'ab  \ncd'`, as under `pre`), and
  hang without it ("ab…", as under `pre-line` with `nowrap`).
- A truncated line keeps at least its first grapheme cluster (in `noWrap`
  text, with any spaces before it), with the `ellipsis` after it, both overflowing the line when
  not even they fit, as Chrome's `-webkit-line-clamp` and `text-overflow`
  do (`__test__/effing-paragraph-ellipsis.spec.ts`). SkParagraph would
  instead empty the line and drop the ellipsis: `TextLine::createEllipsis`
  never tries keeping no cluster at all. So the fork lays an emptied line
  out anew, as a piece of its own, after the lines before it, which stay
  justified, and justifies a layout only when no line was emptied. Where
  this differs from Chrome:
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
  - SkParagraph takes grapheme clusters off the end of the line's text, in
    logical order, until the ellipsis fits. Chrome truncates the line on
    screen, at the ellipsis, so where an LTR line ends in an RTL word the
    two keep different parts of that word: `'ab بتثبتث بتث'` clamped to one
    line at 70px shows "ab بتثبت…" here, and more of the word in Chrome.
  - Under `justify`, Chrome justifies the clamped line as it laid it out
    before truncating it, the ellipsis taking the place of what it cut
    ("dd ee …" spread over the width); the fork start-aligns it, as a line
    ending in the ellipsis.
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
- A lone CR, one not part of a CRLF, is laid out as Chrome lays it out
  under `white-space: pre` and `pre-wrap`
  (`__test__/effing-paragraph-whitespace.spec.ts`): it has no width and no
  glyph, where SkParagraph would draw the font's missing glyph; it gives no
  line-break opportunity beside it but after the spaces before it, so
  `'aaaa\rbbbb'` stays one line; the text on either side of it is shaped
  apart, so it doesn't kern, ligate or join across it (`'A\rV'` is wider
  than `'AV'`, and Arabic letters on either side take the forms they take
  next to a break); and it takes part in bidi as a paragraph separator,
  which ends the runs of weak and neutral characters before it
  (`'اد 12\r34 رو'` in LTR is "12 دا" and then "34 ور"). SkParagraph is
  given U+2063 INVISIBLE SEPARATOR in its place, which HarfBuzz hides and
  the line breaker takes for a letter, in a text style of its own (shaped
  in the language `zxx`) so that its shaper ends a run at it, and with bidi
  levels resolved from the text with the CR, the U+2063 taking those of the
  character before it. As U+2063 is default-ignorable, it takes no
  `letterSpacing`, as Chrome adds none after a CR. Where a line breaks
  after spaces before it, the next line starts at the CR, where Chrome
  ends the first line after it; it shows nothing either way. Each lone CR
  is a text style of its own, which SkParagraph's shaper walks once per
  style, so text with thousands of them lays out much more slowly (4000
  lone CRs: 87ms instead of 0.8ms). Under `white-space: normal`,
  `pre-line` and `nowrap`, Chrome makes a lone CR a space (`'a\rb'` is a
  space wider than `'ab'`), collapsed with the spaces around it, which a
  caller after that replaces and collapses itself.
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
- `letterSpacing` follows each character, as in Chrome, except the ones
  Chrome adds none after (below).
- A line that starts after the space it wraps at carries no kerning against
  that space, as in Chrome (below).
- A line that breaks at a soft hyphen (U+00AD) ends with a hyphen, as CSS
  `hyphens: manual`, the default, has it (below).
- Under `justify`, a line spreads at Chrome's justification opportunities
  (below).

#### Kerning at a line's start

A font's legacy `kern` table, which HarfBuzz applies when the font has no
GPOS kerning, can kern a space with the letter after it: Liberation Sans
has space+A at -1.104px at 20px, and space+T and space+Y at -0.361px.
HarfBuzz puts half of such a pair on each glyph, so where a line starts at
the letter, the line kept the letter's half: `'OVER THE'` at 70px had a
second line of 39.82px, where "THE" is 40px. Chrome shapes a line's text
anew from its start where the break is not safe to break for HarfBuzz, so
the letter has no kerning there, and lines break by that width too
(`__test__/effing-paragraph-kerning.spec.ts`). So does the fork: such a
line starts a piece of its own (see word breaking), built from its text on.
A word that fits a line only with the kerning overflows it, as in Chrome.
`minIntrinsicWidth` keeps the kerning, as Chrome's min-content does.

The fork finds such letters by the offset HarfBuzz gives the second glyph of
a pair it kerns that way, which is the letter in LTR and the space in RTL.
Text laid out in pieces lays out more slowly: 1000 words of English in
Liberation Sans at 300px (167 lines) take about 2.7ms to lay out first
instead of 1.6ms, and 0.9ms instead of 0.25ms again at another width.
Where the fork still differs from Chrome:

- Chrome shapes anew from a line's start up to where the text is safe to
  break again, which can run to its end: a line of `'AT'`, whose A and T
  are kerned too, then has no kerning against the space after it either,
  and is 24.08px wide in Chrome and 23.89px here.
- Under `textAlign` `center`, `right` and `justify`, Chrome shapes a line's
  end anew too, without the space after it, which the fork doesn't: a line
  that ends in "T" before a space is 0.19px wider in Chrome. Start-aligned,
  both keep that kerning.
- GPOS kerning puts a pair's adjustment on its first glyph, which is the
  space in LTR and hangs with it, but the letter in RTL, which the fork
  doesn't find.

#### Soft hyphens

A soft hyphen draws nothing, unless a line breaks at it: the line then ends
with a hyphen, measured and drawn, as Chrome draws it
(`__test__/effing-paragraph-soft-hyphen.spec.ts`). It is U+2010 where the
primary font has that, and "-" otherwise, shaped on its own: it doesn't kern
with the letter before it and takes no `letterSpacing`. The line's text, its
`endIndex`, ends after the soft hyphen, and its `width` takes in the hyphen,
which it is aligned and justified with. A line breaks at a soft hyphen when
its text and the hyphen fit, at the last opportunity before it otherwise,
and overflows with the hyphen when it has none. Spaces between the soft
hyphen and where the line breaks hang after the hyphen, as in Chrome, but a
soft hyphen before a hard break or at the end of the text gets none. A line
clamped by `maxLines` keeps its hyphen before the `ellipsis`
("cali‐…"). `minIntrinsicWidth` takes the hyphen in after a word that ends
at a soft hyphen, as Chrome's min-content does. Under `overflowWrap:
'break-word'`, a word never breaks before a soft hyphen, as UAX #14 has it
and Chrome does. There is no `hyphens: none`, where Chrome doesn't break at
soft hyphens at all: a caller after that drops them from the text.

HarfBuzz kerns across a soft hyphen, and with a font's legacy `kern` table
puts half of a pair on the letter after it. The line after a soft hyphen
it breaks at is laid out from its own text, as Chrome shapes it anew, so it
has no such kerning, and a word after a soft hyphen that fits a line only
with it overflows the line unbroken (`'ab A\u00ADVAVAVA'` at 72px, as in
Chrome). Chrome shapes such a line anew up to where the text is safe to
break again, which in a word whose pairs are all kerned is its end, so it
also drops the kerning against the space after it: its "VAVAVA" is 72.63px,
the fork's 72.07px, as with a kerned letter after a space.

SkParagraph would break lines at soft hyphens without the hyphen. So text
that has a line break at one is laid out in pieces (below): a line that
breaks at a soft hyphen is a piece of its own, its text with the hyphen
after it, in a text style of its own. Each such line is shaped twice, once
to see whether it fits, as Chrome reshapes a line it hyphenates, which can
be wider than its text measured in the paragraph: kerning between the last
letter and the one after the soft hyphen is gone. A paragraph of 1000 words
with a soft hyphen between every two syllables (193 lines) takes about 9ms
to lay out first instead of 2.3ms, and 5ms instead of 0.2ms to lay out
again at another width; 100 such words, 1.3ms and 0.2ms instead of 1.6ms
and 0.02ms.

#### Letter spacing

Chrome adds no letter spacing after a character it takes for a zero-width
space: a default-ignorable code point (ZWSP, ZWJ, ZWNJ, WJ, U+FEFF, the bidi
controls, the variation selectors, a soft hyphen, ...), U+FFFC, and a
carriage return. Neither does the fork (`__test__/effing-letter-spacing.spec.ts`):
`'a\u200Bb'` is as wide as `'ab'`, and the NBSP and ZWSP `@effing/canvas`
draws for a line or paragraph separator get one gap between them and the
next letter, not two. SkParagraph spaces every glyph, these zero-width ones
included, so the fork gives such code points a text style of their own
without letter spacing. A style that differs only there doesn't split
SkParagraph's shaping runs: ZWJ still makes emoji sequences, half forms and
Arabic joins, and ZWNJ still breaks them.

Where the fork still differs from Chrome, as before:

- Chrome spaces a cluster (HarfBuzz's, which keeps a mark with its letter and
  an emoji sequence together) once, after its last glyph; SkParagraph spaces
  each glyph of a cluster. So a cluster of several glyphs gets more: a
  combining mark with no precomposed form (`'q\u0301'`), a Devanagari vowel
  sign (`'कि'`, `'स्ते'`), and an emoji sequence with a variation selector
  inside, such as ❤️‍🔥 or a keycap, whose selector is a hidden glyph of the
  sequence. An emoji sequence the font draws as one glyph, a family say,
  gets one gap, as in Chrome, in LTR text and in an RTL run of a strong RTL
  script.
- In an RTL paragraph, a run of neutral characters such as emoji or symbols
  takes the paragraph's level, and HarfBuzz merges each base with the ZWJ or
  variation selector after it into one cluster when it reverses the run.
  SkParagraph looks a cluster's style up at its start, the base, so the
  ignorable's own style doesn't apply and it is spaced as on `main`: with
  `direction: 'rtl'`, `'❤️'` gets 2 gaps where Chrome has 1, `'+\uFE0F+'`
  3 where Chrome has 2, and `'👨‍👩'` 3. The other way round, a merged
  cluster that starts with the ZWJ or selector, as in a contrived
  `'a\u200D👩'` in RTL, goes without its base's spacing, so it gets fewer
  gaps than on `main` and than in Chrome.
- Chrome tests the first UTF-16 unit of a cluster, so a code point past the
  BMP that starts one, default-ignorable or not (U+E0001), is spaced in
  both. Chrome's canvas spaces TAG SPACE (U+E0020) but not CANCEL TAG
  (U+E007F); the fork's `fillText` spaces neither of the two.
- A paragraph with letter spacing and many such code points lays out more
  slowly, since SkParagraph looks each cluster's style up from the first
  one: with a ZWSP between each two of 1000 words, a layout takes 4.6ms
  instead of 0.9ms, and with 4000 words 77ms instead of 3.6ms. Calling
  `layout()` again on the same `Paragraph` is cheap, as its text isn't
  shaped again, but SkParagraph's cache doesn't always spare a new one with
  the same text: it leaves out a text of 40 or more characters whose first
  or last 40 are those of the last text it cached
  (`ParagraphCache::isPossiblyTextEditing`), so two long captions that
  share their start or end, laid out in turn each frame, are shaped anew
  every time.

#### Justification

Under `justify`, each line that ends at a soft break spreads over the width
as Chrome spreads it under `text-align: justify` (and `text-justify: auto`,
Blink's `JustificationContext` and `ShapeResultSpacing`;
`__test__/effing-paragraph-justify.spec.ts`). The paragraph's last line, a
line before a hard break and a clamped line ending in the ellipsis stay
start-aligned.

- A line expands at its justification opportunities, each by an equal share
  of the space it lacks: after each space, tab and no-break space (U+00A0),
  and after each CJK character, and before one too unless the character
  before it has an opportunity after it. The CJK characters are Blink's
  (`IsCjkIdeographOrSymbol`): ideographs, radicals and strokes, kana,
  bopomofo, the CJK Symbols and Punctuation block (the ideographic space
  and `、。「」` included), the halfwidth and fullwidth forms, enclosed and
  compatibility CJK, a list of symbols CJK text uses, and emoji (the
  Emoji_Presentation characters, and the pictographs of emoji ZWJ and
  modifier sequences, such as ♀ and ❤). Hangul isn't, so Korean spreads at
  its spaces alone, as Arabic does.
- The line's last character, before the spaces that hang, has no
  opportunity after it: a no-break space or an ideograph that ends a line
  gets nothing, and a line whose only opportunity is that one is
  start-aligned, as is any line with none. A no-break space that starts a
  line (which doesn't collapse) gets its share.
- No other character is an opportunity: not the other space separators (the
  en, em and thin spaces, U+202F, U+2007, ...), whose width stays as it is,
  nor a default-ignorable character such as a ZWSP, which leaves the
  opportunity before it where it is: a ZWSP between two ideographs makes no
  second gap.
- An en space, or another space separator but the ideographic space, that
  ends a line counts in the line's width, as in Chrome, where SkParagraph
  lets it hang as it lets spaces hang; the ideographic space hangs in both.
- Letter spacing goes first; justification spreads what is left.

SkParagraph's own justification (`TextLine::justify`) spreads a line at its
spaces and Unicode ideographs alone, so a line whose words are joined by
no-break spaces stayed start-aligned (`'aaa\u00A0bb\u00A0c\u00A0dddd eeeeeee'`
at 200px in Liberation Sans 20px had "dddd" at 82.31 where Chrome has it at
155.5), and kana, CJK punctuation and fullwidth forms took no share (a
placeholder after "ひらがなと" at 175px in Source Han Serif Bold 20px was at
100, Chrome's 103.13). It also gave every gap between words the same width,
the spaces in it included, where Chrome adds the same to each space, and
spread a line at its en spaces. So SkParagraph only breaks the lines: the
fork lays them out start-aligned and justifies them itself, writing the
state SkParagraph's justification leaves (the shifts of each cluster, which
SkParagraph paints and measures with, and the line's width).

Where the fork still differs from Chrome:

- Chrome trims the spacing of fullwidth punctuation next to other
  punctuation (`text-spacing-trim: normal`: a closing bracket before a
  comma is half its width), which the fork doesn't, so CJK lines with such
  pairs break and spread differently. With `text-spacing-trim: space-all`
  they agree.
- An ideograph right before a placeholder moves right by its share, where
  Chrome puts the share after it, since SkParagraph places a placeholder by
  the advances before it, which a cluster's shift doesn't change. The
  placeholder is where Chrome has it.
- Chrome counts a line's opportunities in the order of its text, backwards
  in an RTL paragraph; the fork walks the line on screen. The two agree on
  a line of one direction; on a line of both, which side of a CJK character
  next to a run of the other direction has the opportunity can differ.
- An en space that doesn't fit at the end of a line goes to the next line in
  Chrome, with the word before it; SkParagraph lets it hang.

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
`text-top`/`text-bottom` with the primary font's hhea ascent/descent,
rounded to whole pixels as Chrome rounds them. These match Chrome's
inline-block placement (`__test__/effing-paragraph-placeholders.spec.ts`). A CSS
`vertical-align: <length>` is a `baselineOffset` of the box's height plus
that length. Letter spacing is not added to a placeholder, as Chrome doesn't
add it to an inline-block.

Along the line, placeholders are ordered by their bidi levels, as Chrome
orders inline-blocks (UAX #9): a placeholder is a neutral (U+FFFC), so one
between right-to-left words is right-to-left, and the first of two such
placeholders lies right of the second. SkParagraph orders a line's runs by
their levels too, but then deals its placeholders out to the places it gave
placeholders from the left, in the order they were added (Flutter's API has
no way to say that bidi moved one). Effing puts each line's runs back in
the order their levels give before the line is justified
(`order_placeholders` in `skia-c/effing/paragraph.cpp`). That sets
SkParagraph's private run order (`TextLine::fRunsInVisualOrder`), so a Skia
upgrade should check that `TextLine`'s constructor still orders runs that
way.

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

## Filtered draws

A draw under `ctx.filter`, and the shadow of one or of a drawn image, which
is cast through an image filter, goes through a layer opened at the device
identity, so that the filter's lengths are device pixels (upstream's
`composited_filter_layer`). Upstream opens it without bounds, so Skia sizes
it to the clip and the filter runs over the whole canvas for one line of
text. The fork records the draw first and gives the layer what it draws as
bounds (`src/ctx/effing/filter_layer.rs`): five `fillText` calls under
`blur(12px)` on a 1080x1080 canvas take about 32 ms instead of 132 ms, as
with upstream 1.0.0, which had no such layer, or with a clip around the
text. Skia still sizes the layer to what the filter needs to fill the clip,
so a blur keeps taking in what is drawn past the clip or the canvas edge.

The pixels are those of the canvas-sized layer, up to rounding: where the
layer starts moves the rounding of what is drawn into it and of the filter,
by up to 4 levels in a few pixels, mostly under a scale, rotation or skew.
One case moves whole rows or columns: an image drawn with
`imageSmoothingEnabled = false` and scaled to a fractional position, where a
pixel center can fall exactly between two source pixels and either is the
nearest. A different start can pick the other one, so a filtered
`drawImage(img, 20.5, 10.5, 110, 80)` of a 64x48 image can show a few rows
or columns of the neighbouring source pixels, off by up to about 100 levels.
Both are valid nearest picks, and a group's content-sized buffer picks the
same way.

The layer covers the clip as before for a blend mode or a filter that
changes what is behind it where it is transparent (`clear`, `modulate`, a
filter that affects transparent black), under a singular transform, and for
content that covers the clip, such as a background, which a bounded layer
would not make faster.

The blur length of `drop-shadow(dx dy blur color)`, in `ctx.filter` and in a
group's `filter` or `backdropFilter`, is the Gaussian's standard deviation,
as the Filter Effects spec defines it and as `blur()` takes it
(`src/filter.rs`). Upstream halves it, the rule for `shadowBlur`, whose
standard deviation the canvas spec does define as half its value and which is
left as it is. `drop-shadow(0 0 4px)` draws its shadow as `blur(4px)` does,
the pixels Chrome's canvas draws for it.

A filter list is read closer to how Chrome's canvas reads it than upstream
does. A transparent `drop-shadow()` is skipped, and the rest of the list
applies; upstream dropped the whole list for it and for `drop-shadow(0 0 0)`,
which is kept: its shadow, unblurred and unshifted, shows where the content
is translucent. `drop-shadow()` takes its colour before or after the
lengths, in `rgb()`, `hsl()`, `hwb()`, hex, a name or `transparent`.
Function names and units are case-insensitive, numbers take an exponent
(`blur(4e1px)`), an omitted argument takes its default (`blur()` is
`blur(0)`, `grayscale()` is `grayscale(1)`), and the end of the value
closes a function left open (`blur(4px`). What Chrome rejects makes the
value invalid, so `ctx.filter` keeps its previous value and a group's filter
is none: a negative amount or blur length (`opacity(-1)`, `blur(-1px)`,
`drop-shadow(0 0 -2px red)`), a unitless angle other than 0
(`hue-rotate(90)`), a number ending in a dot (`blur(4.px)`), anything but
CSS whitespace (space, tab, line feed, carriage return, form feed) between
or around functions, such as U+00A0, and a `drop-shadow()` with a colour it
cannot read, a fourth length or anything else in it. Upstream clamped
amounts, read `hue-rotate(90)` as `hue-rotate(0)`, dropped the whole list
for a negative blur, drew a shadow it could not read in black, rejected
exponents outside `drop-shadow()` and took any Unicode space.

Where it still differs from Chrome:

- A value that overflows f32 (`opacity(1e40)`, `blur(1e38in)`) is invalid;
  Chrome clamps it.
- `drop-shadow(1e30px 0 red)` draws the content without its shadow, where
  Chrome draws nothing.
- `drop-shadow()` rejects `lab()`, `lch()`, `oklab()`, `oklch()` and
  `color()` colours, which the rest of the context doesn't take either, and
  `hsl()` with unitless saturation and lightness (`hsl(120 100 25)`).
- `em` and `rem` are 16px, not relative to the context's font, and the other
  font- and viewport-relative units (`ex`, `ch`, `vw`, `vh`, `vmin`, ...)
  are rejected, as is `calc()`.
- Comments (`blur(/* */ 4px)`) are not read, except inside `drop-shadow()`.
- Outside `drop-shadow()`, whitespace between a number and its unit or `%`
  is accepted (`blur(4 px)`, `opacity(50 %)`, `hue-rotate(90 deg)`), as
  upstream's tests require.

## Registered fonts over system fonts

A family registered with `GlobalFonts` (`register`, `registerFromPath`,
`loadFontsFromDir`, `setAlias`) takes precedence over the system's family of
the same name, as an `@font-face` family does over a locally installed one in
a browser (`__test__/effing-font-precedence.spec.ts`). That holds wherever a
family name is resolved: `ctx.font` for `fillText`, `strokeText` and
`measureText`, a `Paragraph`, each family of a `font-family` list, and SVG
text. The system's fonts are the ones `index.js` loads at startup:
`GlobalFonts.loadSystemFonts()` (the system font directory) and the user's
font directories (`~/Library/Fonts`, `~/.fonts`, ...), which it loads with
`loadSystemFontsFromDir` from `js-binding.js` instead of `loadFontsFromDir`.

Upstream puts the system's fonts and the registered ones in one
`TypefaceFontProvider`, the font manager SkParagraph's `FontCollection` asks
first. A face registered under a family name the system has joined the
system's faces in one style set, after them, and
`SkFontStyleSet::matchStyleCSS3` keeps the first of equally good matches, so
the system's face won every style the system had. In `node:22-bookworm` with
`fonts-liberation`, the Liberation Sans 1.x woff `@effing/canvas` bundles,
registered as "Liberation Sans", laid out the "A" of `'A A'` broken after it
12.236px wide, the system TTF's kerning, rather than its own 12.788px; under
an alias of its own it was 12.788px. The fork marks the faces that join a
family without shadowing it (`effing::ShadowableFaces`, with the names in
`RegisteredFont::shadowable_names`, which the rebuild that
`GlobalFonts.remove` does replays), and the provider's family lookup (`onMatchFamily`, which
every lookup above goes through) leaves them out of a family that has
registered faces.

- A registered family replaces the system's family of that name whole, not
  style by style, as `@font-face` does: CSS font matching takes the faces of
  a family defined by `@font-face` rules from those rules alone. A style it
  lacks is synthesized from its own faces (SkParagraph emboldens a face
  200 or more lighter than a requested 600 or heavier, and slants an upright
  face for italic), as a browser synthesizes it, rather than taken from the
  system's family: Liberation Sans registered in regular alone draws bold
  text as an emboldened regular even where the system has Liberation Sans
  Bold. Taking the system's bold would mix two versions of a font in one
  text and make the result depend on the machine's fonts, which registering
  a font is meant to rule out.
- The order of registering and loading the system's fonts doesn't matter.
- Among the registered faces of a family, the first registered of equally
  good matches still wins, where a browser takes the last `@font-face` rule.
- A font registered under an alias is a registered face of the alias's
  family only. Under its own family name, where `GlobalFonts` adds it too,
  it joins the family as a system font does, without shadowing it:
  registering Inter Bold as "Heading" on a machine with Inter installed
  leaves "Inter" the installed family, the registered bold among its faces.
  A font registered again under its own family name, a system font from its
  path or a font first registered under an alias, is a registered face there
  from then on, and shadows the rest of the family.
- `setAlias(family, alias)` names the face `family` resolves to in the
  default style when it is called, as upstream's does: a registered face of
  `alias`, which shadows a system family of that name, also when the face
  is already one of that family's shadowable faces: `setAlias('Heading',
'Inter')` after registering Inter Bold as "Heading" makes "Inter" that
  bold. It keeps that face
  when `family` later resolves to another, as when a font is registered
  under `family`, and also after the rebuild `GlobalFonts.remove` does,
  where upstream matched `family` anew. The mapping goes when the fonts of
  `family` are removed, as before.
- Family names match case-sensitively, as upstream's always have: a font
  registered as "liberation sans" doesn't shadow "Liberation Sans".
- `GlobalFonts.families` lists the styles a family resolves to: for a family
  with registered faces, those faces alone.
- `GlobalFonts.loadFontsFromDir` registers the fonts it loads, as before, so
  they shadow the system's fonts.
- Fallback for characters no family of the list has is unchanged: it comes
  from the system font directory's font manager, whichever fonts are
  registered.

## Font matching

A family's face for a style is the one CSS font matching picks
([CSS Fonts 4 §5.2](https://drafts.csswg.org/css-fonts-4/#font-style-matching))
as Chrome implements it, wherever a family is resolved: `ctx.font` for `fillText`,
`strokeText` and `measureText`, a `Paragraph`, each family of a
`font-family` list, SVG text, and the default style `setAlias` takes, for
registered and system families alike (`__test__/effing-font-matching.spec.ts`),
among the faces the fork loads, every face of a font collection included
(see font collections).
Of a family's faces it narrows down by one property after the other, each
checked in CSS's order:

1. font-stretch: the desired width, then, at or below normal, narrower
   widths nearest first and then wider ones nearest first; above normal,
   wider widths first, then narrower ones.
2. font-style: `italic` and `oblique` take slanted faces, italic or
   oblique, then upright ones; `normal` takes upright faces, then slanted
   ones. An italic face and an oblique one are the same slope, as in Chrome,
   where `italic` is `oblique 14deg`, the angle `oblique` has without one,
   and the weight decides between them: of a 700 oblique and a 400 italic
   face, italic at 700 takes the oblique one. CSS Fonts 4 would check italic
   faces before oblique ones for italic, and the other way round otherwise.
3. font-weight: the desired weight, then, from 400 to 500, heavier weights
   up to 500 nearest first, then lighter ones nearest first, then those
   above 500 nearest first (so 400 takes 500 before 300, and 500 takes 400
   before 600); below 400, lighter weights nearest first, then heavier ones;
   above 500, heavier weights nearest first, then lighter ones.

A style the face lacks is then synthesized, as before: SkParagraph
emboldens a face 200 or more lighter than a requested 600 or heavier, and
slants a face that isn't italic for italic. Bold italic in a family of a
regular, a bold and an italic face is the italic face emboldened, as in
Chrome. In Liberation Sans of those three faces at 20px, bold italic in a
200px box lays out lines 178.97, 172.29, 158.96, 186.77 and 42.25 wide
(Chrome's 178.98, 172.30, 158.97, 186.78 and 42.25), where it took the bold
face, slanted: 194.45, 185.62, 170.05, 143.34 and 107.77, broken elsewhere.

Upstream matches with Skia's `SkFontStyleSet::matchStyleCSS3`, which scores
the three properties in one number, eight bits apart, while a weight scores
up to 1000, so the weight spills into the style. For 700 italic it scored
the bold 1·256 + 1000 = 1256 and the italic 3·256 + 400 = 1168, and took
the bold. For the same reason it took an italic over a bold for a normal
style in a family with no regular face, and an upright bold over an oblique
face for an italic. Above normal width its stretch score also ranked a
wider face over one of the desired width. The fork's font provider and the
system font directory's font manager hand out their families as style sets
whose `matchStyle` is `effing::match_css` (`effing::with_css_matching`).

- Of equally good faces the first registered wins, as before, where Chrome
  takes the last `@font-face` rule.
- A face is oblique where its OS/2 table says so (`fsSelection` bit 9),
  which few fonts do. SkParagraph slants any face that isn't italic for
  italic, an oblique one too, and none for oblique, where Chrome slants an
  upright face for either and a slanted one for neither.
- `ctx.font` takes any weight from 1 to 1000, as CSS Fonts 4 and Chrome's
  canvas do (`550 20px X`, `725`, `550.5`, `1e3`), and a weight outside
  that range (`0`, `1001`), or a number CSS doesn't read (`550.`), makes
  the value invalid: the assignment throws, as upstream's does for any value
  it can't read, and the font stays as it was, where Chrome ignores it.
  `550 20px X` used to be a 550px font of the family "20px X". A
  `Paragraph` takes any weight too. SVG's `font-weight` still takes weights
  in hundreds only: Skia's SVG module reads it, into an enum of the nine.
- A variable font is one face, of its default instance's style; its axes
  don't follow the requested weight or width, and its named instances are
  not faces of their own, where CoreText lists those of a system font.
- Fallback for characters no family of the list has is unchanged.
- Lottie text keeps Skia's matching: `skiac_skottie_animation_make` gives
  Skottie a font manager of its own, which isn't wrapped.

### Font collections

A font collection (`.ttc`, `.otc`, or a WOFF2 of one) is every face in it,
wherever a font file is loaded: `loadSystemFonts()` and the user font
directories `index.js` loads, `loadFontsFromDir` (which now takes `.otc`
files too), `register` and `registerFromPath` (`effing::more_faces`). Each
face joins its own family, as CoreText and Chrome have it, and the names a
collection is registered under: `registerFromPath('Helvetica.ttc',
'Heading')` makes all six faces of Helvetica faces of "Heading". A
collection is one registered font, under one key: `remove` removes every
face of it, and the `setAlias` mappings of each face's family, as it does
those of a font's own family. The rebuild `remove` does registers every
face of the other collections again as it was, a system face shadowable,
reusing the faces after the first rather than opening the file again. A
family registered under the name of a collection's family shadows every
face of it there (see registered fonts over system fonts). A system
collection registered again from its path, or a collection registered
under the name of one of its faces' families, is a registered font of
each of its families from then on, every face of it, as a single font is
of its own family.

Upstream registered the first face of a collection alone, so `Helvetica.ttc`
was a family of one regular face, and every weight and style of Helvetica,
Helvetica Neue, Avenir Next or Didot was that face, emboldened or slanted.
With the system's collections loaded whole, the face `ctx.font` takes for
each of 18 styles (100 to 900, normal and italic) of 48 families on macOS 26
is the one Chrome 154's canvas draws in 698 of 864 cases, from 342 before;
all of Didot (192.68px for "The quick brown fox" at 20px at 600 to 900,
172.86px italic), Helvetica, Optima, Futura and Gill Sans among them. Most
of the rest are faces whose OS/2 table says something other than CoreText,
which Chrome on macOS goes by: the italic faces of Avenir Next Condensed,
Avenir Next UltraLight Italic and Helvetica Neue's Thin Italic and Medium
Italic aren't flagged italic, CoreText ranks Avenir's Heavy and Black the
other way round from their OS/2 weights, and weighs Hiragino Sans's faces
from W3 up differently from theirs. Families without Latin letters (Damascus, Kailasa,
Arial Hebrew) draw them in another fallback font than Chrome, collection or
not.

Loading every face costs `loadSystemFonts()` about 10ms more on macOS 26
(about 75ms instead of 65ms for 372 files, 128 of them collections, which
give 792 faces instead of 375), and memory: the process's RSS after it is
118MB instead of 72MB. Each `GlobalFonts.remove` still adds about 25MB, as
before, since its rebuild opens only the first face of each font again and
keeps the old provider alive. A file is told to be a collection by its
first eight bytes, so other fonts are opened no further than before.

## Font revision

```ts
import { GlobalFonts } from '@effing/skia'
import { fontRevision } from '@effing/skia/extensions'

const revision = fontRevision() // a whole number
GlobalFonts.registerFromPath('Inter.ttf')
fontRevision() > revision // true
```

`fontRevision()` is the revision of the fonts `GlobalFonts` holds: a number
that grows with every call that changes them, for keying caches of results
that depend on what a family name resolves to (`__test__/effing-font-revision.spec.ts`).
A cache keyed on it needs no wrapping of `GlobalFonts`'s methods, which
would miss a mutator added later. These change it:

- `register` and `registerFromPath` that return a key, a font collection
  or a font already registered too (which can still change the names it is
  registered under);
- `setAlias` that returns `true`;
- `remove`, `removeBatch` and `removeAll` that remove a font, and with them
  the rebuild of the collection they do;
- `loadFontsFromDir`, `loadSystemFonts()` and `loadSystemFontsFromDir`, at
  every font they load, including the system fonts `index.js` loads at
  startup.

Reads don't change it: `families`, `has`, `getVariationAxes`, measuring,
laying out and drawing text. Nor does a call that fails (returns `null`,
`false` or 0), or `loadSystemFonts()` after its first call. A call that
succeeds but turns out to change nothing may still bump it: registering the
same buffer or path again, `loadFontsFromDir` of the same directory again
(once per file), or repeating a `setAlias`. For a cache key that is harmless,
a needless miss and never a stale hit. It is upstream's generation
counter for the font collection, which the deferred recording keys the
typefaces it charges for on, read atomically without the collection's lock: about 11ns a call on an
Apple M-series Mac, where `GlobalFonts.families`, which lists every family,
takes 0.3ms with the 381 families there. It starts at 0 in each process and
only grows, by one or more at each change (by one at each font
`loadSystemFonts()` loads, so it is in the hundreds after startup).

It is a function in `@effing/skia/extensions` rather than a property of
`GlobalFonts`, so that `GlobalFonts` and its type stay upstream's.

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

- `fontRevision()` in `@effing/skia/extensions` is a number that grows with
  every change to the fonts `GlobalFonts` holds (`register`,
  `registerFromPath`, `remove`, `removeBatch`, `removeAll`, `setAlias`,
  `loadFontsFromDir`, `loadSystemFonts`), and not with reads, cheap enough
  to read per layout (see font revision). `@effing/canvas` can key its
  font-dependent caches on it rather than wrapping those methods.
  `index.d.ts` now declares `GlobalFonts.loadSystemFonts()`, which `index.js`
  calls and which was missing from it.
- Under `justify`, lines spread at Chrome's justification opportunities
  (see justification): a no-break space counts as a space does, CJK text
  spreads around its kana, bopomofo, CJK symbols and punctuation,
  fullwidth forms and emoji too, not only around its ideographs (Hangul
  spreads at spaces alone, as in Chrome), each space gets
  the same share, where SkParagraph gave every gap between words the same
  width, and en spaces and other space separators get none. In Liberation
  Sans 20px, `'aaa\u00A0bb\u00A0c\u00A0dddd eeeeeee'` at 200px now has "dddd"
  at 155.5, as in Chrome, where its first line was start-aligned with
  "dddd" at 82.31. Justified text with such characters lays out
  differently.
- A `Paragraph`, and `fillText`, `strokeText` and `measureText` under
  `geometricPrecision`, lay text out at the font size floored to 1/100px,
  as Chrome does: 17.3 is 17.29. A paragraph's `ascent`, `descent`,
  `lineGap`, `normal` line height and baselines are those of that size,
  which changes them where the exact size rounded the other way: Noto Sans
  Devanagari at 17.3px has 22px lines with the baseline at 15, as in
  Chrome, where it had 23px lines with the baseline at 16. The glyphs are
  laid out at that size to the nearest 1/64px, which Skia's FreeType takes
  sizes in and used to truncate to, so widths at a fractional size change,
  closer to Chrome's on macOS: 0.041px off on average in the cases
  measured, where they were 0.053px off.
- A font collection (`.ttc`, `.otc`) loads every face in it, for
  `loadSystemFonts()`, the user font directories, `loadFontsFromDir`,
  `register` and `registerFromPath`, where only its first face loaded: on
  macOS, Helvetica, Helvetica Neue, Avenir Next, Didot and the other system
  families in collections now have their weights and italics, as in Chrome,
  rather than one face emboldened or slanted (Didot bold, "The quick brown
  fox" at 20px, is 192.68px wide, Chrome's, where it was 187.34). Each face
  joins its own family and every name the file is registered under, and
  `GlobalFonts.remove` of the file's key removes all of them.
  `GlobalFonts.families` lists more styles (792 instead of 375 on macOS 26),
  and `loadSystemFonts()` takes about 10ms and 46MB more there (RSS 118MB
  instead of 72MB). `loadFontsFromDir` loads `.otc` files too.
- `ctx.font` takes any `font-weight` from 1 to 1000 (`550 20px X`), as
  Chrome does; it read `550 20px X` as a 550px font of the family "20px X".
  A weight outside that range (`0`, `1001`) makes the value invalid, so the
  assignment throws, as for any value `ctx.font` can't read.
- A family's face for a style is the one CSS font matching picks: of the
  faces nearest in font-stretch, those nearest in font-style, and of those
  the one nearest in font-weight (see font matching). Bold italic in a
  family with regular, bold and italic faces but no bold italic face is now
  the italic face emboldened, as in Chrome, where it was the bold face
  slanted: in Liberation Sans at 20px, a 200px paragraph of
  `@effing/canvas`'s "bold italic with no such face" fixture lays out lines
  178.97, 172.29, 158.96, 186.77 and 42.25 wide, Chrome's widths, where they
  were 194.45, 185.62, 170.05, 143.34 and 107.77 and broke elsewhere. That
  fixture's known difference should go. A normal style in a family with a
  bold and an italic face but no regular is now the bold, also for the
  face `setAlias` takes, an italic in a family of an oblique face and an
  upright bold the oblique face, italic and oblique faces the same slope,
  as in Chrome, so that the weight decides between them (italic at 700 in
  a family of a 400 italic and a 700 oblique face is the oblique one), and
  a width above normal the face of that
  width where a wider one was there too. Text set in a style a family has
  no face for can lay out differently.
- `drop-shadow()` in `ctx.filter` and in a group's filters blurs with its
  blur length as the standard deviation, as `blur()` does and as in Chrome,
  where it used to blur with half of it: drop shadows are twice as blurry as
  before, and `drop-shadow(6px 8px 12px black)` now draws what Chrome draws
  for it, not what Chrome draws for `drop-shadow(6px 8px 6px black)`. To keep
  the old look, halve the blur length. `shadowBlur` is unchanged.
- A filter list with a transparent `drop-shadow()` or `drop-shadow(0 0 0)`
  in it applies the rest of the list, as in Chrome, where it used to apply
  none of it: `drop-shadow(0 0 transparent) grayscale(1)` now draws in gray.
- Filter values Chrome rejects are invalid: the assignment to `ctx.filter`
  is ignored and a group's filter is none. That covers a negative amount or
  blur length (`opacity(-1)` used to draw nothing, and `blur(-1px)` to drop
  the whole list), `hue-rotate(90)` (read as `hue-rotate(0)`), and a
  `drop-shadow()` whose colour can't be read (`nosuchcolor`), with a fourth
  length or with anything else in it (drawn in black). A value that
  overflows f32 (`opacity(1e40)`) is invalid too, where Chrome clamps it.
- Filter values Chrome accepts that were rejected now apply:
  `drop-shadow(red 4px 4px)` with the colour first, `hsl()`, `hsla()` and
  `hwb()` shadow colours, upper-case function names and units
  (`BLUR(4PX)`), exponents (`blur(4e1px)`), omitted arguments (`blur()`,
  `grayscale()`), and a function
  the end of the value leaves open (`blur(4px`). Filter values with U+00A0
  or another non-CSS space between functions, or a number ending in a dot
  (`blur(4.px)`), are now invalid, as in Chrome.
- A `Paragraph` places its baselines by Chrome's half-leading: from the
  ascent and descent rounded to whole pixels, the half of the leading above
  the text floored to whole pixels. They used to split the leading of the
  unrounded metrics evenly, which put them off Chrome's by up to 1.28px in
  the cases measured (Noto Sans Devanagari at 16px in an 18.75px line:
  13.28 for Chrome's 12). The baseline now always sits a whole number of
  pixels below its line's top. `lineHeight` is rounded to 1/64px, Chrome's
  layout unit, and `ParagraphLayout.lineHeight` and `height` report it so
  (33.3 is 33.296875). `text-top` and `text-bottom` placeholders align with
  the rounded ascent and descent, as in Chrome.
- An omitted (or null) `lineHeight` is now Chrome's `line-height: normal`,
  `round(ascent) + round(descent) + round(lineGap)`: whole pixels, and with
  the line gap, where it used to be the unrounded `ascent + descent`
  without it. Iosevka Slab at 20px has 25px lines with the baseline at 20,
  as in Chrome, where it had 23.64px lines with the baseline at 19.54.
- `@effing/canvas` works out the paragraph's baseline itself, as
  `(lineHeight + ascent - descent) / 2`, to shift a `normal` line box to
  Chrome's. It should take `lines[i].baseline` instead (or this rule, for
  an empty paragraph): the `normal` line height it passes then gets
  Chrome's baseline with no shift. Its text-box-trim, which goes from the
  baseline and the unrounded ascent, and its mock paragraph, which mirrors
  the old formula, need the same change.
- A `Paragraph` line that starts after the space it wraps at carries no
  kerning against that space, as in Chrome: with a font's legacy `kern`
  table, HarfBuzz put half of a space+letter pair on the letter, which the
  line kept. In Liberation Sans 20px, `'OVER THE'` at 70px has a second line
  of 40px, as "THE" alone, not 39.82px, and `'Over Away Yes Tea'` at 60px
  has "Away" at 48.55px, not 47.99px. Lines break by those widths, as in
  Chrome, so a few now break earlier, and the text of such a line is drawn
  as it is alone, its first letter up to half a kerning pair to the right.
  Text with such a line is laid out in pieces, more slowly (see kerning at
  a line's start).
- A `Paragraph` line that breaks at a soft hyphen (U+00AD) ends with a
  hyphen, as Chrome draws it under `hyphens: manual`: U+2010, or "-" where
  the primary font has none, measured, drawn, aligned and justified with the
  line. Such a line used to end with nothing, a hyphen's width short of
  Chrome's (Liberation Sans 20px at 130px: `'super\u00ADcali\u00ADfragilistic'`
  was 80.04px and 77.79px, now 86.72px, with the hyphen, and 77.79px), and
  lines broke at soft hyphens where only their text fitted. A line clamped
  by `maxLines` keeps its hyphen before the `ellipsis`, and
  `minIntrinsicWidth` takes it in after a word that ends at a soft hyphen.
  Text with such a line is laid out in pieces, more slowly (see soft
  hyphens).
- A draw under `ctx.filter`, and the shadow of one or of a drawn image, goes
  through a layer the size of what it draws rather than of the canvas. Five
  lines of text under `blur(12px)` on a 1080x1080 canvas went from about
  132 ms to 32 ms, and 200 small blurred squares from about 4 s to 11 ms.
  Results are the same pixels up to rounding, which can move a few pixels by
  a level or so, mostly under a scale, rotation or skew, and, for an image
  drawn with `imageSmoothingEnabled = false` at a fractional scale and
  position, can pick the neighbouring source row or column where two are
  equally near (see filtered draws).
- A family registered with `GlobalFonts` (`register`, `registerFromPath`,
  `loadFontsFromDir`, `setAlias`) now replaces the system's family of the
  same name whole, in every style, as `@font-face` does in a browser. Styles
  you don't register are synthesized from the ones you do (bold from a
  regular, italic by slanting), not taken from the installed font: register
  every style you use. `GlobalFonts.families` lists only the registered
  styles of such a family. A font registered under an alias shadows only the
  alias's family; under its own family name it joins the installed family
  without replacing it. Fonts from `loadFontsFromDir` count as registered;
  only `loadSystemFonts()` and the user font directories loaded at startup
  are system fonts. Family names match case-sensitively, as before. In
  `node:22-bookworm` with `fonts-liberation`, the Liberation Sans woff
  `@effing/canvas` bundles, registered as "Liberation Sans", lays out the
  "A" of `'A A'` broken after it 12.788px wide, its own width, where it took
  the system TTF's 12.236px.
- `setAlias` keeps the face it took after a `GlobalFonts.remove`, which used
  to match the aliased family anew.
- Placeholders between right-to-left words are ordered as in Chrome, by
  their bidi levels: the first of two lies right of the second. Each line
  used to have its placeholders from the left in their order in the text,
  whatever their direction, which also moved the text between them. In RTL
  `'سلام سلام شكرا بالعالم '`, a 13px box, `' سلام '`, a 24px box,
  `' 12 '` and a 28px box in Harmattan at 20px, justified at 141px, the
  second line has the 13px box at x 85.08 and the 24px one at 22.28, as in
  Chrome, where they were at 22.28 and 74.08 (#47).

### 1.0.10-effing.5

- No letter spacing after default-ignorable code points (ZWSP, ZWJ, ZWNJ,
  WJ, U+FEFF, the bidi controls, variation selectors, a soft hyphen, ...),
  U+FFFC, and in a `Paragraph` a carriage return, as in Chrome: with
  `letterSpacing: 10`, `'a\u200Bb'` is 41.33px wide, as `'ab'` is, not
  51.33px, and `@effing/canvas`'s NBSP and ZWSP for a line separator get one
  gap, not two. This covers `Paragraph`, and `fillText`, `strokeText` and
  `measureText` under `textRendering = 'geometricPrecision'`; the other
  `textRendering` values keep upstream's spacing. A paragraph with many such
  code points and letter spacing lays out more slowly (1000 ZWSPs: 4.6ms
  instead of 0.9ms).
- `ParagraphLayout.lineGap`: the primary font's hhea line gap in px at the
  font size, 0 if negative, as Chrome takes it. With `ascent` and
  `descent` it gives Chrome's `line-height: normal`,
  `round(ascent) + round(descent) + round(lineGap)`, without reading font
  tables in JavaScript, for system fonts too. `lineHeight`'s own `normal`
  is still `ascent + descent`.
- A lone CR is laid out as Chrome lays it out under `white-space: pre` and
  `pre-wrap`: with no width and no glyph, and no line-break opportunity
  beside it. It used to be drawn as the font's missing glyph (a box 15px
  wide at 20px in Liberation Sans) and be a line-break opportunity.
  `'a\rb'` now measures as `'ab'` in a font that doesn't kern the two, and
  `'aaaa\rbbbb'` stays on one line. As in Chrome, the text on either side
  of it is shaped apart, without kerning, ligatures or Arabic joining
  across it, and bidi resolves the characters around it as around a
  paragraph separator. A CRLF is still a hard break.
- With `keepTrailingWhitespace`, the last line `maxLines` shows with an
  `ellipsis` ends before a CRLF that ends it, as before an LF: it used to
  keep the CR as trailing whitespace, drawn as the font's missing glyph
  before the ellipsis where the font maps none to it, and in its
  `endIndex` (`'ab\r\ncd'` was `[0, 3)`, now `[0, 2)`, "ab…").
- `noWrap` text with `maxLines` and an `ellipsis` ends the last line it
  keeps with the ellipsis whenever it drops lines after it, as Chrome's
  `-webkit-line-clamp` does under `white-space: pre`: `'ab\ncd'` with
  `maxLines: 1` is "ab…", no longer "ab", and the line is truncated with
  the ellipsis to fit the width (`'abcd\ncd'` at 50px is "abc…"). Only a
  line too wide for the width used to get it. The spaces that end the line
  stay before the ellipsis only with `keepTrailingWhitespace`.
- An RTL line clamped with an `ellipsis` is as wide as its text, its
  placeholders and the ellipsis together. It used to leave the ellipsis
  out when a placeholder ended the line on its right, so a right-aligned
  such line pushed the placeholder past the right edge by the ellipsis's
  width.

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
