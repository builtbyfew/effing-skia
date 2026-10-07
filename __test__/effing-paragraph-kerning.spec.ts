import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test, { type ExecutionContext } from 'ava'

import { GlobalFonts, createCanvas } from '../index'
import { Paragraph, fillParagraph, type ParagraphLayout, type ParagraphStyle } from '../extensions'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Every expected line below comes from Chrome 154 (headless, macOS): the text
// in a span in a `white-space: normal` div of the given width with the CSS
// shown, the same font file loaded with @font-face, each line's width the
// sum of the span's client rects on it, and min-content the width of a
// `width: min-content` box. Chrome's widths are in 1/64 px.
//
// Liberation Sans kerns with a legacy `kern` table, which HarfBuzz applies
// half to each glyph of a pair. Its pairs with a space at 20px: space+A
// -1.104px, space+T and space+Y -0.361px.
const LIBERATION: ParagraphStyle = { fontFamily: 'KN Liberation', fontSize: 20 }

test.before((t) => {
  // Liberation Sans 1.00 (GPLv2 with the font exception), as @effing/canvas
  // bundles it.
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'LiberationSans-Regular.woff'), 'KN Liberation'))
})

const OVER = 'Over Away Yes Tea'

// A line as [startIndex, endIndex, width].
type Line = [number, number, number]

function expectLines(t: ExecutionContext, layout: ParagraphLayout, expected: Line[], epsilon = 0.02) {
  t.deepEqual(
    layout.lines.map((line) => [line.startIndex, line.endIndex]),
    expected.map(([start, end]) => [start, end]),
  )
  for (const [i, [, , width]] of expected.entries()) {
    const line = layout.lines[i]
    t.true(Math.abs(line.width - width) <= epsilon, `line ${i} is ${line.width} wide, not ${width}`)
  }
}

test('a line does not start with the kerning against the space it wraps at', (t) => {
  // "THE" alone is 40px; it used to be 39.82px after the space it wrapped at.
  expectLines(t, new Paragraph('OVER THE', LIBERATION).layout(70), [
    [0, 4, 56.688],
    [5, 8, 40],
  ])
  // "Away" used to be 47.99px, "Yes" 32.45px and "Tea" 32.07px.
  expectLines(t, new Paragraph(OVER, LIBERATION).layout(60), [
    [0, 4, 43.344],
    [5, 9, 48.547],
    [10, 13, 32.641],
    [14, 17, 32.25],
  ])
  expectLines(t, new Paragraph(OVER, { ...LIBERATION, letterSpacing: 3 }).layout(60), [
    [0, 4, 55.344],
    [5, 9, 60.547],
    [10, 13, 41.641],
    [14, 17, 41.25],
  ])
})

test('lines break by the width they have without that kerning', (t) => {
  // "Away Yes" is 86.375px at a line's start, 85.82px after a space.
  expectLines(t, new Paragraph(OVER, LIBERATION).layout(86.2), [
    [0, 4, 43.344],
    [5, 9, 48.547],
    [10, 17, 70.078],
  ])
  expectLines(t, new Paragraph(OVER, LIBERATION).layout(86.4), [
    [0, 4, 43.344],
    [5, 13, 86.375],
    [14, 17, 32.25],
  ])
  // A word that fits the line only with that kerning overflows it, unbroken.
  expectLines(t, new Paragraph('ab Away', LIBERATION).layout(48.2), [
    [0, 2, 22.25],
    [3, 7, 48.547],
  ])
  expectLines(t, new Paragraph(OVER, { ...LIBERATION, textAlign: 'justify' }).layout(100), [
    [0, 9, 100],
    [10, 17, 70.078],
  ])
})

test('the kerning at the end of a line and min-content stay, as in Chrome', (t) => {
  // "VA" alone is 25.20px; the half of the kerning against the space after
  // it stays.
  expectLines(t, new Paragraph('VA AT', LIBERATION).layout(30), [
    [0, 2, 24.656],
    [3, 5, 24.078],
  ])
  // Chrome's min-content measures "Away" with the kerning: 47.98px.
  t.true(Math.abs(new Paragraph(OVER, LIBERATION).layout(60).minIntrinsicWidth - 47.984) <= 0.02)
})

test('a line that starts after a kerned space is drawn as its text alone', (t) => {
  const paint = (text: string, width: number, y: number) => {
    const paragraph = new Paragraph(text, { ...LIBERATION, lineHeight: 30 })
    paragraph.layout(width)
    const ctx = createCanvas(80, 60).getContext('2d')
    fillParagraph(ctx, paragraph, 5, y)
    // The second line box.
    return Array.from(ctx.getImageData(0, 30, 80, 30).data.filter((_, i) => i % 4 === 3))
  }
  t.deepEqual(paint('Over Away', 60, 0), paint('Away', 1000, 30))
})
