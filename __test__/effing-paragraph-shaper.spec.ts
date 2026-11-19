import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, createCanvas } from '../index'
import { Paragraph, fillParagraph, type ParagraphContent, type ParagraphStyle } from '../extensions'

// The shaper engine (`engine: 'shaper'`, docs/effing.md) where it lays text
// out on its own: placeholders in its shaping, hard breaks in its bidi
// levels, and the line breaking it does around its own shapes.

const __dirname = dirname(fileURLToPath(import.meta.url))
const fonts = join(__dirname, 'fonts')

test.before((t) => {
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'iosevka-slab-regular.ttf'), 'SH Iosevka'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'Harmattan-Regular.ttf'), 'SH Harmattan'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'LiberationSans-Regular.woff'), 'SH Liberation'))
})

const SHAPER: ParagraphStyle = { fontSize: 20, lineHeight: 40, engine: 'shaper' }
const box = { width: 15, height: 10 }
const round = (x: number) => Math.round(x * 100) / 100

function layOut(parts: ParagraphContent, style: ParagraphStyle, width: number) {
  return new Paragraph(parts, { ...SHAPER, ...style }).layout(width)
}

function pixels(parts: ParagraphContent, style: ParagraphStyle) {
  const paragraph = new Paragraph(parts, { ...SHAPER, ...style })
  paragraph.layout(200)
  const ctx = createCanvas(200, 80).getContext('2d')
  fillParagraph(ctx, paragraph, 0, 0)
  return ctx.getImageData(0, 0, 200, 80).data
}

test('the letters on either side of a placeholder neither join nor kern', (t) => {
  // Chrome shapes the text on either side of an atomic inline apart: the
  // two behs take their isolated forms, and V and A keep their advances, as
  // SkParagraph has them.
  for (const [parts, fontFamily] of [
    [['ب', box, 'ب'], 'SH Harmattan'],
    [['V', box, 'A'], 'SH Liberation'],
  ] as const) {
    const style = { fontSize: 20, lineHeight: 40, fontFamily }
    const shaper = new Paragraph([...parts], { ...style, engine: 'shaper' }).layout(1000)
    const skparagraph = new Paragraph([...parts], { ...style, engine: 'skparagraph' }).layout(1000)
    t.is(round(shaper.lines[0].width), round(skparagraph.lines[0].width), fontFamily)
    t.is(round(shaper.placeholders[0]!.x), round(skparagraph.placeholders[0]!.x), fontFamily)
  }
})

test('a CRLF leaves the bidi levels of the line after it alone', (t) => {
  const style: ParagraphStyle = { fontFamily: 'SH Harmattan, SH Iosevka', direction: 'rtl' }
  for (const text of ['بت\r\n12 بت', 'x\r\nab cd']) {
    t.deepEqual(pixels(text, style), pixels(text.replace('\r\n', '\n'), style), JSON.stringify(text))
  }
})

test('a justified placeholder moves with the glyphs before it on screen', (t) => {
  const layout = layOut(
    [box, ' אבג ' + 'אבג'.repeat(8)],
    { fontFamily: 'SH Liberation', direction: 'rtl', textAlign: 'justify' },
    150,
  )
  t.is(round(layout.lines[0].width), 150)
  t.is(round(layout.placeholders[0]!.x), 135)
})

test('a soft hyphen that does not fit hides no later opportunity that does', (t) => {
  // "fo-" doesn't fit, "fof" does: the hyphen only counts where the line
  // breaks.
  const style: ParagraphStyle = { fontFamily: 'SH Liberation' }
  const whole = layOut('iA-o fo­f', style, 1000)
  const layout = layOut('iA-o fo­f', style, whole.maxIntrinsicWidth)
  t.deepEqual(
    layout.lines.map((line) => [line.startIndex, line.endIndex]),
    [[0, 9]],
  )
})

test('a word broken by break-word fits each line as it is shaped', (t) => {
  // Arabic letters cut from their neighbours take other forms, wider than
  // their joined advances.
  const layout = layOut('بببببببببب', { fontFamily: 'SH Harmattan', direction: 'rtl', overflowWrap: 'break-word' }, 30)
  t.true(layout.lines.length > 1)
  for (const line of layout.lines) {
    t.true(line.width <= 30, `${line.startIndex}-${line.endIndex}: ${line.width}`)
  }
})

test('kept trailing whitespace hangs and forces no wrap', (t) => {
  const layout = layOut('hello world  ', { fontFamily: 'SH Iosevka', keepTrailingWhitespace: true }, 115)
  t.deepEqual(
    layout.lines.map((line) => [line.startIndex, line.endIndex, round(line.width)]),
    [[0, 13, 130]],
  )
})

test('whitespace after a soft wrap hangs, a tab and an ideographic space too', (t) => {
  for (const text of ['aaa \tbbb ccc', 'aaa \u3000bbb ccc']) {
    const layout = layOut(text, { fontFamily: 'SH Iosevka' }, 25)
    t.deepEqual(
      layout.lines.map((line) => [line.startIndex, line.endIndex, line.hardBreak]),
      [
        [0, 3, false],
        [5, 8, false],
        [9, 12, true],
      ],
      JSON.stringify(text),
    )
  }
  // Up to the end of the hard line: the line before it is the last.
  const last = layOut('aa aaaaaaa \t', { fontFamily: 'SH Iosevka' }, 50)
  t.deepEqual(
    last.lines.map((line) => [line.startIndex, line.endIndex, line.hardBreak]),
    [
      [0, 2, false],
      [3, 10, true],
    ],
  )
  // Kept whitespace hangs at a soft wrap too.
  const kept = layOut('ac \t-aa', { fontFamily: 'SH Iosevka', keepTrailingWhitespace: true }, 25)
  t.deepEqual(
    kept.lines.map((line) => [line.startIndex, line.endIndex]),
    [
      [0, 2],
      [4, 5],
      [5, 7],
    ],
  )
})

test('a word broken by break-word at its soft hyphen fits as it is shaped', (t) => {
  // Joined across the soft hyphen the first piece fits; shaped on its own,
  // with the hyphen, it doesn't, and is cut further.
  const layout = layOut(
    'bbلbث\u00ADثbب',
    { fontFamily: 'SH Harmattan', direction: 'rtl', overflowWrap: 'break-word', letterSpacing: -1 },
    45,
  )
  for (const line of layout.lines) {
    t.true(line.width <= 45, `${line.startIndex}-${line.endIndex}: ${line.width}`)
  }
})
