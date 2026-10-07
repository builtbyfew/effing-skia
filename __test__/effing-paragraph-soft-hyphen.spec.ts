import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test, { type ExecutionContext } from 'ava'

import { GlobalFonts, createCanvas } from '../index'
import { Paragraph, fillParagraph, type ParagraphLayout, type ParagraphStyle } from '../extensions'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Every expected line below comes from Chrome 154 (headless, macOS): the text
// in a span in a `white-space: normal` div of the given width with the CSS
// shown (`hyphens: manual`, the default), the same font file loaded with
// @font-face, each line's width the sum of the span's client rects on it,
// which take in the hyphen Chrome draws where a line breaks at a soft hyphen,
// and min-content the width of a `width: min-content` box. Chrome's widths are
// in 1/64 px, so they are compared to 0.05px.
const LIBERATION: ParagraphStyle = { fontFamily: 'SH Liberation', fontSize: 20 }
const HAN: ParagraphStyle = { fontFamily: 'SH Source Han', fontSize: 20 }
const ARABIC: ParagraphStyle = { fontFamily: 'SH Harmattan', fontSize: 20, direction: 'rtl', textAlign: 'start' }

test.before((t) => {
  const fonts = join(__dirname, 'fonts')
  // Liberation Sans 1.00 (GPLv2 with the font exception), as @effing/canvas
  // bundles it. It has no U+2010, so Chrome's hyphen is "-" in it.
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'LiberationSans-Regular.woff'), 'SH Liberation'))
  // Its U+2010 is 1em wide, its "-" 0.37em.
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'SourceHanSerifCN-Bold.ttf'), 'SH Source Han'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'Harmattan-Regular.ttf'), 'SH Harmattan'))
})

const SUPER = 'super\u00ADcali\u00ADfragilistic'

// A line as [startIndex, endIndex, width], or [startIndex, endIndex, width,
// left] where its left edge matters.
type Line = [number, number, number] | [number, number, number, number]

function expectLines(t: ExecutionContext, layout: ParagraphLayout, expected: Line[], epsilon = 0.05) {
  t.deepEqual(
    layout.lines.map((line) => [line.startIndex, line.endIndex]),
    expected.map(([start, end]) => [start, end]),
  )
  for (const [i, [, , width, left]] of expected.entries()) {
    const line = layout.lines[i]
    t.true(Math.abs(line.width - width) <= epsilon, `line ${i} is ${line.width} wide, not ${width}`)
    if (left !== undefined) {
      t.true(Math.abs(line.left - left) <= epsilon, `line ${i} starts at ${line.left}, not ${left}`)
    }
  }
}

function near(t: ExecutionContext, actual: number, expected: number, epsilon = 0.05) {
  t.true(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`)
}

test('a line that breaks at a soft hyphen ends with a hyphen, as in Chrome', (t) => {
  // The line's text ends after the soft hyphen; the hyphen is in its width.
  expectLines(t, new Paragraph(SUPER, LIBERATION).layout(130), [
    [0, 11, 86.719],
    [11, 22, 77.797],
  ])
})

test('a soft hyphen where no line breaks draws nothing', (t) => {
  expectLines(t, new Paragraph(SUPER, LIBERATION).layout(1000), [[0, 22, 157.844]])
  // Nor at the end of the text or before a hard break.
  expectLines(t, new Paragraph('super\u00AD', LIBERATION).layout(30), [[0, 6, 50.031]])
  expectLines(t, new Paragraph('super\u00AD\ncali', { ...LIBERATION, keepTrailingWhitespace: true }).layout(30), [
    [0, 6, 50.031],
    [7, 11, 30.016],
  ])
})

test('the hyphen must fit in the line, as in Chrome', (t) => {
  // "supercali-" is 86.72px wide: the line breaks at the soft hyphen before.
  expectLines(t, new Paragraph(SUPER, LIBERATION).layout(83), [
    [0, 6, 56.703],
    [6, 11, 36.688],
    [11, 22, 77.797],
  ])
  // With no break before it, the line overflows with the hyphen.
  expectLines(t, new Paragraph('supercali\u00ADfragilistic', LIBERATION).layout(83), [
    [0, 10, 86.719],
    [10, 21, 77.797],
  ])
})

test('the hyphen is shaped on its own, with no kerning and no letter spacing', (t) => {
  // "AT-" as text kerns T and "-" to 29.64px.
  expectLines(t, new Paragraph('AT\u00ADAT\u00ADAT', LIBERATION).layout(30), [
    [0, 3, 30.75],
    [3, 6, 30.75],
    [6, 8, 24.078],
  ])
  expectLines(t, new Paragraph(SUPER, { ...LIBERATION, letterSpacing: 5 }).layout(130), [
    [0, 6, 81.703],
    [6, 11, 56.688],
    [11, 22, 132.797],
  ])
})

test('the hyphen is U+2010 where the font has it', (t) => {
  expectLines(t, new Paragraph(SUPER, HAN).layout(130), [
    [0, 11, 114.344],
    [11, 22, 97.625],
  ])
})

test('a hyphenated line is aligned and justified with its hyphen', (t) => {
  const text = 'aa bb super\u00ADcali dd ee'
  expectLines(t, new Paragraph(text, { ...LIBERATION, textAlign: 'justify' }).layout(125), [
    [0, 12, 125, 0],
    [12, 22, 85.625, 0],
  ])
  expectLines(t, new Paragraph(text, { ...LIBERATION, textAlign: 'right' }).layout(125), [
    [0, 12, 112.313, 12.688],
    [12, 22, 85.625, 39.375],
  ])
  expectLines(t, new Paragraph(text, { ...LIBERATION, textAlign: 'center' }).layout(125), [
    [0, 12, 112.313, 6.344],
    [12, 22, 85.625, 19.688],
  ])
})

test('a soft hyphen before the spaces a line breaks at gets the hyphen', (t) => {
  expectLines(t, new Paragraph('super\u00AD cali', LIBERATION).layout(60), [
    [0, 6, 56.703],
    [7, 11, 30.016],
  ])
})

test('a clamped line keeps its hyphen before the ellipsis, as in Chrome', (t) => {
  // -webkit-line-clamp; Chrome's ellipsis is 20px wide.
  const style: ParagraphStyle = { ...LIBERATION, ellipsis: '\u2026' }
  expectLines(t, new Paragraph(SUPER, { ...style, maxLines: 2 }).layout(83), [
    [0, 6, 56.703],
    [6, 11, 56.688],
  ])
  expectLines(t, new Paragraph(SUPER, { ...style, maxLines: 1 }).layout(83), [[0, 6, 76.703]])
})

test('min-content takes in the hyphen after a word that ends at a soft hyphen', (t) => {
  const layout = new Paragraph('abcdefghij\u00ADkl', LIBERATION).layout(10)
  near(t, layout.minIntrinsicWidth, 97.859)
  expectLines(t, layout, [
    [0, 11, 97.859],
    [11, 13, 14.453],
  ])
})

test('the hyphen ends the line where its text does, in RTL too', (t) => {
  // An Arabic word: the hyphen on its left, the line overflowing the box.
  expectLines(t, new Paragraph('\u0643\u0644\u0645\u0629\u00AD\u0643\u0644\u0645\u0629', ARABIC).layout(30), [
    [0, 5, 40.953, -10.953],
    [5, 9, 34.641, -4.641],
  ])
  // A Latin word in an RTL paragraph: the hyphen on its right.
  const layout = new Paragraph('super\u00ADcali', { ...LIBERATION, direction: 'rtl', textAlign: 'start' }).layout(60)
  expectLines(t, layout, [
    [0, 6, 56.703, 3.297],
    [6, 10, 30.016, 29.984],
  ])
})

test('the hyphen is drawn after the text of its line', (t) => {
  const width = 80
  const paint = (text: string, layoutWidth: number) => {
    const paragraph = new Paragraph(text, { ...LIBERATION, lineHeight: 30 })
    paragraph.layout(layoutWidth)
    const ctx = createCanvas(width, 30).getContext('2d')
    fillParagraph(ctx, paragraph, 5, 0)
    return Array.from(ctx.getImageData(0, 0, width, 30).data.filter((_, i) => i % 4 === 3))
  }
  const columns = (alpha: number[], from: number, to: number) =>
    alpha.filter((_, i) => i % width >= from && i % width < to)
  // "super" as it is drawn alone, then the hyphen from 5 + 50.03 to 5 + 56.70.
  const hyphenated = paint('super\u00ADcali', 60)
  const plain = paint('super', 1000)
  t.deepEqual(columns(hyphenated, 0, 55), columns(plain, 0, 55))
  t.true(columns(hyphenated, 56, 61).some((alpha) => alpha > 128))
  t.false(columns(plain, 55, width).some((alpha) => alpha > 0))
  // A soft hyphen where no line breaks draws nothing.
  t.deepEqual(paint('super\u00ADcali', 1000), paint('supercali', 1000))
})
