import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts } from '../index'
import { Paragraph, type ParagraphContent, type ParagraphStyle } from '../extensions'

const __dirname = dirname(fileURLToPath(import.meta.url))

test.before((t) => {
  const fonts = join(__dirname, 'fonts')
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'iosevka-slab-regular.ttf'), 'WB Iosevka'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'Lato-Regular.ttf'), 'WB Lato'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'NotoSansDevanagari-Regular.ttf'), 'WB Devanagari'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'SourceHanSerifCN-Bold.ttf'), 'WB Source Han'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'Harmattan-Regular.ttf'), 'WB Harmattan'))
})

const IOSEVKA: ParagraphStyle = { fontFamily: 'WB Iosevka', fontSize: 20, lineHeight: 40 }
const LATO: ParagraphStyle = { ...IOSEVKA, fontFamily: 'WB Lato' }
const PH = (width: number) => ({ width, height: 10 })

function near(t: import('ava').ExecutionContext, actual: number, expected: number, message: string, epsilon = 0.02) {
  t.true(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} is not within ${epsilon} of ${expected}`)
}

// Chrome 154 (headless, macOS), with the same fonts at 20px: the width of a
// `float: left` div of `width: max-content` and of `width: min-content` holding
// the text, with each placeholder an `inline-block` span of its size. Plain
// text is `white-space: normal` (`pre-line` where it has a newline),
// keepTrailingWhitespace is `pre-wrap`, and noWrap is `pre`. Chrome rounds to
// 1/64 px.
const CHROME: Array<{ name: string; text: ParagraphContent; style: ParagraphStyle; min: number; max: number }> = [
  { name: 'words', text: 'ab cd ef gh', style: IOSEVKA, min: 20, max: 110 },
  { name: 'trailing spaces hang', text: 'ab cd  ', style: IOSEVKA, min: 20, max: 50 },
  {
    name: 'trailing spaces kept',
    text: 'ab cd  ',
    style: { ...IOSEVKA, keepTrailingWhitespace: true },
    min: 20,
    max: 70,
  },
  { name: 'hard breaks', text: 'ab\ncdef gh\nx', style: IOSEVKA, min: 40, max: 70 },
  { name: 'spaces before a hard break hang', text: 'ab  \ncd', style: IOSEVKA, min: 20, max: 20 },
  {
    name: 'spaces before a hard break kept',
    text: 'ab  \ncd',
    style: { ...IOSEVKA, keepTrailingWhitespace: true },
    min: 20,
    max: 40,
  },
  { name: 'a final hard break', text: 'abc\n', style: IOSEVKA, min: 30, max: 30 },
  // Spaces and tabs that start a line collapse away unless whitespace is
  // kept, as the layout collapses them in wrapping text (#19).
  { name: 'leading spaces collapse', text: '    ab', style: IOSEVKA, min: 20, max: 20 },
  {
    name: 'leading spaces kept',
    text: '    ab',
    style: { ...IOSEVKA, keepTrailingWhitespace: true },
    min: 20,
    max: 60,
  },
  { name: 'spaces after a hard break collapse', text: 'ab\n   cd', style: IOSEVKA, min: 20, max: 20 },
  {
    name: 'spaces after a hard break kept',
    text: 'ab\n   cd',
    style: { ...IOSEVKA, keepTrailingWhitespace: true },
    min: 20,
    max: 50,
  },
  { name: 'a leading tab and space collapse', text: '\t ab cd', style: IOSEVKA, min: 20, max: 50 },

  { name: 'CRLF', text: 'ab\r\ncdefg', style: IOSEVKA, min: 50, max: 50 },
  { name: 'a placeholder', text: ['ab ', PH(40), ' cd'], style: IOSEVKA, min: 40, max: 100 },
  { name: 'placeholders, then spaces', text: [PH(5), PH(40), 'a  '], style: IOSEVKA, min: 40, max: 55 },
  {
    name: 'placeholders, then kept spaces',
    text: [PH(5), PH(40), 'a  '],
    style: { ...IOSEVKA, keepTrailingWhitespace: true },
    min: 40,
    max: 75,
  },
  { name: 'letterSpacing', text: 'ab cdef', style: { ...IOSEVKA, letterSpacing: 2 }, min: 48, max: 84 },
  {
    name: 'letterSpacing, trailing spaces hang',
    text: 'ab cd  ',
    style: { ...IOSEVKA, letterSpacing: 2 },
    min: 24,
    max: 60,
  },
  {
    name: 'letterSpacing, trailing spaces kept',
    text: 'ab cd  ',
    style: { ...IOSEVKA, letterSpacing: 2, keepTrailingWhitespace: true },
    min: 24,
    max: 84,
  },
  // Letter spacing is not added to a placeholder.
  {
    name: 'letterSpacing and a placeholder',
    text: ['ab', PH(40), 'cd'],
    style: { ...IOSEVKA, letterSpacing: 2 },
    min: 40,
    max: 88,
  },
  { name: 'Lato, a hard break', text: 'The quick brown fox\njumps over', style: LATO, min: 56.797, max: 176.375 },
  {
    name: 'Lato, negative letterSpacing',
    text: 'The quick brown fox',
    style: { ...LATO, letterSpacing: -1 },
    min: 51.797,
    max: 157.375,
  },
  {
    name: 'Lato, letterSpacing and a placeholder',
    text: ['Wave ', PH(15), ' AVA'],
    style: { ...LATO, letterSpacing: 0.5 },
    min: 51.781,
    max: 115.094,
  },
  {
    name: 'noWrap',
    text: 'ab cd\nefghij',
    style: { ...IOSEVKA, noWrap: true, keepTrailingWhitespace: true },
    min: 60,
    max: 60,
  },
  // Intrinsic sizes ignore line clamping: Chrome's `-webkit-line-clamp: 1`
  // gives the same.
  { name: 'maxLines', text: 'ab\ncdefgh', style: { ...IOSEVKA, maxLines: 1, ellipsis: '…' }, min: 60, max: 60 },
  {
    name: 'noWrap, maxLines',
    text: 'ab\ncdefgh',
    style: { ...IOSEVKA, noWrap: true, maxLines: 1, ellipsis: '…' },
    min: 60,
    max: 60,
  },
]

test('the intrinsic widths are CSS min-content and max-content, at any width', (t) => {
  for (const { name, text, style, min, max } of CHROME) {
    for (const width of [Infinity, 1000, 30, 5]) {
      const layout = new Paragraph(text, style).layout(width)
      near(t, layout.minIntrinsicWidth, min, `${name} at ${width}: minIntrinsicWidth`)
      near(t, layout.maxIntrinsicWidth, max, `${name} at ${width}: maxIntrinsicWidth`)
    }
  }
})

test('maxIntrinsicWidth does not depend on the layouts before', (t) => {
  // SkParagraph's figure was the sum of the lines broken at the last width,
  // trailing spaces included, and pieces left it at an earlier layout's.
  for (const [text, widths] of [
    ['  a\n', [5, 50, 5]],
    ['ab cd Overlongwordhere ef', [Infinity, 60, 1000, 60]],
    ['ab cd ef gh ij kl', [30, Infinity, 30]],
  ] as const) {
    const paragraph = new Paragraph(text, IOSEVKA)
    for (const width of widths) {
      const relaid = paragraph.layout(width)
      const fresh = new Paragraph(text, IOSEVKA).layout(width)
      const unbounded = new Paragraph(text, IOSEVKA).layout(Infinity)
      t.is(relaid.maxIntrinsicWidth, fresh.maxIntrinsicWidth, `${text} at ${width}`)
      t.is(relaid.maxIntrinsicWidth, unbounded.maxIntrinsicWidth, `${text} at ${width}`)
    }
  }
})

test('maxLines and the ellipsis leave the intrinsic widths alone', (t) => {
  const text = 'ab cd\nThe quick brown fox\nمرحبا بالعالم xyz\n  ef  \n'
  for (const mode of [
    {},
    { noWrap: true },
    { keepTrailingWhitespace: true },
    { noWrap: true, direction: 'rtl' },
  ] as const) {
    const style: ParagraphStyle = { ...LATO, fontFamily: 'WB Lato, WB Harmattan', ...mode }
    const free = new Paragraph(text, style).layout(Infinity)
    for (const clamp of [{ maxLines: 1 }, { maxLines: 2, ellipsis: '…' }, { ellipsis: '…' }]) {
      for (const width of [Infinity, 50]) {
        const clamped = new Paragraph(text, { ...style, ...clamp }).layout(width)
        const name = `${JSON.stringify(mode)} ${JSON.stringify(clamp)} at ${width}`
        t.is(clamped.maxIntrinsicWidth, free.maxIntrinsicWidth, name)
        t.is(clamped.minIntrinsicWidth, free.minIntrinsicWidth, name)
      }
    }
  }
})

test('the text laid out at maxIntrinsicWidth breaks only at hard breaks', (t) => {
  const lines = (layout: ReturnType<Paragraph['layout']>) =>
    layout.lines.map((line) => [line.startIndex, line.endIndex])
  for (const [text, style] of [
    ['The quick brown fox\njumps over the lazy dog', LATO],
    // Adding the clusters up in another order than SkParagraph's line breaker
    // does gives 48.999996 and 2053.4998 for lines 49 and 2053.5 wide, which
    // it then breaks: the figure is rounded up to the breaker's 0.01px.
    [[PH(15), 'quick '], { ...IOSEVKA, fontSize: 13, letterSpacing: 0.3 }],
    [[PH(2000), 'brown '], { ...IOSEVKA, letterSpacing: 0.7 }],
    // A negative letter spacing gives the vowel sign, which has no advance of
    // its own, a negative width, so the line breaker needs the widest the line
    // gets on the way, 1px wider than the line.
    ['ab स्ते', { ...IOSEVKA, fontFamily: 'WB Devanagari', letterSpacing: -1 }],
  ] as Array<[ParagraphContent, ParagraphStyle]>) {
    const unbounded = new Paragraph(text, style).layout(Infinity)
    const fitted = new Paragraph(text, style).layout(unbounded.maxIntrinsicWidth)
    t.deepEqual(lines(fitted), lines(unbounded), JSON.stringify(text))
    t.true(unbounded.maxIntrinsicWidth >= unbounded.longestLine)
  }
})

test('an ellipsis widens only the line it ends', (t) => {
  // A negative letter spacing gives the zero-width language tag a negative
  // width, which its RTL run's painted extent does not show: line 0 came out
  // 18px wide, 1px more than without the ellipsis, as the line Skia
  // ellipsized was measured by its runs and so was every other line. (A ZWSP
  // gets no letter spacing, as in Chrome; U+E0001 still does.)
  const text = 'ab\u{E0001}\ncd ef gh'
  for (const direction of ['ltr', 'rtl'] as const) {
    const style: ParagraphStyle = { ...IOSEVKA, letterSpacing: -1, direction, maxLines: 2 }
    const clamped = new Paragraph(text, { ...style, ellipsis: '…' }).layout(40)
    const plain = new Paragraph(text, style).layout(40)
    t.is(clamped.lines.length, 2)
    t.is(clamped.lines[0].width, plain.lines[0].width, direction)
    near(t, clamped.lines[0].width, 17, direction)
    // The ellipsis line includes the ellipsis: 'cd' and '…'.
    t.true(clamped.lines[1].width > plain.lines[1].width, direction)
  }
})

test('the empty line after a final hard break is at the end of the text', (t) => {
  const breaks = ['\n', '\r\n', '\u2028', '\u2029', '\v', '\f']
  const styles: Array<[string, ParagraphStyle, number]> = [
    ['whole', IOSEVKA, 100],
    ['unbounded', IOSEVKA, Infinity],
    ['kept whitespace', { ...IOSEVKA, keepTrailingWhitespace: true }, 100],
    ['maxLines', { ...IOSEVKA, maxLines: 3, ellipsis: '…' }, 100],
    ['rtl', { ...IOSEVKA, direction: 'rtl' }, 100],
    ['noWrap', { ...IOSEVKA, noWrap: true }, 100],
    ['noWrap with an ellipsis', { ...IOSEVKA, noWrap: true, ellipsis: '…' }, 100],
    // A word wider than the line splits the text into pieces.
    ['pieces', IOSEVKA, 50],
    ['pieces, break-word', { ...IOSEVKA, overflowWrap: 'break-word' }, 50],
  ]
  for (const brk of breaks) {
    for (const [name, style, width] of styles) {
      for (const text of [`ab ${brk}`, `Overlongword ab${brk}`, `ab${brk}${brk}`]) {
        const { lines } = new Paragraph(text, style).layout(width)
        const message = `${JSON.stringify(text)}, ${name}`
        const last = lines.at(-1)!
        t.deepEqual(
          [last.startIndex, last.endIndex, last.width, last.hardBreak],
          [text.length, text.length, 0, true],
          message,
        )
        t.true(lines.at(-2)!.endIndex <= text.length - brk.length, message)
      }
    }
  }
  // An empty line between two hard breaks starts after the first.
  const { lines } = new Paragraph('ab\r\n\r\n', IOSEVKA).layout(100)
  t.deepEqual(
    lines.map((line) => [line.startIndex, line.endIndex]),
    [
      [0, 2],
      [4, 4],
      [6, 6],
    ],
  )
})

test('spaces after placeholders make no line of their own', (t) => {
  const lines = (layout: ReturnType<Paragraph['layout']>) =>
    layout.lines.map((line) => [line.startIndex, line.endIndex, line.hardBreak])
  // The text a fuzzer reported as giving a second, empty line in #15 was
  // 'a', U+2028 and a space, which its output showed as 'a  ': the line after
  // the line separator, a hard break, as after an LF.
  for (const style of [
    IOSEVKA,
    { ...IOSEVKA, keepTrailingWhitespace: true },
    { ...IOSEVKA, maxLines: 1 },
    { ...IOSEVKA, maxLines: 1, ellipsis: '…' },
  ]) {
    const layout = new Paragraph([PH(5), PH(40), 'a  '], style).layout(Infinity)
    t.deepEqual(lines(layout), [[0, style.keepTrailingWhitespace ? 5 : 3, true]])
    t.false(layout.didExceedMaxLines)
    const keepAll = new Paragraph([PH(40), '中文  '], {
      ...style,
      fontFamily: 'WB Source Han',
      wordBreak: 'keep-all',
    }).layout(100)
    t.deepEqual(lines(keepAll), [[0, style.keepTrailingWhitespace ? 5 : 3, true]])
    t.false(keepAll.didExceedMaxLines)
  }
  for (const brk of ['\n', '\u2028']) {
    const layout = new Paragraph([PH(5), PH(40), `a${brk} `], { ...IOSEVKA, maxLines: 1 }).layout(Infinity)
    t.deepEqual(lines(layout), [[0, 3, true]])
    t.true(layout.didExceedMaxLines)
  }
})
