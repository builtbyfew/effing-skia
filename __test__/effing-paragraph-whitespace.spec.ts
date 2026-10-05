import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, createCanvas } from '../index'
import { Paragraph, fillParagraph, type ParagraphStyle } from '../extensions'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Iosevka Slab is monospaced: every glyph used here, the space included,
// advances 10px at 20px.
const STYLE: ParagraphStyle = { fontFamily: 'Iosevka Slab', fontSize: 20, lineHeight: 30 }
const KEEP: ParagraphStyle = { ...STYLE, keepTrailingWhitespace: true }

test.before((t) => {
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf')))
})

function near(t: import('ava').ExecutionContext, actual: number, expected: number, epsilon = 0.01) {
  t.true(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`)
}

// Expected lines measured in Chrome 154 (headless, macOS) from `<div
// style="font: 20px <this font>; white-space: pre | pre-wrap; text-align: A;
// width: W" dir="D">TEXT</div>`, with Range.getClientRects() on each
// character: the line's left edge is where its first space or glyph starts,
// visually, and its width runs to where its last one ends. `pre` and
// `pre-wrap` gave the same boxes in every case where both apply: the spaces
// before a hard break or the end of the text count, even when they overflow
// the line, and in RTL they lie left of the text.
const CHROME_LINES: Array<{
  name: string
  text: string
  width: number
  style: Partial<ParagraphStyle>
  lines: Array<[left: number, width: number]>
  // Only for wrapping text: `pre-wrap` alone.
  wraps?: boolean
}> = [
  {
    name: 'right',
    text: 'abc   \ndef',
    width: 200,
    style: { textAlign: 'right' },
    lines: [
      [140, 60],
      [170, 30],
    ],
  },
  {
    name: 'center',
    text: 'abc   \ndef',
    width: 200,
    style: { textAlign: 'center' },
    lines: [
      [70, 60],
      [85, 30],
    ],
  },
  {
    name: 'left',
    text: 'abc   \ndef',
    width: 200,
    style: { textAlign: 'left' },
    lines: [
      [0, 60],
      [0, 30],
    ],
  },
  { name: 'end of text', text: 'abc   ', width: 200, style: { textAlign: 'right' }, lines: [[140, 60]] },
  // pre-wrap only: the spaces at a soft wrap hang.
  {
    name: 'soft wrap',
    wraps: true,
    text: 'abcdef   ghij',
    width: 100,
    style: { textAlign: 'right' },
    lines: [
      [40, 60],
      [60, 40],
    ],
  },
  {
    name: 'overflowing center',
    text: 'abc   \nd',
    width: 55,
    style: { textAlign: 'center' },
    lines: [
      [0, 60],
      [22.5, 10],
    ],
  },
  {
    name: 'overflowing right',
    text: 'abc   \nd',
    width: 55,
    style: { textAlign: 'right' },
    lines: [
      [0, 60],
      [45, 10],
    ],
  },
  {
    name: 'letter spacing',
    text: 'abc   \ndef',
    width: 200,
    style: { textAlign: 'right', letterSpacing: 4 },
    lines: [
      [116, 84],
      [158, 42],
    ],
  },
  {
    name: 'rtl left',
    text: 'abc   \ndef',
    width: 200,
    style: { textAlign: 'left', direction: 'rtl' },
    lines: [
      [0, 60],
      [0, 30],
    ],
  },
  {
    name: 'rtl right',
    text: 'abc   \ndef',
    width: 200,
    style: { textAlign: 'right', direction: 'rtl' },
    lines: [
      [140, 60],
      [170, 30],
    ],
  },
  {
    name: 'rtl center',
    text: 'abc   \ndef',
    width: 200,
    style: { textAlign: 'center', direction: 'rtl' },
    lines: [
      [70, 60],
      [85, 30],
    ],
  },
  {
    name: 'rtl overflowing',
    text: 'abc   \nd',
    width: 55,
    style: { textAlign: 'left', direction: 'rtl' },
    lines: [
      [-5, 60],
      [0, 10],
    ],
  },
  {
    // Chrome justifies the first line (its space hangs) and not the second,
    // which ends at a hard break and keeps its spaces.
    name: 'justify',
    wraps: true,
    text: 'abc def ghi jkl   \nmn',
    width: 100,
    style: { textAlign: 'justify' },
    lines: [
      [0, 100],
      [0, 100],
      [0, 20],
    ],
  },
  {
    // With two spaces the hard-broken line is 90px, which shows it is not
    // justified.
    name: 'justify, short hard-broken line',
    wraps: true,
    text: 'abc def ghi jkl  \nmn',
    width: 100,
    style: { textAlign: 'justify' },
    lines: [
      [0, 100],
      [0, 90],
      [0, 20],
    ],
  },
  {
    name: 'rtl justify, short hard-broken line',
    wraps: true,
    text: 'abc def ghi jkl  \nmn',
    width: 100,
    style: { textAlign: 'justify', direction: 'rtl' },
    lines: [
      [0, 100],
      [10, 90],
      [80, 20],
    ],
  },
  {
    // The first line's space hangs at the soft wrap; the second keeps its
    // spaces before the hard break.
    name: 'soft wrap then hard break',
    wraps: true,
    text: 'abcd ef   \ngh',
    width: 60,
    style: { textAlign: 'right' },
    lines: [
      [20, 40],
      [10, 50],
      [40, 20],
    ],
  },
  // A hard break that ends the text is not part of the line before it.
  {
    name: 'final newline',
    text: 'ab   \n',
    width: 400,
    style: {},
    lines: [
      [0, 50],
      [0, 0],
    ],
  },
  {
    name: 'rtl final newline',
    text: 'ab   \n',
    width: 400,
    style: { direction: 'rtl', textAlign: 'start' },
    lines: [
      [350, 50],
      [400, 0],
    ],
  },
  {
    name: 'rtl final CRLF',
    text: 'ab   \r\n',
    width: 400,
    style: { direction: 'rtl', textAlign: 'start' },
    lines: [
      [350, 50],
      [400, 0],
    ],
  },
]

test('kept trailing whitespace lays out lines as Chrome does', (t) => {
  for (const { name, text, width, style, lines, wraps } of CHROME_LINES) {
    for (const noWrap of wraps ? [false] : [false, true]) {
      const layout = new Paragraph(text, { ...KEEP, ...style, noWrap }).layout(width)
      t.deepEqual(
        layout.lines.map((line) => [Math.round(line.left * 1000) / 1000, Math.round(line.width * 1000) / 1000]),
        lines,
        `${name}${noWrap ? ', noWrap' : ''}`,
      )
    }
  }
})

test('kept trailing whitespace is in the line text and widths', (t) => {
  const text = 'abc   \ndef  '
  const layout = new Paragraph(text, KEEP).layout(200)
  t.deepEqual(
    layout.lines.map((line) => text.slice(line.startIndex, line.endIndex)),
    ['abc   ', 'def  '],
  )
  // Measured in Chrome as above: an inline-block of `abc   ` is 60px wide
  // under both `pre` and `pre-wrap`.
  near(t, layout.longestLine, 60)
  near(t, layout.maxIntrinsicWidth, 60)
  const hanging = new Paragraph(text, STYLE).layout(200)
  t.deepEqual(
    hanging.lines.map((line) => text.slice(line.startIndex, line.endIndex)),
    ['abc', 'def'],
  )
  near(t, hanging.longestLine, 30)
})

test('a lone CR or NEL is not a hard break', (t) => {
  for (const noWrap of [false, true]) {
    const style = { ...KEEP, noWrap, ellipsis: noWrap ? '…' : undefined }
    // Measured in Chrome 154 with `white-space: pre` and the text set through
    // textContent (the HTML parser would turn the CR into LF): one line, 50px
    // wide, the CR taking no width.
    const cr = new Paragraph('ab\r   ', style).layout(400)
    t.deepEqual(
      cr.lines.map((line) => [line.startIndex, line.endIndex]),
      [[0, 6]],
    )
    near(t, cr.lines[0].width, 50)
    // NEL draws from a fallback font, whose advance is not Chrome's; the line
    // is the NEL's line plus the kept spaces.
    const nel = new Paragraph('ab\u0085   ', style).layout(400)
    t.deepEqual(
      nel.lines.map((line) => [line.startIndex, line.endIndex]),
      [[0, 6]],
    )
    const bare = new Paragraph('ab\u0085', style).layout(400)
    near(t, nel.lines[0].width, bare.lines[0].width + 30)
  }
})

test('LF, VT, FF, CRLF, LS and PS are hard breaks', (t) => {
  for (const separator of ['\n', '\v', '\f', '\r\n', '\u2028', '\u2029']) {
    const text = `ab  ${separator}cd`
    for (const noWrap of [false, true]) {
      const style = { ...KEEP, noWrap, ellipsis: noWrap ? '…' : undefined }
      const layout = new Paragraph(text, style).layout(400)
      t.deepEqual(
        layout.lines.map((line) => [line.startIndex, line.endIndex]),
        [
          [0, 4],
          [4 + separator.length, 6 + separator.length],
        ],
        JSON.stringify([separator, noWrap]),
      )
      near(t, layout.lines[0].width, 40)
    }
  }
})

test('text of only hard breaks keeps its empty lines', (t) => {
  for (const text of ['\n', '\n\n', '\r\n\r\n', '\u2028\n']) {
    const plain = new Paragraph(text, STYLE).layout(400)
    const kept = new Paragraph(text, KEEP).layout(400)
    t.deepEqual(kept.lines, plain.lines, JSON.stringify(text))
    t.true(kept.lines.every((line) => line.width === 0))
  }
})

test('a hard break that ends the text stays out of the line before it', (t) => {
  for (const text of ['ab   \n', 'ab   \r\n', 'cd\nab   \n']) {
    for (const direction of ['ltr', 'rtl'] as const) {
      const layout = new Paragraph(text, { ...KEEP, direction }).layout(400)
      const line = layout.lines.find((l) => text.slice(l.startIndex, l.endIndex).startsWith('ab'))!
      t.is(text.slice(line.startIndex, line.endIndex), 'ab   ', JSON.stringify([text, direction]))
      near(t, line.width, 50)
    }
  }
  const layout = new Paragraph('ab   \ncd   \n', KEEP).layout(400)
  t.deepEqual(
    layout.lines.slice(0, 2).map((line) => [line.startIndex, line.endIndex]),
    [
      [0, 5],
      [6, 11],
    ],
  )
})

// The leftmost inked column of the first line box.
function inkLeft(paragraph: Paragraph, height: number) {
  const width = 300
  const ctx = createCanvas(width, height).getContext('2d')
  fillParagraph(ctx, paragraph, 50, 0)
  const { data } = ctx.getImageData(0, 0, width, height)
  let left = width
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) left = Math.min(left, (i >> 2) % width)
  }
  return left - 50
}

test('kept trailing whitespace moves the glyphs it precedes', (t) => {
  const plain = new Paragraph('abc', STYLE)
  plain.layout(200)
  const glyphs = inkLeft(plain, 30)
  for (const [style, offset] of [
    [{ textAlign: 'right' }, 140],
    [{ textAlign: 'center' }, 70],
    [{ textAlign: 'left', direction: 'rtl' }, 30],
    [{ textAlign: 'right', direction: 'rtl' }, 170],
  ] as const) {
    for (const text of ['abc   ', 'abc   \n']) {
      const paragraph = new Paragraph(text, { ...KEEP, ...style })
      paragraph.layout(200)
      // Within a pixel: the glyphs land a hair off whole pixels.
      near(t, inkLeft(paragraph, 30), glyphs + offset, 1)
    }
  }
})
