import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, createCanvas } from '../index'
import { Paragraph, fillParagraph, type ParagraphPlaceholder, type ParagraphStyle } from '../extensions'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Iosevka Slab is monospaced: every glyph used here advances 10px at 20px.
// Its hhea ascender and descender are 19.54px and 4.1px.
const STYLE: ParagraphStyle = { fontFamily: 'Iosevka Slab', fontSize: 20, lineHeight: 40 }

test.before((t) => {
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf')))
})

function near(t: import('ava').ExecutionContext, actual: number, expected: number, epsilon = 0.01) {
  t.true(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`)
}

const box = (placeholder: Partial<ParagraphPlaceholder> = {}): ParagraphPlaceholder => ({
  width: 20,
  height: 20,
  ...placeholder,
})

test('a string and a one-string array lay out alike', (t) => {
  const text = 'The quick brown fox jumps over the lazy dog'
  const plain = new Paragraph(text, STYLE).layout(200)
  t.deepEqual(new Paragraph([text], STYLE).layout(200), plain)
  t.deepEqual(plain.placeholders, [])
})

test('a placeholder takes its width in the line and one index', (t) => {
  const layout = new Paragraph(['ab', box(), 'cd'], STYLE).layout(400)
  t.is(layout.lines.length, 1)
  near(t, layout.lines[0].width, 60)
  // 'ab' + U+FFFC + 'cd'
  t.is(layout.lines[0].endIndex, 5)
  t.is(layout.placeholders.length, 1)
  const placeholder = layout.placeholders[0]!
  near(t, placeholder.x, 20)
  t.is(placeholder.width, 20)
  t.is(placeholder.height, 20)
  t.is(placeholder.line, 0)
  // Placeholders never grow a line box.
  t.is(layout.lineHeight, 40)
  t.is(layout.height, 40)
})

// Expected boxes measured in Chrome 154 (headless, macOS) from
// `<div style="font: 20px <this font>; line-height: 40px">ab<span
// style="display: inline-block; width: W; height: H; vertical-align: V">
// </span>cd</div>`, with getBoundingClientRect() on the span and on a
// zero-size inline-block marking the baseline: the box's top relative to the
// baseline (or to the line box's top for `top` and `bottom`), and its left.
// Chrome rounds the font's ascent and descent to whole pixels (20 and 4 for
// 19.54 and 4.1), which moves `text-top` and `text-bottom` by up to 0.46px;
// the paragraph keeps them exact.
const CHROME_BOXES: Array<{
  verticalAlign: NonNullable<ParagraphPlaceholder['verticalAlign']>
  width: number
  height: number
  // Top relative to the baseline, or to the line top for `top`/`bottom`.
  top: number
}> = [
  { verticalAlign: 'baseline', width: 20, height: 20, top: -20 },
  { verticalAlign: 'middle', width: 20, height: 20, top: -15.297 },
  { verticalAlign: 'top', width: 20, height: 20, top: 0 },
  { verticalAlign: 'bottom', width: 20, height: 20, top: 20 },
  { verticalAlign: 'text-top', width: 20, height: 20, top: -20 },
  { verticalAlign: 'text-bottom', width: 20, height: 20, top: -16 },
  { verticalAlign: 'baseline', width: 10, height: 14, top: -14 },
  { verticalAlign: 'middle', width: 10, height: 14, top: -12.297 },
  { verticalAlign: 'top', width: 10, height: 14, top: 0 },
  { verticalAlign: 'bottom', width: 10, height: 14, top: 26 },
  { verticalAlign: 'text-top', width: 10, height: 14, top: -20 },
  { verticalAlign: 'text-bottom', width: 10, height: 14, top: -10 },
]

test('verticalAlign places the box as Chrome does', (t) => {
  for (const { verticalAlign, width, height, top } of CHROME_BOXES) {
    const layout = new Paragraph(['ab', { width, height, verticalAlign }, 'cd'], STYLE).layout(400)
    const placeholder = layout.placeholders[0]!
    const line = layout.lines[0]
    const lineTop = 0
    const from = verticalAlign === 'top' || verticalAlign === 'bottom' ? lineTop : line.baseline
    const epsilon = verticalAlign.startsWith('text-') ? 0.5 : 0.01
    near(t, placeholder.y - from, top, epsilon)
    near(t, placeholder.x, 20)
    t.is(placeholder.height, height, verticalAlign)
  }
})

test('verticalAlign follows the paragraph metrics exactly', (t) => {
  const at = (placeholder: ParagraphPlaceholder) => {
    const layout = new Paragraph(['ab', placeholder, 'cd'], STYLE).layout(400)
    return { layout, y: layout.placeholders[0]!.y, baseline: layout.lines[0].baseline }
  }
  const { layout, y, baseline } = at(box({ verticalAlign: 'text-top' }))
  near(t, y, baseline - layout.ascent)
  const bottom = at(box({ verticalAlign: 'text-bottom' }))
  near(t, bottom.y, bottom.baseline + layout.descent - 20)
  // baselineOffset puts the box's own baseline on the line's: `vertical-align:
  // 5px` on an image is a baselineOffset of its height plus 5.
  const raised = at(box({ baselineOffset: 25 }))
  near(t, raised.y, raised.baseline - 25)
  const defaulted = at(box({ verticalAlign: 'baseline' }))
  near(t, defaulted.y, defaulted.baseline - 20)
})

test('a placeholder moves with its line on every line', (t) => {
  // Measured in Chrome as above at width 60px: 'ab ', the box and ' cd' put
  // the box on the first line at x 30 and 'cd' on the second.
  const layout = new Paragraph(['ab ', box(), ' cd'], STYLE).layout(60)
  t.is(layout.lines.length, 2)
  const placeholder = layout.placeholders[0]!
  t.is(placeholder.line, 0)
  near(t, placeholder.x, 30)
  // The box doesn't fit after 'ab cd ', so it starts the second line.
  const second = new Paragraph(['ab cd ', box(), ' ef'], STYLE).layout(60)
  t.is(second.placeholders[0]!.line, 1)
  near(t, second.placeholders[0]!.x, 0)
  near(t, second.placeholders[0]!.y, second.lines[1].baseline - 20)
})

test('a placeholder can break from the text on either side', (t) => {
  // Measured in Chrome as above: at these widths the box gets a line of its
  // own between the two words, even next to punctuation; at 60px 'abc' and
  // the box share the first line.
  for (const [width, before, after] of [
    [50, 'abcd', 'efgh'],
    [30, 'ab', 'cd'],
    [45, 'ab.', ',cd'],
  ] as const) {
    const layout = new Paragraph([before, box(), after], STYLE).layout(width)
    t.is(layout.lines.length, 3, `${before}|${after}`)
    t.is(layout.placeholders[0]!.line, 1)
    near(t, layout.placeholders[0]!.x, 0)
  }
  const shared = new Paragraph(['abc', box(), 'def'], STYLE).layout(60)
  t.is(shared.lines.length, 2)
  t.is(shared.placeholders[0]!.line, 0)
  near(t, shared.placeholders[0]!.x, 30)
})

test('letter spacing is not added to a placeholder', (t) => {
  // Measured in Chrome as above with `letter-spacing: 4px`: the box starts
  // at 28 and 'c' at 48, so the box takes no spacing of its own.
  const layout = new Paragraph(['ab', box(), 'cd'], { ...STYLE, letterSpacing: 4 }).layout(400)
  near(t, layout.placeholders[0]!.x, 28)
  near(t, layout.lines[0].width, 4 * 14 + 20)
})

test('alignment moves placeholders with their line', (t) => {
  const content = ['ab', box(), 'cd']
  for (const [textAlign, left] of [
    ['left', 0],
    ['center', 170],
    ['right', 340],
  ] as const) {
    const layout = new Paragraph(content, { ...STYLE, textAlign }).layout(400)
    near(t, layout.lines[0].left, left)
    near(t, layout.placeholders[0]!.x, left + 20)
  }
  const rtl = new Paragraph(content, { ...STYLE, direction: 'rtl', textAlign: 'start' }).layout(400)
  near(t, rtl.placeholders[0]!.x, 360)
})

test('a placeholder alone, or with no size, is still placed', (t) => {
  const alone = new Paragraph([box()], STYLE).layout(400)
  t.is(alone.lines.length, 1)
  near(t, alone.placeholders[0]!.x, 0)
  const empty = new Paragraph(['ab', { width: 0, height: 0 }, 'cd'], STYLE).layout(400)
  near(t, empty.placeholders[0]!.x, 20)
  near(t, empty.placeholders[0]!.y, empty.lines[0].baseline)
  near(t, empty.lines[0].width, 40)
})

test('a placeholder cut off by maxLines or an ellipsis is null', (t) => {
  const clamped = new Paragraph(['ab cd ', box(), ' ef'], { ...STYLE, maxLines: 1, ellipsis: '…' }).layout(60)
  t.is(clamped.lines.length, 1)
  t.deepEqual(clamped.placeholders, [null])
  const ellipsized = new Paragraph(['abcdefgh', box(), 'ijkl'], { ...STYLE, maxLines: 1, ellipsis: '…' }).layout(100)
  t.true(ellipsized.lines[0].endIndex <= 8)
  t.deepEqual(ellipsized.placeholders, [null])
})

test('placeholders keep their order and lines in noWrap text with an ellipsis', (t) => {
  const content = [box(), 'abc\n', box({ width: 10 }), '\nd', box({ width: 30 })]
  const layout = new Paragraph(content, { ...STYLE, noWrap: true, ellipsis: '…' }).layout(400)
  t.is(layout.lines.length, 3)
  t.deepEqual(
    layout.placeholders.map((p) => [p!.line, p!.width]),
    [
      [0, 20],
      [1, 10],
      [2, 30],
    ],
  )
  near(t, layout.placeholders[2]!.x, 10)
  // Each placeholder counts as one UTF-16 unit.
  t.deepEqual(
    layout.lines.map((line) => [line.startIndex, line.endIndex]),
    [
      [0, 4],
      [5, 6],
      [7, 9],
    ],
  )
  const dropped = new Paragraph(content, { ...STYLE, noWrap: true, ellipsis: '…', maxLines: 2 }).layout(400)
  t.is(dropped.placeholders[1]!.line, 1)
  t.is(dropped.placeholders[2], null)
})

test('placeholders paint nothing', (t) => {
  const paint = (content: ConstructorParameters<typeof Paragraph>[0]) => {
    const paragraph = new Paragraph(content, STYLE)
    paragraph.layout(400)
    const ctx = createCanvas(100, 40).getContext('2d')
    fillParagraph(ctx, paragraph, 0, 0)
    return ctx.getImageData(0, 0, 100, 40).data
  }
  // Two spaces are as wide as the box. The two runs either side of the box
  // are shaped and filled apart, which can round an edge pixel differently.
  const withBox = paint(['ab', box(), 'cd'])
  const withSpaces = paint('ab  cd')
  let worst = 0
  let ink = 0
  for (let i = 3; i < withBox.length; i += 4) {
    worst = Math.max(worst, Math.abs(withBox[i] - withSpaces[i]))
    ink += withBox[i]
  }
  t.true(ink > 0)
  t.true(worst <= 8, `alpha differs by up to ${worst}`)
})

test('invalid placeholders throw', (t) => {
  t.throws(() => new Paragraph(['a', box({ width: -1 })], STYLE))
  t.throws(() => new Paragraph(['a', box({ height: Number.NaN })], STYLE))
  t.throws(() => new Paragraph(['a', box({ baselineOffset: Infinity })], STYLE))
  // @ts-expect-error not a vertical-align keyword
  t.throws(() => new Paragraph(['a', box({ verticalAlign: 'center' })], STYLE))
  // @ts-expect-error not a string or a placeholder
  t.throws(() => new Paragraph(['a', 1], STYLE))
})
