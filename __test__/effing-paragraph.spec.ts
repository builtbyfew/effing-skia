import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, createCanvas, type SKRSContext2D } from '../index'
import { Paragraph, fillParagraph, strokeParagraph, type ParagraphStyle } from '../extensions'

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

test('text and ellipsis may contain NUL', (t) => {
  const text = `${TEXT}\0${TEXT}`
  const layout = new Paragraph(text, STYLE).layout(200)
  t.is(layout.lines[layout.lines.length - 1].endIndex, text.length)
  const truncated = new Paragraph(text, { ...STYLE, maxLines: 1, ellipsis: '\0…' }).layout(200)
  t.is(truncated.lines.length, 1)
  t.true(truncated.didExceedMaxLines)
})

test('an ellipsis without maxLines or noWrap leaves wrapping alone', (t) => {
  const plain = new Paragraph(TEXT, STYLE).layout(200)
  const ellipsized = new Paragraph(TEXT, { ...STYLE, ellipsis: '…' }).layout(200)
  t.true(plain.lines.length > 1)
  t.deepEqual(ellipsized.lines, plain.lines)
  t.false(ellipsized.didExceedMaxLines)
})

test('noWrap with an ellipsis truncates every hard-broken line', (t) => {
  const text = `${TEXT}\n\n${TEXT}\nshort`
  const layout = new Paragraph(text, { ...STYLE, noWrap: true, ellipsis: '…' }).layout(200)
  t.is(layout.lines.length, 4)
  near(t, layout.height, 4 * layout.lineHeight)
  for (const i of [0, 2]) {
    t.true(layout.lines[i].width <= 200, `line ${i} is ${layout.lines[i].width} wide`)
    t.true(layout.lines[i].endIndex < layout.lines[i].startIndex + TEXT.length)
  }
  t.is(layout.lines[1].startIndex, TEXT.length + 1)
  t.is(layout.lines[2].startIndex, TEXT.length + 2)
  t.is(layout.lines[3].startIndex, 2 * TEXT.length + 3)
  t.is(layout.lines[3].endIndex, text.length)
  for (const [i, line] of layout.lines.entries()) {
    near(t, line.baseline, i * layout.lineHeight + (layout.lineHeight + layout.ascent - layout.descent) / 2)
  }
  t.false(layout.didExceedMaxLines)
})

test('noWrap with an ellipsis and maxLines drops the lines past it', (t) => {
  const text = `${TEXT}\n${TEXT}\n${TEXT}`
  const layout = new Paragraph(text, { ...STYLE, noWrap: true, ellipsis: '…', maxLines: 2 }).layout(200)
  t.is(layout.lines.length, 2)
  t.true(layout.didExceedMaxLines)
  for (const line of layout.lines) {
    t.true(line.width <= 200)
  }
  t.is(layout.lines[1].startIndex, TEXT.length + 1)
})

test('line indices are UTF-16 offsets', (t) => {
  const text = 'Ünïcödé wörds wräp hère ănd thêre 😀 again'
  const layout = new Paragraph(text, STYLE).layout(150)
  t.true(layout.lines.length > 1)
  t.is(layout.lines.at(-1)!.endIndex, text.length)
  for (const [i, line] of layout.lines.entries()) {
    const slice = text.slice(line.startIndex, line.endIndex)
    t.is(slice, slice.trim(), `line ${i} is ${JSON.stringify(slice)}`)
    if (i > 0) {
      t.is(text.slice(layout.lines[i - 1].endIndex, line.startIndex).trim(), '')
    }
  }
  const split = new Paragraph('é😀\nb', { ...STYLE, noWrap: true, ellipsis: '…' }).layout(200)
  t.is(split.lines[1].startIndex, 4)
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

test('justify in RTL right-aligns the lines it does not justify', (t) => {
  const width = 300
  const text = `${TEXT}\n${TEXT}`
  const ltr = new Paragraph(text, { ...STYLE, textAlign: 'justify' }).layout(width)
  const rtl = new Paragraph(text, { ...STYLE, textAlign: 'justify', direction: 'rtl' }).layout(width)
  t.is(rtl.lines.length, ltr.lines.length)
  for (const [i, line] of rtl.lines.entries()) {
    if (line.hardBreak) {
      near(t, line.left, width - line.width)
      t.is(ltr.lines[i].left, 0)
    } else {
      t.is(line.left, 0)
    }
  }
  const noWrap = new Paragraph(text, { ...STYLE, textAlign: 'justify', direction: 'rtl', noWrap: true }).layout(
    width * 2,
  )
  for (const line of noWrap.lines) {
    near(t, line.left, width * 2 - line.width)
  }
})

test('a line wider than the width is start-aligned', (t) => {
  // CSS start-aligns a line that overflows, whatever its alignment.
  const width = 50
  for (const textAlign of ['left', 'center', 'right', 'justify'] as const) {
    const ltr = new Paragraph(TEXT, { ...STYLE, textAlign, noWrap: true }).layout(width)
    t.true(ltr.lines[0].width > width)
    t.is(ltr.lines[0].left, 0, textAlign)
    const rtl = new Paragraph(TEXT, { ...STYLE, textAlign, noWrap: true, direction: 'rtl' }).layout(width)
    near(t, rtl.lines[0].left, width - rtl.lines[0].width)
  }
})

test('noWrap text is as narrow as its lines', (t) => {
  const wrapping = new Paragraph(TEXT, STYLE).layout(0)
  const noWrap = new Paragraph(TEXT, { ...STYLE, noWrap: true }).layout(0)
  t.true(wrapping.minIntrinsicWidth < wrapping.maxIntrinsicWidth)
  near(t, noWrap.minIntrinsicWidth, noWrap.maxIntrinsicWidth)
  near(t, noWrap.maxIntrinsicWidth, wrapping.maxIntrinsicWidth)
  // Truncation leaves the intrinsic widths alone.
  const truncated = new Paragraph(TEXT, { ...STYLE, noWrap: true, ellipsis: '…' }).layout(50)
  near(t, truncated.minIntrinsicWidth, wrapping.maxIntrinsicWidth)
})

// The leftmost and rightmost inked columns of the first line box.
function inkSpan(paragraph: Paragraph, layout: ReturnType<Paragraph['layout']>) {
  const width = 400
  const ctx = createCanvas(width, Math.ceil(layout.lineHeight)).getContext('2d')
  fillParagraph(ctx, paragraph, 0, 0)
  const { data } = ctx.getImageData(0, 0, width, Math.ceil(layout.lineHeight))
  let left = width
  let right = -1
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) {
      const x = (i >> 2) % width
      left = Math.min(left, x)
      right = Math.max(right, x)
    }
  }
  return [left, right]
}

test('justify starts its lines where left does, letter spacing included', (t) => {
  const width = 300
  const style: ParagraphStyle = { ...STYLE, letterSpacing: 4 }
  const left = new Paragraph(TEXT, { ...style, textAlign: 'left' })
  const justify = new Paragraph(TEXT, { ...style, textAlign: 'justify' })
  const leftLayout = left.layout(width)
  const justifyLayout = justify.layout(width)
  t.is(justifyLayout.lines.length, leftLayout.lines.length)
  for (const [i, line] of justifyLayout.lines.entries()) {
    t.is(line.left, 0)
    near(t, line.width, line.hardBreak ? leftLayout.lines[i].width : width)
  }
  const [leftInk] = inkSpan(left, leftLayout)
  const [justifyInk, justifyRight] = inkSpan(justify, justifyLayout)
  t.is(justifyInk, leftInk)
  t.true(justifyRight < width, `justified ink ends at ${justifyRight}`)
})

test('justify on noWrap text paints like start', (t) => {
  // Skia is not asked to justify noWrap text, whose lines it would
  // right-align in RTL at the unbounded layout width, where floats are too
  // coarse to keep a multi-run line's runs in place.
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Harmattan-Regular.ttf')))
  const text = 'مرحبا hello مرحبا world'
  const style: ParagraphStyle = { fontFamily: 'Harmattan, Iosevka Slab', fontSize: 20.3, noWrap: true }
  for (const direction of ['ltr', 'rtl'] as const) {
    const paint = (textAlign: ParagraphStyle['textAlign']) => {
      const ctx = createCanvas(400, 40).getContext('2d')
      const paragraph = new Paragraph(text, { ...style, textAlign, direction })
      const { lines } = paragraph.layout(300)
      fillParagraph(ctx, paragraph, 0, 0)
      return { left: lines[0].left, pixels: Buffer.from(ctx.getImageData(0, 0, 400, 40).data).toString('base64') }
    }
    t.deepEqual(paint('justify'), paint('start'), direction)
  }
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

test('painting before layout throws', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  const paragraph = new Paragraph(TEXT, STYLE)
  t.throws(() => fillParagraph(ctx, paragraph, 0, 0), { message: /layout/ })
  t.throws(() => strokeParagraph(ctx, paragraph, 0, 0), { message: /layout/ })
  paragraph.layout(1000)
  t.notThrows(() => fillParagraph(ctx, paragraph, 0, 0))
  t.notThrows(() => strokeParagraph(ctx, paragraph, 0, 0))
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
  fillParagraph(actualCtx, paragraph, x, y)

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
  strokeParagraph(ctx, paragraph, 10, 10)
  const stroked = inkSum(ctx)
  ctx.clearRect(0, 0, 300, 120)
  fillParagraph(ctx, paragraph, 10, 10)
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
  fillParagraph(ctx, paragraph, 10, 10)
  const { data } = ctx.getImageData(0, 0, 200, 100)
  let red = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 200 && data[i + 1] === 0 && data[i + 3] > 0) red++
  }
  t.true(red > 0)
})
