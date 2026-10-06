import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, createCanvas, type SKRSContext2D } from '../index'
import { Paragraph, fillParagraph, type ParagraphContent, type ParagraphStyle } from '../extensions'

const __dirname = dirname(fileURLToPath(import.meta.url))

type TextRendering = SKRSContext2D['textRendering']

test.before((t) => {
  const fonts = join(__dirname, 'fonts')
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'Lato-Regular.ttf'), 'LS Lato'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'iosevka-slab-regular.ttf'), 'LS Iosevka'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'NotoSansDevanagari-Regular.ttf'), 'LS Devanagari'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'Harmattan-Regular.ttf'), 'LS Harmattan'))
})

const LATO: ParagraphStyle = { fontFamily: 'LS Lato', fontSize: 20, lineHeight: 40 }
const DEVANAGARI: ParagraphStyle = { ...LATO, fontFamily: 'LS Devanagari' }
const HARMATTAN: ParagraphStyle = { ...LATO, fontFamily: 'LS Harmattan', direction: 'rtl' }
const IOSEVKA_RTL: ParagraphStyle = { ...LATO, fontFamily: 'LS Iosevka', direction: 'rtl' }

function near(t: import('ava').ExecutionContext, actual: number, expected: number, message: string, epsilon = 0.02) {
  t.true(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} is not within ${epsilon} of ${expected}`)
}

function measureText(text: string, style: ParagraphStyle, letterSpacing: number, textRendering: TextRendering) {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.textRendering = textRendering
  ctx.font = `${style.fontSize}px '${style.fontFamily}'`
  ctx.letterSpacing = `${letterSpacing}px`
  ctx.direction = style.direction ?? 'ltr'
  return ctx.measureText(text).width
}

const AB = { 10: 41.328125, [-3]: 15.328125 }

// Chrome 154 (headless, macOS), with the same fonts at 20px: the width of a
// `white-space: pre` span holding the text, with `letter-spacing` 10px and
// -3px. Canvas measureText with `ctx.letterSpacing` agrees to 0.02px. Blink
// adds no letter spacing after a character it treats as a zero-width space
// (Character::TreatAsZeroWidthSpace): the default-ignorable code points, which
// draw nothing, and U+FFFC. It reads the first UTF-16 unit of each HarfBuzz
// cluster, so a code point past the BMP that starts one is spaced, ignorable
// or not (U+E0001), and one HarfBuzz merges into the cluster before it, like
// a variation selector, is not.
const CHROME: Array<[string, string, ParagraphStyle, Record<number, number>]> = [
  ['plain', 'ab', LATO, AB],
  ['ZWSP', 'a\u200Bb', LATO, AB],
  ['WJ', 'a\u2060b', LATO, AB],
  ['ZWJ', 'a\u200Db', LATO, AB],
  ['ZWNJ', 'a\u200Cb', LATO, AB],
  ['ZWNBSP', 'a\uFEFFb', LATO, AB],
  ['soft hyphen', 'a\u00ADb', LATO, AB],
  ['LRM', 'a\u200Eb', LATO, AB],
  ['VS16', 'a\uFE0Fb', LATO, AB],
  ['VS17', 'a\u{E0100}b', LATO, AB],
  ['ZWSP first', '\u200Bab', LATO, AB],
  ['ZWSP last', 'ab\u200B', LATO, AB],
  ['ZWSPs', 'a\u200B\u200B\u200Bb', LATO, AB],
  ['ZWSP alone', '\u200B', LATO, { 10: 0, [-3]: 0 }],
  // @effing/canvas draws a line or paragraph separator as these two.
  ['NBSP and ZWSP', 'a\u00A0\u200Bb', LATO, { 10: 55.1875, [-3]: 16.1875 }],
  ['a tag past the BMP', 'a\u{E0001}b', LATO, { 10: 51.328125, [-3]: 12.328125 }],
  // ZWJ still makes the half form (22.5625 without spacing).
  ['Devanagari ZWJ', '\u0915\u094D\u200D\u0937', DEVANAGARI, { 10: 42.5625, [-3]: 16.5625 }],
  ['Devanagari ZWSP', '\u0915\u200B\u0916', DEVANAGARI, { 10: 51.734375, [-3]: 25.734375 }],
  // Arabic is cursive, which neither spaces; ZWJ and ZWNJ still join and break.
  ['Arabic ZWJ', '\u0644\u200D\u0627', HARMATTAN, { 10: 7.96875, [-3]: 7.96875 }],
  ['Arabic ZWNJ', '\u0644\u200C\u0627', HARMATTAN, { 10: 12.9375, [-3]: 12.9375 }],
]

test('no letter spacing after default-ignorable code points, as in Chrome', (t) => {
  for (const [name, text, style, widths] of CHROME) {
    for (const [letterSpacing, expected] of Object.entries(widths).map(([k, v]) => [Number(k), v])) {
      const message = `${name}, ${letterSpacing}px`
      const layout = new Paragraph(text, { ...style, letterSpacing }).layout(1000)
      near(t, layout.maxIntrinsicWidth, expected, `${message}: maxIntrinsicWidth`)
      near(t, layout.lines[0].width, expected, `${message}: line width`)
      near(t, measureText(text, style, letterSpacing, 'geometricPrecision'), expected, `${message}: measureText`)
    }
  }
})

test('a carriage return in a paragraph gets no letter spacing, as in Chrome', (t) => {
  // Chrome's canvas draws it as a space, which upstream's fillText doesn't.
  near(t, new Paragraph('a\rb', { ...LATO, letterSpacing: 10 }).layout(1000).maxIntrinsicWidth, AB[10], 'CR')
})

test("fillText keeps upstream's letter spacing unless geometricPrecision", (t) => {
  near(t, measureText('a\u200Bb', LATO, 10, 'auto'), 51.32, 'auto')
  near(t, measureText('a\u200Bb', LATO, 10, 'geometricPrecision'), AB[10], 'geometricPrecision')
})

function paintParagraph(text: ParagraphContent, style: ParagraphStyle) {
  const ctx = createCanvas(240, 40).getContext('2d')
  const paragraph = new Paragraph(text, style)
  paragraph.layout(220)
  fillParagraph(ctx, paragraph, 10, 0)
  return ctx.getImageData(0, 0, 240, 40).data
}

function paintText(text: string, style: ParagraphStyle, letterSpacing: number, align: CanvasTextAlign) {
  const ctx = createCanvas(240, 40).getContext('2d')
  ctx.textRendering = 'geometricPrecision'
  ctx.font = `${style.fontSize}px '${style.fontFamily}'`
  ctx.letterSpacing = `${letterSpacing}px`
  ctx.direction = style.direction ?? 'ltr'
  ctx.textAlign = align
  ctx.fillText(text, align === 'center' ? 120 : align === 'right' ? 230 : 10, 28)
  return ctx.getImageData(0, 0, 240, 40).data
}

function sameInk(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  for (let i = 3; i < a.length; i += 4) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

test('text paints as it does without its default-ignorable code points', (t) => {
  const ltr = [
    'a\u200Bb',
    '\u200Bab',
    'ab\u200B',
    '\u200B\u200Bhello\u200B world\u200B',
    'a\u2060b\u200Dc\u200Cd\u00ADe',
  ]
  // Iosevka has no Hebrew; its .notdef boxes are spaced like letters. A
  // ZWSP between them splits the run, which moves them by a fraction of a
  // pixel even without letter spacing, so that one is compared by width.
  const rtl = ['\u200B\u05E9\u05DC\u05D5\u05DD', '\u05E9\u05DC\u05D5\u05DD\u200B']
  const strip = (text: string) => text.replace(/[\u00AD\u200B-\u200D\u2060]/g, '')
  for (const letterSpacing of [10, -3, 2.5]) {
    for (const [texts, base] of [
      [ltr, LATO],
      [rtl, IOSEVKA_RTL],
    ] as const) {
      for (const text of texts) {
        for (const textAlign of ['left', 'center', 'right'] as const) {
          const style = { ...base, letterSpacing, textAlign }
          const message = `${JSON.stringify(text)}, ${letterSpacing}px, ${textAlign}`
          t.true(sameInk(paintParagraph(text, style), paintParagraph(strip(text), style)), `${message}: paragraph`)
          t.true(
            sameInk(
              paintText(text, base, letterSpacing, textAlign),
              paintText(strip(text), base, letterSpacing, textAlign),
            ),
            `${message}: fillText`,
          )
        }
      }
    }
    const style = { ...IOSEVKA_RTL, letterSpacing }
    const text = '\u05E9\u05DC\u200B\u05D5\u05DD'
    near(t, new Paragraph(text, style).layout(1000).lines[0].width, 4 * (10 + letterSpacing), 'RTL ZWSP inside')
    near(t, measureText(text, style, letterSpacing, 'geometricPrecision'), 4 * (10 + letterSpacing), 'RTL ZWSP inside')
  }
})

test('a ZWSP beside a placeholder adds no letter spacing', (t) => {
  // Chrome: 56.328125 for both, an inline-block 15px wide between "a" and "b",
  // which letter spacing leaves alone.
  const box = { width: 15, height: 10 }
  const style = { ...LATO, letterSpacing: 10 }
  const plain = new Paragraph(['a', box, 'b'], style).layout(1000)
  const zwsp = new Paragraph(['a\u200B', box, '\u200Bb'], style).layout(1000)
  near(t, plain.maxIntrinsicWidth, 56.328125, 'plain')
  near(t, zwsp.maxIntrinsicWidth, 56.328125, 'ZWSP')
  near(t, zwsp.lines[0].width, plain.lines[0].width, 'line', 0.001)
  near(t, zwsp.placeholders[0]!.x, plain.placeholders[0]!.x, 'placeholder', 0.001)
})

test('lines break and measure at ZWSPs as in Chrome', (t) => {
  // Chrome: the lines' text from Range.getClientRects, each line's width from
  // its first character's left to its last one's right, and min-content and
  // max-content as in effing-paragraph-metrics.spec.ts.
  const cases: Array<[string, number, number, Array<[number, number, number]>, number, number]> = [
    [
      'aaaa\u200Bbbbb\u200Bcccc',
      10,
      120,
      [
        [0, 5, 80.5625],
        [5, 10, 84.734375],
        [10, 14, 77.375],
      ],
      84.71875,
      242.640625,
    ],
    [
      'aaaa\u200Bbbbb\u200Bcccc',
      -3,
      60,
      [
        [0, 5, 28.5625],
        [5, 14, 58.09375],
      ],
      32.71875,
      86.640625,
    ],
    ['ab\u200Bcd ef', 10, 1000, [[0, 8, 132.921875]], 41.328125, 132.921875],
    ['ab\u200Bcd ef', -3, 1000, [[0, 8, 41.921875]], 15.328125, 41.921875],
  ]
  for (const [text, letterSpacing, width, lines, min, max] of cases) {
    const message = `${JSON.stringify(text)}, ${letterSpacing}px at ${width}px`
    const layout = new Paragraph(text, { ...LATO, letterSpacing }).layout(width)
    t.deepEqual(
      layout.lines.map((line) => [line.startIndex, line.endIndex]),
      lines.map(([start, end]) => [start, end]),
      message,
    )
    layout.lines.forEach((line, i) => near(t, line.width, lines[i][2], `${message}: line ${i}`))
    near(t, layout.minIntrinsicWidth, min, `${message}: minIntrinsicWidth`)
    near(t, layout.maxIntrinsicWidth, max, `${message}: maxIntrinsicWidth`)
  }
})
