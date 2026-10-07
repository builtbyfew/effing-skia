import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test, { type ExecutionContext } from 'ava'

import { GlobalFonts, createCanvas } from '../index'
import { Paragraph, fillParagraph, type ParagraphLayout, type ParagraphStyle } from '../extensions'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Every expected line and min-content width below comes from Chrome 154
// (headless, macOS): the text in a `white-space: normal` div of the given
// width with the CSS shown, the same font file loaded with @font-face, each
// line's text range and width read back with Range.getClientRects, and
// min-content as the width of a `width: min-content` box. Iosevka Slab
// advances every character 10px at 20px, so its widths are exact.
const IOSEVKA: ParagraphStyle = { fontFamily: 'WB Iosevka', fontSize: 20 }
const LATO: ParagraphStyle = { fontFamily: 'WB Lato', fontSize: 20 }
const HAN: ParagraphStyle = { fontFamily: 'WB Source Han', fontSize: 20 }
const DEVANAGARI: ParagraphStyle = { fontFamily: 'WB Devanagari', fontSize: 20 }
const ARABIC: ParagraphStyle = { fontFamily: 'WB Harmattan', fontSize: 20, direction: 'rtl', textAlign: 'start' }

test.before((t) => {
  const fonts = join(__dirname, 'fonts')
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'iosevka-slab-regular.ttf'), 'WB Iosevka'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'Lato-Regular.ttf'), 'WB Lato'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'SourceHanSerifCN-Bold.ttf'), 'WB Source Han'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'Harmattan-Regular.ttf'), 'WB Harmattan'))
  // Noto Sans Devanagari (OFL), subset to Devanagari and Basic Latin.
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'NotoSansDevanagari-Regular.ttf'), 'WB Devanagari'))
})

// A line as [startIndex, endIndex, width], or [startIndex, endIndex, width,
// left] where its left edge matters.
type Line = [number, number, number] | [number, number, number, number]

function expectLines(t: ExecutionContext, layout: ParagraphLayout, expected: Line[], epsilon = 0.02) {
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

// Where Chrome's half-leading puts the baseline below a line's top: the ascent
// and descent rounded, the half of the leading above them floored
// (`__test__/effing-paragraph-half-leading.spec.ts`).
function baselineInBox(layout: { lineHeight: number; ascent: number; descent: number }) {
  const ascent = Math.round(layout.ascent)
  const descent = Math.round(layout.descent)
  return ascent + Math.floor((layout.lineHeight - ascent - descent) / 2)
}

function near(t: ExecutionContext, actual: number, expected: number, epsilon = 0.02) {
  t.true(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`)
}

const EXTRAORDINARY = 'An extraordinarily long word'

test('wordBreak and overflowWrap default to normal, as in CSS', (t) => {
  for (const width of [39, 100, 1000]) {
    t.deepEqual(
      new Paragraph(EXTRAORDINARY, IOSEVKA).layout(width),
      new Paragraph(EXTRAORDINARY, { ...IOSEVKA, wordBreak: 'normal', overflowWrap: 'normal' }).layout(width),
    )
  }
})

test('invalid wordBreak and overflowWrap values throw', (t) => {
  // CSS's word-break: break-word is overflowWrap: 'break-word' here.
  t.throws(() => new Paragraph(EXTRAORDINARY, { ...IOSEVKA, wordBreak: 'break-word' as never }), {
    message: /wordBreak/,
  })
  t.throws(() => new Paragraph(EXTRAORDINARY, { ...IOSEVKA, overflowWrap: 'anywhere' as never }), {
    message: /overflowWrap/,
  })
})

test('normal leaves a word wider than the line unbroken on a line of its own', (t) => {
  // CSS: overflow-wrap: normal.
  const layout = new Paragraph(EXTRAORDINARY, { ...IOSEVKA, wordBreak: 'normal' }).layout(100)
  expectLines(t, layout, [
    [0, 2, 20],
    [3, 18, 150],
    [19, 28, 90],
  ])
  near(t, layout.minIntrinsicWidth, 150)
  near(t, layout.longestLine, 150)
  near(t, layout.height, 3 * layout.lineHeight)
  for (const [i, line] of layout.lines.entries()) {
    near(t, line.baseline, i * layout.lineHeight + baselineInBox(layout))
    t.is(line.hardBreak, i === 2)
  }
  t.false(layout.didExceedMaxLines)

  // A word that ends the text; Skia alone measures it without its last
  // letter.
  const last = new Paragraph('a b overlongwordhere', { ...IOSEVKA, wordBreak: 'normal' }).layout(100)
  expectLines(t, last, [
    [0, 3, 30],
    [4, 20, 160],
  ])
  near(t, last.minIntrinsicWidth, 160)

  // Spaces after the word hang.
  expectLines(t, new Paragraph('ab cd Overlongwordhere  ef gh', { ...IOSEVKA, wordBreak: 'normal' }).layout(100), [
    [0, 5, 50],
    [6, 22, 160],
    [24, 29, 50],
  ])
})

test('normal keeps hard breaks around a word wider than the line', (t) => {
  // CSS: white-space: pre-line.
  const text = 'Overlongwordhere\nnext line\nOverlongwordhere'
  const layout = new Paragraph(text, { ...IOSEVKA, wordBreak: 'normal' }).layout(100)
  expectLines(t, layout, [
    [0, 16, 160],
    [17, 26, 90],
    [27, 43, 160],
  ])
  t.deepEqual(
    layout.lines.map((line) => line.hardBreak),
    [true, true, true],
  )
})

test('a word wider than the line is start-aligned whatever the alignment', (t) => {
  // CSS: text-align: center / right.
  const text = 'ab Overlongwordhere cd'
  expectLines(t, new Paragraph(text, { ...IOSEVKA, wordBreak: 'normal', textAlign: 'center' }).layout(100), [
    [0, 2, 20, 40],
    [3, 19, 160, 0],
    [20, 22, 20, 40],
  ])
  expectLines(t, new Paragraph(text, { ...IOSEVKA, wordBreak: 'normal', textAlign: 'right' }).layout(100), [
    [0, 2, 20, 80],
    [3, 19, 160, 0],
    [20, 22, 20, 80],
  ])
  // CSS: direction: rtl.
  const rtl = new Paragraph('مرحبا بالعالمالطويلجداجدا هنا', { ...ARABIC, wordBreak: 'normal' }).layout(80)
  expectLines(t, rtl, [
    [0, 5, 32.656, 47.344],
    [6, 25, 115.703, -35.703],
    [26, 29, 19.75, 60.25],
  ])
  near(t, rtl.minIntrinsicWidth, 115.703)
})

test('overflowWrap break-word breaks a word wider than the line on a line of its own', (t) => {
  // CSS: overflow-wrap: break-word. Skia alone breaks the word right after
  // "An", on the first line.
  const layout = new Paragraph(EXTRAORDINARY, { ...IOSEVKA, overflowWrap: 'break-word' }).layout(100)
  expectLines(t, layout, [
    [0, 2, 20],
    [3, 13, 100],
    [13, 23, 100],
    [24, 28, 40],
  ])
  near(t, layout.minIntrinsicWidth, 150)

  // Chrome drops the kerning between the letters on either side of the
  // break, which Skia keeps: up to 0.4px here.
  const lato = new Paragraph('A supercalifragilisticexpialidocious day', {
    ...LATO,
    overflowWrap: 'break-word',
  }).layout(100)
  expectLines(
    t,
    lato,
    [
      [0, 1, 13.609],
      [2, 13, 93.906],
      [13, 25, 97.328],
      [25, 36, 93.188],
      [37, 40, 31.25],
    ],
    0.5,
  )
  near(t, lato.minIntrinsicWidth, 284.016)

  const lazy = new Paragraph('over lazy here', { ...IOSEVKA, overflowWrap: 'break-word' }).layout(39)
  expectLines(t, lazy, [
    [0, 3, 30],
    [3, 4, 10],
    [5, 8, 30],
    [8, 9, 10],
    [10, 13, 30],
    [13, 14, 10],
  ])
  near(t, lazy.minIntrinsicWidth, 40)

  const last = new Paragraph('a b overlongwordhere', { ...IOSEVKA, overflowWrap: 'break-word' }).layout(100)
  expectLines(t, last, [
    [0, 3, 30],
    [4, 14, 100],
    [14, 20, 60],
  ])
  near(t, last.minIntrinsicWidth, 160)

  // CSS: letter-spacing: 2px, which every letter carries, the last one too.
  const spaced = new Paragraph('A extraordinarily word', {
    ...IOSEVKA,
    overflowWrap: 'break-word',
    letterSpacing: 2,
  }).layout(100)
  expectLines(t, spaced, [
    [0, 1, 12],
    [2, 10, 96],
    [10, 17, 84],
    [18, 22, 48],
  ])
  near(t, spaced.minIntrinsicWidth, 180)
})

test('break-all breaks between any two letters', (t) => {
  // CSS: word-break: break-all.
  const iosevka = new Paragraph(EXTRAORDINARY, { ...IOSEVKA, wordBreak: 'break-all' }).layout(100)
  expectLines(t, iosevka, [
    [0, 10, 100],
    [10, 20, 100],
    [20, 28, 80],
  ])
  near(t, iosevka.minIntrinsicWidth, 10)

  const lato = new Paragraph('An extraordinarily long word, (yes) 12345 a-b', {
    ...LATO,
    wordBreak: 'break-all',
  }).layout(100)
  expectLines(t, lato, [
    [0, 10, 93],
    [10, 22, 97.328],
    [22, 33, 94.328],
    [33, 44, 97.484],
    [44, 45, 11.188],
  ])
  near(t, lato.minIntrinsicWidth, 15.984)

  const lazy = new Paragraph('over lazy here', { ...IOSEVKA, wordBreak: 'break-all' }).layout(39)
  expectLines(t, lazy, [
    [0, 3, 30],
    [3, 6, 30],
    [6, 9, 30],
    [10, 13, 30],
    [13, 14, 10],
  ])

  // Ideographs and Latin letters alike.
  const han = new Paragraph('abc中文文本defg', { ...HAN, wordBreak: 'break-all' }).layout(100)
  expectLines(t, han, [
    [0, 6, 96.313],
    [6, 11, 64.266],
  ])
  near(t, han.minIntrinsicWidth, 20)
})

test('break-all keeps punctuation with its letter as Chrome does', (t) => {
  const style: ParagraphStyle = { ...IOSEVKA, wordBreak: 'break-all' }
  const fits = new Paragraph('ab(cd)ef,gh "ij" 1.5% $3', style).layout(60)
  expectLines(t, fits, [
    [0, 6, 60],
    [6, 11, 50],
    [12, 16, 40],
    [17, 21, 40],
    [22, 24, 20],
  ])
  near(t, fits.minIntrinsicWidth, 20)

  // At a width nothing fits in, every line holds what can't be broken.
  expectLines(t, new Paragraph('a-b, (yes) 1.5% $3 "ij"', style).layout(5), [
    [0, 1, 10],
    [1, 2, 10],
    [2, 4, 20],
    [5, 7, 20],
    [7, 8, 10],
    [8, 10, 20],
    [11, 13, 20],
    [13, 15, 20],
    [16, 18, 20],
    [19, 21, 20],
    [21, 23, 20],
  ])
})

test('keep-all never breaks between CJK letters', (t) => {
  // CSS: word-break: keep-all.
  const text = '日本語のテキストと中文文本 English words'
  const normal = new Paragraph(text, { ...HAN, wordBreak: 'normal' }).layout(130)
  t.deepEqual(
    normal.lines.map((line) => [line.startIndex, line.endIndex]),
    [
      [0, 6],
      [6, 12],
      [12, 21],
      [22, 27],
    ],
  )
  const keepAll = new Paragraph(text, { ...HAN, wordBreak: 'keep-all' }).layout(130)
  expectLines(t, keepAll, [
    [0, 13, 259.609],
    [14, 21, 75.969],
    [22, 27, 61.938],
  ])
  near(t, keepAll.minIntrinsicWidth, 259.609)

  // Punctuation still breaks.
  const punctuated = new Paragraph('中文文本，日本語の文章。', { ...HAN, wordBreak: 'keep-all' }).layout(100)
  expectLines(t, punctuated, [
    [0, 5, 100],
    [5, 12, 140],
  ])
  near(t, punctuated.minIntrinsicWidth, 140)
  near(
    t,
    new Paragraph('中文 文本，日本語 の文章。', { ...HAN, wordBreak: 'keep-all' }).layout(300).minIntrinsicWidth,
    80,
  )
})

test('minIntrinsicWidth is the widest word, per mode', (t) => {
  // Skia's own figure is the whole text when it has no spaces and fits.
  const minContent = (text: string, style: ParagraphStyle) => new Paragraph(text, style).layout(1000).minIntrinsicWidth
  near(t, minContent('state-of-the-art', { ...IOSEVKA, wordBreak: 'normal' }), 60)
  near(t, minContent('中文文本', { ...HAN, wordBreak: 'normal' }), 20)
  near(t, minContent('中文文本', { ...HAN, wordBreak: 'keep-all' }), 80)
  near(t, minContent('abcdef', { ...IOSEVKA, wordBreak: 'break-all' }), 10)
  for (const overflowWrap of ['normal', 'break-word'] as const) {
    // At a width no letter fits in, too.
    near(t, new Paragraph('over lazy here', { ...IOSEVKA, overflowWrap }).layout(5).minIntrinsicWidth, 40)
  }
})

test('maxLines with a word wider than the line', (t) => {
  // Chrome's -webkit-line-clamp: 2 truncates the word on the last line to
  // fit the ellipsis ("Overlong…"), for normal and break-word alike.
  const text = 'ab cd ef Overlongwordhere gh ij kl'
  for (const overflowWrap of ['normal', 'break-word'] as const) {
    const layout = new Paragraph(text, { ...IOSEVKA, overflowWrap, maxLines: 2, ellipsis: '…' }).layout(100)
    t.is(layout.lines.length, 2, overflowWrap)
    t.deepEqual([layout.lines[0].startIndex, layout.lines[0].endIndex], [0, 8])
    expectLines(t, layout, [
      [0, 8, 80],
      [9, 17, 100],
    ])
    t.true(layout.didExceedMaxLines)
  }
  // The ellipsis follows the last line's own text, as Chrome puts it: "ab…"
  // and "gh…" (Iosevka's ellipsis is 20px wide).
  const first = new Paragraph('ab Overlongwordhere cd', { ...IOSEVKA, maxLines: 1, ellipsis: '…' }).layout(100)
  expectLines(t, first, [[0, 2, 40]])
  t.true(first.didExceedMaxLines)
  const before = new Paragraph('ab cd ef gh Overlongwordhere', { ...IOSEVKA, maxLines: 2, ellipsis: '…' }).layout(100)
  expectLines(t, before, [
    [0, 8, 80],
    [9, 11, 40],
  ])
  // Without an ellipsis the word stays whole.
  const clipped = new Paragraph(text, { ...IOSEVKA, wordBreak: 'normal', maxLines: 2 }).layout(100)
  expectLines(t, clipped, [
    [0, 8, 80],
    [9, 25, 160],
  ])
  t.true(clipped.didExceedMaxLines)
  const all = new Paragraph(text, { ...IOSEVKA, wordBreak: 'normal', maxLines: 3 }).layout(100)
  t.is(all.lines.length, 3)
  t.false(all.didExceedMaxLines)
})

// The leftmost and rightmost inked columns of each line box.
function inkSpans(paragraph: Paragraph, layout: ParagraphLayout) {
  const width = 300
  const height = Math.ceil(layout.height)
  const ctx = createCanvas(width, height).getContext('2d')
  fillParagraph(ctx, paragraph, 0, 0)
  const { data } = ctx.getImageData(0, 0, width, height)
  return layout.lines.map((_, i) => {
    let left = width
    let right = -1
    for (let y = Math.ceil(i * layout.lineHeight); y < Math.min(height, (i + 1) * layout.lineHeight); y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 0) {
          left = Math.min(left, x)
          right = Math.max(right, x)
        }
      }
    }
    return [left, right]
  })
}

test('the lines of a split paragraph paint where layout puts them', (t) => {
  const text = 'ab Overlongwordhere cd'
  const paragraph = new Paragraph(text, { ...IOSEVKA, wordBreak: 'normal', textAlign: 'center' })
  const layout = paragraph.layout(100)
  const spans = inkSpans(paragraph, layout)
  t.is(spans.length, 3)
  for (const [i, [left, right]] of spans.entries()) {
    const line = layout.lines[i]
    t.true(
      left >= Math.floor(line.left) && right < Math.ceil(line.left + line.width),
      `line ${i} inks ${left}..${right}`,
    )
  }
  // The word overflows the width.
  t.true(spans[1][1] > 150)
})

test('the same text under different modes keeps its own line breaks', (t) => {
  // Skia caches line-break opportunities with the shaped text.
  const text = 'abcdefgh ijkl'
  const lines = (wordBreak: ParagraphStyle['wordBreak']) =>
    new Paragraph(text, { ...IOSEVKA, wordBreak }).layout(35).lines.map((line) => [line.startIndex, line.endIndex])
  const breakAll = lines('break-all')
  const normal = lines('normal')
  t.deepEqual(normal, [
    [0, 8],
    [9, 13],
  ])
  t.deepEqual(breakAll, [
    [0, 3],
    [3, 6],
    [6, 8],
    [9, 12],
    [12, 13],
  ])
  t.deepEqual(lines('break-all'), breakAll)
  t.deepEqual(lines('normal'), normal)
})

test('empty lines before and after a word wider than the line', (t) => {
  // As without a split: an empty line between two hard breaks is at the
  // second one.
  const layout = (text: string, width: number) =>
    new Paragraph(text, IOSEVKA).layout(width).lines.map((line) => [line.startIndex, line.endIndex, line.hardBreak])
  t.deepEqual(layout('ab\n\ncd', 1000), [
    [0, 2, true],
    [3, 3, true],
    [4, 6, true],
  ])
  t.deepEqual(layout('ab\n\nOverlongwordhere', 100), [
    [0, 2, true],
    [3, 3, true],
    [4, 20, true],
  ])
  t.deepEqual(layout('ab\n\n\nOverlongwordhere\n\ncd', 100), [
    [0, 2, true],
    [3, 3, true],
    [4, 4, true],
    [5, 21, true],
    [22, 22, true],
    [23, 25, true],
  ])
})

test('lines break only between grapheme clusters', (t) => {
  // Chrome, CSS overflow-wrap: break-word. नमस्ते is न म स्ते: the conjunct
  // स्ते is one cluster.
  const text = 'नमस्ते दुनिया'
  expectLines(t, new Paragraph(text, DEVANAGARI).layout(30), [
    [0, 6, 42.25],
    [7, 13, 43.688],
  ])
  expectLines(t, new Paragraph(text, { ...DEVANAGARI, overflowWrap: 'break-word' }).layout(30), [
    [0, 2, 23.063],
    [2, 6, 19.188],
    [7, 11, 26.906],
    [11, 13, 16.781],
  ])
  // A cluster wider than the line overflows it whole.
  const narrow: Line[] = [
    [0, 1, 11.109],
    [1, 2, 11.969],
    [2, 6, 19.188],
    [7, 9, 10.625],
    [9, 11, 16.281],
    [11, 13, 16.781],
  ]
  expectLines(t, new Paragraph(text, { ...DEVANAGARI, overflowWrap: 'break-word' }).layout(5), narrow)
  // Chrome's break-all breaks स्|ते, between ICU's extended grapheme
  // clusters; the fork keeps the conjunct whole there too.
  expectLines(t, new Paragraph(text, { ...DEVANAGARI, wordBreak: 'break-all' }).layout(5), narrow)

  // An emoji ZWJ sequence is one cluster, whatever font draws it.
  const family = '👩‍👩‍👧👩‍👩‍👧 ab👩‍👩‍👧'
  const graphemes = new Set([...new Intl.Segmenter().segment(family)].map((segment) => segment.index))
  graphemes.add(family.length)
  for (const style of [{ overflowWrap: 'break-word' }, { wordBreak: 'break-all' }] as const) {
    for (const width of [1, 15, 30]) {
      for (const line of new Paragraph(family, { ...IOSEVKA, ...style }).layout(width).lines) {
        t.true(graphemes.has(line.startIndex) && graphemes.has(line.endIndex), `${line.startIndex}..${line.endIndex}`)
      }
    }
  }
})

test('keep-all with overflowWrap break-word breaks a run of CJK too wide for the line', (t) => {
  // Chrome, CSS word-break: keep-all; overflow-wrap: break-word.
  const style: ParagraphStyle = { ...HAN, wordBreak: 'keep-all', overflowWrap: 'break-word' }
  const layout = new Paragraph('日本語のテキストと中文文本 English words', style).layout(130)
  expectLines(
    t,
    layout,
    [
      [0, 6, 120],
      [6, 12, 120],
      [12, 21, 101],
      [22, 27, 61.938],
    ],
    0.5,
  )
  near(t, layout.minIntrinsicWidth, 259.609)
  expectLines(t, new Paragraph('ab 日本語のテキスト cd', style).layout(90), [
    [0, 2, 24.984],
    [3, 7, 80],
    [7, 11, 79.609],
    [12, 14, 24.219],
  ])
  expectLines(t, new Paragraph('中文文本，日本語の文章。', style).layout(100), [
    [0, 5, 100],
    [5, 10, 100],
    [10, 12, 40],
  ])
})

test('keep-all breaks between emoji as normal does', (t) => {
  // Chrome breaks between emoji under keep-all, and around them next to CJK.
  const lines = (text: string, wordBreak: ParagraphStyle['wordBreak'], width: number) =>
    new Paragraph(text, { ...HAN, wordBreak }).layout(width).lines.map((line) => [line.startIndex, line.endIndex])
  for (const width of [30, 60]) {
    t.deepEqual(lines('ab 😀😀😀😀😀😀 cd', 'keep-all', width), lines('ab 😀😀😀😀😀😀 cd', 'normal', width))
  }
  const cjk = lines('中文😀😀文本', 'keep-all', 45)
  t.true(cjk.length > 1)
  t.false(
    cjk.some(([start, end]) => [1, 7].includes(start) || [1, 7].includes(end)),
    JSON.stringify(cjk),
  )
})

test('placeholders around a word wider than the line', (t) => {
  // Chrome, with an inline-block 15px wide and 10px tall for each
  // placeholder, which counts as one unit of the text.
  const box = { width: 15, height: 10 }
  const style: ParagraphStyle = { ...IOSEVKA, lineHeight: 40 }
  const check = (parts: (string | typeof box)[], extra: ParagraphStyle, lines: Line[], x: number, line: number) => {
    const layout = new Paragraph(parts, { ...style, ...extra }).layout(100)
    expectLines(t, layout, lines)
    t.is(layout.placeholders.length, 1)
    near(t, layout.placeholders[0]!.x, x)
    t.is(layout.placeholders[0]!.line, line)
  }
  check(
    ['ab ', box, ' Overlongwordhere cd'],
    {},
    [
      [0, 4, 45],
      [5, 21, 160],
      [22, 24, 20],
    ],
    30,
    0,
  )
  check(
    ['ab Overlong', box, 'wordhere cd'],
    {},
    [
      [0, 2, 20],
      [3, 12, 95],
      [12, 20, 80],
      [21, 23, 20],
    ],
    80,
    1,
  )
  check(
    ['ab Overlongwordhere ', box, ' cd'],
    {},
    [
      [0, 2, 20],
      [3, 19, 160],
      [20, 24, 45],
    ],
    0,
    2,
  )
  const breakWord: ParagraphStyle = { overflowWrap: 'break-word' }
  check(
    ['ab ', box, ' Overlongwordhere cd'],
    breakWord,
    [
      [0, 4, 45],
      [5, 15, 100],
      [15, 24, 90],
    ],
    30,
    0,
  )
  check(
    ['ab Overlongword', box, 'herewords cd'],
    breakWord,
    [
      [0, 2, 20],
      [3, 13, 100],
      [13, 16, 35],
      [16, 25, 90],
      [26, 28, 20],
    ],
    20,
    2,
  )
  check(
    ['ab Overlongwordhere', box, ' cd'],
    breakWord,
    [
      [0, 2, 20],
      [3, 13, 100],
      [13, 20, 75],
      [21, 23, 20],
    ],
    60,
    2,
  )
  check(
    ['ab Overlong', box, 'wordhere cd'],
    { wordBreak: 'break-all' },
    [
      [0, 10, 100],
      [10, 19, 95],
      [19, 23, 40],
    ],
    10,
    1,
  )
  // A placeholder wider than the line is a word of its own.
  const wide = new Paragraph(['ab ', { width: 130, height: 10 }, ' cd'], style).layout(100)
  expectLines(t, wide, [
    [0, 2, 20],
    [3, 4, 130],
    [5, 7, 20],
  ])
  near(t, wide.minIntrinsicWidth, 130)
})

test('keepTrailingWhitespace keeps the spaces after a word wider than the line', (t) => {
  // As it does without a split: spaces before a hard break count.
  for (const overflowWrap of ['normal', 'break-word'] as const) {
    const layout = new Paragraph('ab Overlongwordhere  \ncd  ', {
      ...IOSEVKA,
      overflowWrap,
      keepTrailingWhitespace: true,
    }).layout(100)
    const lines: Line[] =
      overflowWrap === 'normal'
        ? [
            [0, 2, 20],
            [3, 21, 180],
            [22, 26, 40],
          ]
        : [
            [0, 2, 20],
            [3, 13, 100],
            [13, 21, 80],
            [22, 26, 40],
          ]
    expectLines(t, layout, lines)
  }
})

test('a placeholder too wide for the line before a hard break', (t) => {
  // As for a word: the hard break ends its line, with no empty line between.
  const box = { width: 130, height: 10 }
  const lines = (parts: (string | typeof box)[], style: ParagraphStyle = {}) =>
    new Paragraph(parts, { ...IOSEVKA, ...style })
      .layout(100)
      .lines.map((line) => [line.startIndex, line.endIndex, line.hardBreak])
  t.deepEqual(lines(['ab ', box, '\ncd']), [
    [0, 2, false],
    [3, 4, true],
    [5, 7, true],
  ])
  t.deepEqual(lines(['ab ', box, ' \ncd']), [
    [0, 2, false],
    [3, 4, true],
    [6, 8, true],
  ])
  t.deepEqual(lines(['ab ', box, '\ncd'], { overflowWrap: 'break-word' }), [
    [0, 2, false],
    [3, 4, true],
    [5, 7, true],
  ])
})

test('maxLines with an ellipsis ending at an empty line', (t) => {
  // Chrome's -webkit-line-clamp puts the ellipsis on the last line shown,
  // empty or not (Iosevka's ellipsis is 20px wide).
  const style: ParagraphStyle = { ...IOSEVKA, maxLines: 2, ellipsis: '…' }
  const lines = (text: string, extra: ParagraphStyle = {}) => {
    const layout = new Paragraph(text, { ...style, ...extra }).layout(100)
    t.true(layout.didExceedMaxLines, JSON.stringify(text))
    return layout.lines.map((line) => [line.startIndex, line.endIndex, Math.round(line.width), line.hardBreak])
  }
  t.deepEqual(lines('ab\n\nOverlongwordhere'), [
    [0, 2, 20, true],
    [3, 3, 20, true],
  ])
  t.deepEqual(lines('ab\n\n\nOverlongwordhere', { maxLines: 3 }), [
    [0, 2, 20, true],
    [3, 3, 0, true],
    [4, 4, 20, true],
  ])
  t.deepEqual(lines('ab \n\nOverlongwordhere', { keepTrailingWhitespace: true }), [
    [0, 3, 30, true],
    [4, 4, 20, true],
  ])
  t.deepEqual(lines('ab\r\n\r\nOverlongwordhere'), [
    [0, 2, 20, true],
    [4, 4, 20, true],
  ])
})

test('a hard break that ends the text is no line of maxLines', (t) => {
  // As without a split, and in Chrome: the empty line after it shows if
  // there is room, and doesn't make the text overflow its lines.
  const layout = (text: string, style: ParagraphStyle) => {
    const result = new Paragraph(text, { ...IOSEVKA, ...style }).layout(100)
    return {
      lines: result.lines.map((line) => [line.startIndex, line.endIndex, Math.round(line.width), line.hardBreak]),
      exceeded: result.didExceedMaxLines,
    }
  }
  for (const ellipsis of [undefined, '…']) {
    t.deepEqual(layout('Overlongwordhere\n', { maxLines: 1, ellipsis }), {
      lines: [[0, 16, 160, true]],
      exceeded: false,
    })
  }
  t.deepEqual(layout('Overlongwordhere\n\n', { maxLines: 2, ellipsis: '…' }), {
    lines: [
      [0, 16, 160, true],
      [17, 17, 0, true],
    ],
    exceeded: false,
  })
  t.deepEqual(layout('ab Overlongwordhere\n', { maxLines: 2, ellipsis: '…' }), {
    lines: [
      [0, 2, 20, false],
      [3, 19, 160, true],
    ],
    exceeded: false,
  })
  // Broken under break-word, the word takes two lines.
  t.deepEqual(layout('ab Overlongwordhere\n', { maxLines: 3, ellipsis: '…', overflowWrap: 'break-word' }), {
    lines: [
      [0, 2, 20, false],
      [3, 13, 100, false],
      [13, 19, 60, true],
    ],
    exceeded: false,
  })
  t.deepEqual(layout('ab Overlongwordhere\n', { maxLines: 2, ellipsis: '…', overflowWrap: 'break-word' }), {
    lines: [
      [0, 2, 20, false],
      [3, 11, 100, true],
    ],
    exceeded: true,
  })
})

test('keepTrailingWhitespace keeps the spaces before an ellipsis', (t) => {
  // Chrome: "ab   …", with white-space: pre-wrap and line-clamp 1.
  const layout = new Paragraph('ab   Overlongwordhere cd', {
    ...IOSEVKA,
    keepTrailingWhitespace: true,
    maxLines: 1,
    ellipsis: '…',
  }).layout(100)
  expectLines(t, layout, [[0, 5, 70]])
  t.true(layout.didExceedMaxLines)
})

test('maxLines with leading whitespace after a word wider than the line', (t) => {
  // The whitespace after a hard break starts the next line, which collapses
  // it away; it isn't the overflowing word's.
  const layout = (text: string, style: ParagraphStyle) => {
    const result = new Paragraph(text, { ...IOSEVKA, ...style }).layout(100)
    return {
      lines: result.lines.map((line) => [line.startIndex, line.endIndex, Math.round(line.width), line.hardBreak]),
      exceeded: result.didExceedMaxLines,
      height: result.height / result.lineHeight,
    }
  }
  for (const [text, second] of [
    ['Overlongwordhere\n  ab', [19, 21, 20, true]],
    ['Overlongwordhere\r\n  ab', [20, 22, 20, true]],
    ['Overlongwordhere\n\tab', [18, 20, 20, true]],
  ] as const) {
    t.deepEqual(layout(text, {}).lines, [[0, 16, 160, true], second])
    t.deepEqual(layout(text, { maxLines: 1 }), { lines: [[0, 16, 160, true]], exceeded: true, height: 1 })
    t.deepEqual(layout(text, { maxLines: 1, ellipsis: '…' }), {
      lines: [[0, 8, 100, true]],
      exceeded: true,
      height: 1,
    })
    for (const ellipsis of [undefined, '…']) {
      t.deepEqual(layout(text, { maxLines: 2, ellipsis }), {
        lines: [[0, 16, 160, true], second],
        exceeded: false,
        height: 2,
      })
    }
  }
})

test('maxLines 1 on text that starts with a hard break', (t) => {
  // An empty first line, as without a split.
  const box = { width: 130, height: 10 }
  for (const text of ['\nOverlongwordhere', '\r\nOverlongwordhere', ['\n', box]] as const) {
    for (const ellipsis of [undefined, '…']) {
      const layout = new Paragraph(text as never, { ...IOSEVKA, maxLines: 1, ellipsis }).layout(100)
      t.deepEqual(
        layout.lines.map((line) => [line.startIndex, line.endIndex, line.hardBreak]),
        [[0, 0, true]],
      )
      near(t, layout.height, layout.lineHeight)
      near(t, layout.lines[0].width, ellipsis ? 20 : 0)
      t.true(layout.didExceedMaxLines)
    }
  }
})

test('the lines before an ellipsis are shaped as without it', (t) => {
  // Under break-word the lines before the ellipsis line break inside a word;
  // cut there, the text would join (Arabic) or kern (Lato) differently.
  const first = (text: string, style: ParagraphStyle, width: number) =>
    new Paragraph(text, { ...style, overflowWrap: 'break-word' }).layout(width).lines[0]
  for (const [text, style, width] of [
    ['بالعالم xyz', { ...ARABIC, textAlign: 'left' }, 30],
    ['AVAVAVAVAVAVAVAV xyz', LATO, 60],
  ] as const) {
    const clamped = new Paragraph(text, { ...style, overflowWrap: 'break-word', maxLines: 2, ellipsis: '…' }).layout(
      width,
    )
    t.is(clamped.lines.length, 2, text)
    const unclamped = first(text, style, width)
    t.deepEqual([clamped.lines[0].startIndex, clamped.lines[0].endIndex], [unclamped.startIndex, unclamped.endIndex])
    near(t, clamped.lines[0].width, unclamped.width)
  }
})

test('a line clamped at the end of a piece is no hard break', (t) => {
  // As without a split: its trailing spaces hang, kept or not.
  for (const keepTrailingWhitespace of [false, true]) {
    const split = new Paragraph('ab cd   Overlongwordhere', {
      ...IOSEVKA,
      maxLines: 1,
      keepTrailingWhitespace,
      textAlign: 'right',
    }).layout(60)
    const whole = new Paragraph('ab cd   ef gh', {
      ...IOSEVKA,
      maxLines: 1,
      keepTrailingWhitespace,
      textAlign: 'right',
    }).layout(60)
    t.deepEqual(split.lines, whole.lines)
    expectLines(t, split, [[0, 5, 50, 10]])
    t.false(split.lines[0].hardBreak)
  }
})
