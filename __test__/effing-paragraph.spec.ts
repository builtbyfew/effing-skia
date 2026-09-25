import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, Paragraph, createCanvas, type ParagraphStyle, type SKRSContext2D } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const TEXT = 'The quick brown fox jumps over the lazy dog'
const STYLE: ParagraphStyle = { fontFamily: 'Iosevka Slab', fontSize: 20 }

test.before((t) => {
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf')))
})

function near(t: import('ava').ExecutionContext, actual: number, expected: number, epsilon = 0.01) {
  t.true(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`)
}

test('layout wraps at the width and stacks line boxes', (t) => {
  const layout = new Paragraph(TEXT, STYLE).layout(200)
  t.true(layout.lines.length > 1)
  near(t, layout.lineHeight, layout.ascent + layout.descent)
  near(t, layout.height, layout.lines.length * layout.lineHeight)
  for (const [i, line] of layout.lines.entries()) {
    t.true(line.width <= 200, `line ${i} is ${line.width} wide`)
    t.is(line.left, 0)
    near(t, line.baseline, i * layout.lineHeight + (layout.lineHeight + layout.ascent - layout.descent) / 2)
    // Only the end of the text counts as a hard break.
    t.is(line.hardBreak, i === layout.lines.length - 1)
  }
  t.is(layout.lines[0].startIndex, 0)
  t.is(layout.lines.at(-1)!.endIndex, TEXT.length)
  t.false(layout.didExceedMaxLines)
})

test('an unbounded width gives one line', (t) => {
  const layout = new Paragraph(TEXT, STYLE).layout(0)
  t.is(layout.lines.length, 1)
  near(t, layout.lines[0].width, layout.longestLine)
})

test('lineHeight sets every line box', (t) => {
  const layout = new Paragraph(TEXT, { ...STYLE, lineHeight: 40 }).layout(200)
  t.is(layout.lineHeight, 40)
  for (const [i, line] of layout.lines.entries()) {
    near(t, line.baseline, i * 40 + (40 + layout.ascent - layout.descent) / 2)
  }
})

test('noWrap only breaks at hard breaks', (t) => {
  const layout = new Paragraph(`${TEXT}\n${TEXT}`, { ...STYLE, noWrap: true }).layout(50)
  t.is(layout.lines.length, 2)
  t.true(layout.lines[0].width > 50)
  t.true(layout.lines[0].hardBreak)
})

test('maxLines truncates with the ellipsis', (t) => {
  const layout = new Paragraph(TEXT, { ...STYLE, maxLines: 1, ellipsis: '…' }).layout(200)
  t.is(layout.lines.length, 1)
  t.true(layout.didExceedMaxLines)
  t.true(layout.lines[0].width <= 200)
  t.true(layout.lines[0].endIndex < TEXT.length)
})

test('noWrap with an ellipsis truncates to the width', (t) => {
  const layout = new Paragraph(TEXT, { ...STYLE, noWrap: true, ellipsis: '…' }).layout(200)
  t.is(layout.lines.length, 1)
  t.true(layout.lines[0].width <= 200)
  t.true(layout.lines[0].endIndex < TEXT.length)
})

test('textAlign positions each line in the width', (t) => {
  const width = 300
  const left = new Paragraph(TEXT, { ...STYLE, textAlign: 'left' }).layout(width)
  const right = new Paragraph(TEXT, { ...STYLE, textAlign: 'right' }).layout(width)
  const center = new Paragraph(TEXT, { ...STYLE, textAlign: 'center' }).layout(width)
  for (const [i, line] of left.lines.entries()) {
    t.is(line.left, 0)
    near(t, right.lines[i].left, width - line.width)
    near(t, center.lines[i].left, (width - line.width) / 2)
  }
})

test('start and end follow the direction', (t) => {
  const width = 300
  const ltr = new Paragraph(TEXT, { ...STYLE, textAlign: 'end' }).layout(width)
  const rtl = new Paragraph(TEXT, { ...STYLE, textAlign: 'start', direction: 'rtl' }).layout(width)
  near(t, ltr.lines[0].left, width - ltr.lines[0].width)
  near(t, rtl.lines[0].left, width - rtl.lines[0].width)
})

test('font families may be quoted', (t) => {
  const plain = new Paragraph(TEXT, STYLE).layout(0)
  const quoted = new Paragraph(TEXT, { ...STYLE, fontFamily: ' "Iosevka Slab" , serif' }).layout(0)
  near(t, quoted.longestLine, plain.longestLine)
})

test('invalid style values throw', (t) => {
  t.throws(() => new Paragraph(TEXT, { ...STYLE, textAlign: 'middle' }))
  t.throws(() => new Paragraph(TEXT, { ...STYLE, fontStyle: 'bold' }))
  t.throws(() => new Paragraph(TEXT, { ...STYLE, direction: 'down' }))
})

test('fillParagraph paints exactly where geometricPrecision fillText does', (t) => {
  const paragraph = new Paragraph('Hello Canvas', STYLE)
  const { lines } = paragraph.layout(0)
  const x = 10.29
  const y = 20.37

  const expected = createCanvas(200, 60)
  const expectedCtx = expected.getContext('2d')
  expectedCtx.font = '20px Iosevka Slab'
  expectedCtx.textRendering = 'geometricPrecision'
  expectedCtx.fillText('Hello Canvas', x, y + lines[0].baseline)

  const actual = createCanvas(200, 60)
  const actualCtx = actual.getContext('2d')
  actualCtx.fillParagraph(paragraph, x, y)

  const a = actualCtx.getImageData(0, 0, 200, 60).data
  const b = expectedCtx.getImageData(0, 0, 200, 60).data
  let ink = 0
  let worst = 0
  for (let i = 3; i < a.length; i += 4) {
    ink += a[i]
    worst = Math.max(worst, Math.abs(a[i] - b[i]))
  }
  t.true(ink > 0)
  t.true(worst <= 1, `alpha differs by up to ${worst}`)
})

function inkSum(ctx: SKRSContext2D) {
  const { data } = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height)
  let sum = 0
  for (let i = 3; i < data.length; i += 4) {
    sum += data[i]
  }
  return sum
}

test('strokeParagraph strokes the outlines', (t) => {
  const paragraph = new Paragraph('Hello', { ...STYLE, fontSize: 80 })
  paragraph.layout(0)
  const ctx = createCanvas(300, 120).getContext('2d')
  ctx.strokeStyle = 'black'
  ctx.lineWidth = 1
  ctx.strokeParagraph(paragraph, 10, 10)
  const stroked = inkSum(ctx)
  ctx.clearRect(0, 0, 300, 120)
  ctx.fillParagraph(paragraph, 10, 10)
  const filled = inkSum(ctx)
  t.true(stroked > 0)
  t.true(stroked < filled / 2, `${stroked} stroked vs ${filled} filled coverage`)
})

test('fillParagraph honours the context shadow', (t) => {
  const paragraph = new Paragraph('Hello', { ...STYLE, fontSize: 40 })
  paragraph.layout(0)
  const ctx = createCanvas(200, 100).getContext('2d')
  ctx.fillStyle = 'black'
  ctx.shadowColor = 'red'
  ctx.shadowOffsetX = 60
  ctx.fillParagraph(paragraph, 10, 10)
  const { data } = ctx.getImageData(0, 0, 200, 100)
  let red = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 200 && data[i + 1] === 0 && data[i + 3] > 0) red++
  }
  t.true(red > 0)
})
