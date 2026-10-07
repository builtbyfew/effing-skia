import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test, { type ExecutionContext } from 'ava'

import { GlobalFonts, createCanvas } from '../index'
import {
  Paragraph,
  fillParagraph,
  type ParagraphContent,
  type ParagraphLayout,
  type ParagraphStyle,
} from '../extensions'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const fonts = join(__dirname, 'fonts')

// When not even a line's first grapheme cluster fits with the ellipsis, or
// the ellipsis alone doesn't, Chrome keeps that cluster and puts the
// ellipsis after it, both overflowing the line, for -webkit-line-clamp and
// for text-overflow alike (Chrome 154, headless, macOS, the same font files).
// Iosevka Slab advances every letter 10px at 20px, and the ellipsis 20px:
// "a…" is 30px wide.
const IOSEVKA: ParagraphStyle = { fontFamily: 'WB Iosevka', fontSize: 20, lineHeight: 40 }
const HARMATTAN: ParagraphStyle = { fontFamily: 'WB Harmattan', fontSize: 20, lineHeight: 40 }
const box = { width: 15, height: 10 }

test.before((t) => {
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'iosevka-slab-regular.ttf'), 'WB Iosevka'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'Harmattan-Regular.ttf'), 'WB Harmattan'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'SourceHanSerifCN-Bold.ttf'), 'WB Source Han'))
})

// A line as [startIndex, endIndex, width, left].
type Line = [number, number, number, number]

const lines = (layout: ParagraphLayout): Line[] =>
  layout.lines.map((line) => [line.startIndex, line.endIndex, round(line.width), round(line.left)])

const round = (x: number) => Math.round(x * 100) / 100

// The columns each line of `paragraph` inks, painted at (0, 0) at its last
// layout: [first, end) of those with a pixel in the line's band more than
// ~40% opaque, or null for a line with no ink. Columns, not pixels, so that
// antialiasing on another platform moves an edge by a pixel at most.
function inkPerLine(paragraph: Paragraph, layout: ParagraphLayout, width = 300): Array<[number, number] | null> {
  const height = Math.max(1, Math.ceil(layout.height))
  const ctx = createCanvas(width, height).getContext('2d')
  fillParagraph(ctx, paragraph, 0, 0)
  const { data } = ctx.getImageData(0, 0, width, height)
  return layout.lines.map((_, k) => {
    let first = -1
    let end = -1
    for (let x = 0; x < width; x++) {
      for (let y = Math.round(k * layout.lineHeight); y < Math.round((k + 1) * layout.lineHeight); y++) {
        if (data[(y * width + x) * 4 + 3] > 96) {
          if (first < 0) first = x
          end = x + 1
          break
        }
      }
    }
    return first < 0 ? null : [first, end]
  })
}

function nearInk(t: ExecutionContext, actual: [number, number] | null, expected: [number, number], name: string) {
  t.truthy(actual, name)
  if (!actual) return
  t.true(
    Math.abs(actual[0] - expected[0]) <= 1 && Math.abs(actual[1] - expected[1]) <= 1,
    `${name}: inked ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)} within 1px`,
  )
}

type Case = { parts: ParagraphContent; style: ParagraphStyle; width: number }

type Result = { lines: Line[]; placeholders: (number | null)[]; didExceedMaxLines: boolean }

// Lays each case out in a child process, a few cases to a process, so that
// a layout that never returns (or crashes) fails the test, naming its case,
// instead of hanging the run. The cases go in on stdin and come back one
// line each, as each layout returns.
function layOutInChild(t: ExecutionContext, cases: Case[]): (Result | undefined)[] {
  const script = `
    const { join } = require('node:path')
    const { readFileSync } = require('node:fs')
    const { GlobalFonts } = require(join(process.cwd(), 'index.js'))
    const { Paragraph } = require(join(process.cwd(), 'extensions.js'))
    const fonts = join(process.cwd(), '__test__', 'fonts')
    GlobalFonts.registerFromPath(join(fonts, 'iosevka-slab-regular.ttf'), 'WB Iosevka')
    GlobalFonts.registerFromPath(join(fonts, 'Harmattan-Regular.ttf'), 'WB Harmattan')
    GlobalFonts.registerFromPath(join(fonts, 'SourceHanSerifCN-Bold.ttf'), 'WB Source Han')
    const round = (x) => Math.round(x * 100) / 100
    for (const { parts, style, width } of JSON.parse(readFileSync(0, 'utf8'))) {
      const layout = new Paragraph(parts, style).layout(width)
      process.stdout.write(JSON.stringify({
        lines: layout.lines.map((line) => [line.startIndex, line.endIndex, round(line.width), round(line.left)]),
        placeholders: layout.placeholders.map((p) => p && round(p.x)),
        didExceedMaxLines: layout.didExceedMaxLines,
      }) + '\\n')
    }
  `
  const results: (Result | undefined)[] = []
  const batch = 8
  for (let start = 0; start < cases.length; start += batch) {
    const some = cases.slice(start, start + batch)
    let out: string
    let failure: string | undefined
    try {
      out = execFileSync(process.execPath, ['-e', script], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '' },
        input: JSON.stringify(some.map(({ parts, style, width }) => ({ parts, style, width }))),
        timeout: 30_000,
        killSignal: 'SIGKILL',
      })
    } catch (e) {
      const error = e as Error & { stdout?: string; signal?: string; code?: string }
      out = error.stdout ?? ''
      failure = error.code ?? error.signal ?? error.message
    }
    const done = out.split('\n').filter(Boolean)
    for (const line of done) {
      results.push(JSON.parse(line) as Result)
    }
    if (failure !== undefined && done.length < some.length) {
      const { parts, style, width } = some[done.length]
      t.fail(`layout(${width}) of ${JSON.stringify(parts)} ${JSON.stringify(style)} did not return: ${failure}`)
      results.push(...Array<undefined>(some.length - done.length).fill(undefined))
    }
  }
  return results
}

test('justify with an ellipsis that not even the first cluster fits with', (t) => {
  // SkParagraph empties such a line, and never returns from justifying it
  // when the line has more than one run: a placeholder, another font, or
  // another direction.
  const alignments = ['justify', 'left', 'center', 'right'] as const
  const directions = ['ltr', 'rtl'] as const
  type Expected = { lines: Line[]; placeholders: (number | null)[]; didExceedMaxLines?: boolean }
  const cases: (Case & { expected?: Expected; range?: [number, number] })[] = []
  for (const textAlign of alignments) {
    for (const direction of directions) {
      const rtl = direction === 'rtl'
      const style = { ...IOSEVKA, maxLines: 1, ellipsis: '…', textAlign, direction }
      // A placeholder, then text: the placeholder and the ellipsis, 35px
      // wide, start-aligned in a line 30px wide.
      cases.push({
        parts: [box, 'b c d'],
        style,
        width: 30,
        expected: { lines: [[0, 1, 35, rtl ? -5 : 0]], placeholders: [rtl ? 15 : 0] },
      })
      // A letter, then a placeholder: "a…", the placeholder cut off.
      cases.push({
        parts: ['a', box, ' c d'],
        style,
        width: 25,
        expected: { lines: [[0, 1, 30, rtl ? -5 : 0]], placeholders: [null] },
      })
      // On the last of two lines.
      cases.push({
        parts: ['ab ', box, 'c d'],
        style: { ...style, maxLines: 2 },
        width: 30,
        expected: {
          lines: [
            [0, 2, 20, textAlign === 'left' || (textAlign === 'justify' && !rtl) ? 0 : textAlign === 'center' ? 5 : 10],
            [3, 4, 35, rtl ? -5 : 0],
          ],
          placeholders: [rtl ? 15 : 0],
        },
      })
      cases.push({
        parts: [box, 'bcdefgh'],
        style: { ...style, overflowWrap: 'break-word' },
        width: 30,
        expected: { lines: [[0, 1, 35, rtl ? -5 : 0]], placeholders: [rtl ? 15 : 0] },
      })
      for (const wordBreak of ['break-all', 'keep-all'] as const) {
        cases.push({
          parts: [box, 'b c d'],
          style: { ...style, wordBreak, keepTrailingWhitespace: true },
          width: 30,
          expected: { lines: [[0, 1, 35, rtl ? -5 : 0]], placeholders: [rtl ? 15 : 0] },
        })
      }
      // Only spaces after the line: nothing to truncate, though SkParagraph
      // tries.
      cases.push({
        parts: [box, ' '],
        style,
        width: 10,
        expected: { lines: [[0, 1, 15, rtl ? -5 : 0]], placeholders: [rtl ? -5 : 0], didExceedMaxLines: false },
      })
      // Two directions, one font: "aب…" keeps the "a".
      cases.push({
        parts: 'aب cd',
        style: { ...style, ...HARMATTAN },
        width: 13,
        range: [0, 1],
      })
      // A regional indicator pair in a fallback font, as in issue #10.
      cases.push({
        parts: ' 🇧🇪 x',
        style: { ...style, fontFamily: 'WB Source Han', maxLines: 3 },
        width: 30,
      })
    }
  }
  const results = layOutInChild(t, cases)
  t.is(results.length, cases.length)
  for (const [i, result] of results.entries()) {
    const { expected, range, parts, style } = cases[i]
    const name = JSON.stringify({ parts, style })
    if (!result) {
      continue
    }
    if (expected) {
      t.deepEqual(result.lines, expected.lines, name)
      t.deepEqual(result.placeholders, expected.placeholders, name)
      t.is(result.didExceedMaxLines, expected.didExceedMaxLines ?? true, name)
    } else if (range) {
      t.deepEqual(
        result.lines.map(([start, end]) => [start, end]),
        [range],
        name,
      )
      t.true(result.didExceedMaxLines, name)
    } else {
      t.true(result.lines.length > 0, name)
    }
  }
})

test('the first cluster stays, with the ellipsis after it, as Chrome has it', (t) => {
  for (const textAlign of ['left', 'justify', 'right'] as const) {
    const style: ParagraphStyle = { ...IOSEVKA, maxLines: 1, ellipsis: '…', textAlign }
    // "a…" in a line 25px wide, and in one 10px wide, which not even the
    // ellipsis fits.
    const first = new Paragraph('abcd ef', style).layout(25)
    t.deepEqual(lines(first), [[0, 1, 30, 0]], textAlign)
    t.true(first.didExceedMaxLines)
    t.deepEqual(lines(new Paragraph('ab cd', style).layout(10)), [[0, 1, 30, 0]], textAlign)
    // A word too wide for the line: "O…".
    t.deepEqual(lines(new Paragraph('Overlong ab', style).layout(25)), [[0, 1, 30, 0]], textAlign)
    // On the last line shown: "ab", "c…".
    t.deepEqual(
      lines(new Paragraph('ab cd ef', { ...style, maxLines: 2 }).layout(25)),
      [
        [0, 2, 20, textAlign === 'right' ? 5 : 0],
        [3, 4, 30, 0],
      ],
      textAlign,
    )
    t.deepEqual(
      lines(new Paragraph('ab\ncd ef', { ...style, maxLines: 2 }).layout(10)),
      [
        [0, 2, 20, 0],
        [3, 4, 30, 0],
      ],
      textAlign,
    )
  }
})

test('the lines before a line laid out anew stay justified', (t) => {
  // "c..." is 40px wide in a line 35px wide; Chrome justifies "a b" before
  // it to 35px.
  const style: ParagraphStyle = { ...IOSEVKA, maxLines: 2, ellipsis: '...', textAlign: 'justify' }
  t.deepEqual(lines(new Paragraph('a b ccc dd', style).layout(35)), [
    [0, 3, 35, 0],
    [4, 5, 40, 0],
  ])
})

test('the lines before a clamped line are justified', (t) => {
  // Chrome 154 under `text-align: justify` with `-webkit-line-clamp`,
  // compared in screenshots, justifies every line before the last it shows
  // to the width (inked from 1px to 84px at 85px), whether the lines run out
  // inside the text laid out as one piece, in the piece before a word too
  // wide for the line, or in a piece that ends beside an emoji placeholder.
  // Lines as [startIndex, endIndex, width, left].
  const style: ParagraphStyle = { ...IOSEVKA, textAlign: 'justify', ellipsis: '…' }
  const emoji = { width: 20, height: 20, lineBreak: 'emoji' } as const
  const cases: Array<[ParagraphContent, ParagraphStyle, Line[]]> = [
    [
      'aa bb cc dd ee ff gg hh',
      { maxLines: 2 },
      [
        [0, 8, 85, 0],
        [9, 15, 80, 0],
      ],
    ],
    [
      'aa bb cc dd ee ff gg hh ii jj',
      { maxLines: 3 },
      [
        [0, 8, 85, 0],
        [9, 17, 85, 0],
        [18, 24, 80, 0],
      ],
    ],
    [
      'aa bb cc dd ee Overlongwordhere ff',
      { maxLines: 3 },
      [
        [0, 8, 85, 0],
        [9, 14, 85, 0],
        [15, 21, 80, 0],
      ],
    ],
    [
      ['aa bb ', emoji, '! cc dd ee ff gg hh ii jj'],
      { maxLines: 3 },
      [
        [0, 5, 85, 0],
        [6, 11, 85, 0],
        [12, 18, 80, 0],
      ],
    ],
    [
      'aa bb cc dd ee ff gg hh',
      { maxLines: 2, direction: 'rtl' },
      [
        [0, 8, 85, 0],
        [9, 15, 80, 5],
      ],
    ],
  ]
  for (const [parts, extra, expected] of cases) {
    const paragraph = new Paragraph(parts, { ...style, ...extra })
    const name = JSON.stringify({ parts, extra })
    t.deepEqual(lines(paragraph.layout(85)), expected, name)
    // Laid out again after other widths, too.
    paragraph.layout(40)
    paragraph.layout(200)
    const layout = paragraph.layout(85)
    t.deepEqual(lines(layout), expected, name)
    // Painted justified: every line before the last inks up to the right
    // edge, as in Chrome (to 84px), where a start-aligned one stops short.
    for (const [k, ink] of inkPerLine(paragraph, layout).slice(0, -1).entries()) {
      t.true(ink !== null && ink[1] >= 83, `${name} line ${k} inked ${JSON.stringify(ink)}`)
    }
  }
  // Which tells them apart: start-aligned, the first line stops at 79px.
  const start = new Paragraph('aa bb cc dd ee ff gg hh', { ...style, textAlign: 'left', maxLines: 2 })
  const [first] = inkPerLine(start, start.layout(85))
  t.true(first !== null && first[1] < 81, JSON.stringify(first))
})

test('noWrap keeps the first cluster of each line it truncates, with the ellipsis after it', (t) => {
  // As Chrome's text-overflow: ellipsis, which then clips both to the box.
  const style: ParagraphStyle = { ...IOSEVKA, noWrap: true, ellipsis: '…' }
  const layout = new Paragraph(['ab\nab cd\n', box, 'b c'], style).layout(25)
  t.deepEqual(lines(layout), [
    [0, 2, 20, 0],
    [3, 4, 30, 0],
    [9, 10, 35, 0],
  ])
  t.deepEqual(
    layout.lines.map((line) => line.hardBreak),
    [true, true, true],
  )
  t.is(layout.placeholders[0]?.line, 2)
  t.false(layout.didExceedMaxLines)
  // At a width it fits in, nothing is truncated.
  t.deepEqual(lines(new Paragraph(['ab\nab cd\n', box, 'b c'], style).layout(100)), [
    [0, 2, 20, 0],
    [3, 8, 50, 0],
    [9, 13, 45, 0],
  ])
})

test('a clamped line that ends at a hard break gets the ellipsis', (t) => {
  // Chrome 154's -webkit-line-clamp (headless, macOS, the same font file,
  // `white-space: pre-line`, or `pre-wrap` for keepTrailingWhitespace) puts
  // the ellipsis after the last line it shows whenever text is clamped away,
  // even after a hard break, and on an empty line alone; compared in
  // screenshots. Lines as [startIndex, endIndex, width, left].
  const style: ParagraphStyle = { ...IOSEVKA, ellipsis: '…' }
  const cases: Array<[ParagraphContent, ParagraphStyle, number, Line[], boolean]> = [
    ['ab\ncd', { maxLines: 1 }, 100, [[0, 2, 40, 0]], true],
    [
      'ab\n\ncd',
      { maxLines: 2 },
      100,
      [
        [0, 2, 20, 0],
        [3, 3, 20, 0],
      ],
      true,
    ],
    ['\ncd', { maxLines: 1 }, 100, [[0, 0, 20, 0]], true],
    // Nothing is clamped away: Chrome has 'ab\n' as one line.
    ['ab\n', { maxLines: 1 }, 100, [[0, 2, 20, 0]], false],
    ['ab\n\n', { maxLines: 1 }, 100, [[0, 2, 40, 0]], true],
    // "abcdefgh…": the line's text, cut to fit the ellipsis.
    ['abcdefghi\nk', { maxLines: 1 }, 100, [[0, 8, 100, 0]], true],
    // "ab  …": kept spaces stay before the ellipsis.
    ['ab  \ncd', { maxLines: 1, keepTrailingWhitespace: true }, 100, [[0, 4, 60, 0]], true],
    [['ab ', box, '\ncd'], { maxLines: 1 }, 100, [[0, 4, 65, 0]], true],
    ['ab\ncd', { maxLines: 1, textAlign: 'justify' }, 100, [[0, 2, 40, 0]], true],
  ]
  for (const [parts, extra, width, expected, exceeded] of cases) {
    const layout = new Paragraph(parts, { ...style, ...extra }).layout(width)
    const name = JSON.stringify({ parts, extra })
    t.deepEqual(lines(layout), expected, name)
    t.is(layout.didExceedMaxLines, exceeded, name)
  }
})

test('a clamped noWrap line gets the ellipsis, as Chrome has it under white-space: pre', (t) => {
  // Chrome 154's -webkit-line-clamp under `white-space: pre` (headless,
  // macOS, the same font file), compared in screenshots: the last line it
  // shows has the ellipsis after it whenever lines are clamped away after
  // it ("ab…", inked from 1px to 38px), truncated with it to fit the width
  // ("abc…" at 50px, "a…" at 15px), with the spaces before it kept ("ab  …")
  // and alone on an empty line. Without `keepTrailingWhitespace`, as under
  // `white-space: pre-line` with `text-wrap-mode: nowrap`, the spaces before
  // it hang, as at the end of any line ("ab…"). Lines as [startIndex,
  // endIndex, width, left].
  const style: ParagraphStyle = {
    ...IOSEVKA,
    noWrap: true,
    keepTrailingWhitespace: true,
    maxLines: 1,
    ellipsis: '…',
  }
  const cases: Array<[ParagraphContent, ParagraphStyle, number, Line[], boolean]> = [
    ['ab\ncd', {}, 100, [[0, 2, 40, 0]], true],
    ['ab  \ncd', {}, 100, [[0, 4, 60, 0]], true],
    ['ab  \ncd', { keepTrailingWhitespace: false }, 100, [[0, 2, 40, 0]], true],
    ['ab\t \ncd', { keepTrailingWhitespace: false }, 100, [[0, 2, 40, 0]], true],
    ['abcd\ncd', {}, 50, [[0, 3, 50, 0]], true],
    ['abcdefghij\ncd', {}, 15, [[0, 1, 30, 0]], true],
    ['\ncd', {}, 100, [[0, 0, 20, 0]], true],
    ['\ncd', {}, 10, [[0, 0, 20, 0]], true],
    [
      'ab\ncd\nef',
      { maxLines: 2 },
      100,
      [
        [0, 2, 20, 0],
        [3, 5, 40, 0],
      ],
      true,
    ],
    // Nothing is clamped away: Chrome has 'ab\n' as one line.
    ['ab\n', {}, 100, [[0, 2, 20, 0]], false],
    ['ab\n\n', {}, 100, [[0, 2, 40, 0]], true],
    ['ab\r\ncd', {}, 100, [[0, 2, 40, 0]], true],
    ['ab\ncd', { textAlign: 'right' }, 100, [[0, 2, 40, 60]], true],
    [['ab', box, '\ncd'], {}, 100, [[0, 3, 55, 0]], true],
    [['ab\n', box], {}, 100, [[0, 2, 40, 0]], true],
  ]
  for (const [parts, extra, width, expected, exceeded] of cases) {
    const paragraph = new Paragraph(parts, { ...style, ...extra })
    const name = JSON.stringify({ parts, extra, width })
    // Fresh, and laid out again after other widths.
    for (const layout of [
      paragraph.layout(width),
      (paragraph.layout(1), paragraph.layout(1000), paragraph.layout(width)),
    ]) {
      t.deepEqual(lines(layout), expected, name)
      t.is(layout.didExceedMaxLines, exceeded, name)
    }
  }
  // Painted: the last line's ink runs from its text to the end of the
  // ellipsis and no further, over the columns Chrome's screenshots ink
  // (`ab\ncd` is "ab…" from 1px to 38px; "ab" alone ends at 19px).
  const inked: Array<[string, ParagraphStyle, number, [number, number]]> = [
    ['ab\ncd', {}, 100, [1, 38]],
    ['ab  \ncd', {}, 100, [1, 58]],
    ['ab  \ncd', { keepTrailingWhitespace: false }, 100, [1, 38]],
    ['abcd\ncd', {}, 50, [1, 48]],
    ['abcdefghij\ncd', {}, 15, [1, 28]],
    ['\ncd', {}, 100, [2, 18]],
    ['ab\ncd\nef', { maxLines: 2 }, 100, [1, 38]],
    ['ab\n\n', {}, 100, [1, 38]],
    ['ab\r\ncd', {}, 100, [1, 38]],
  ]
  for (const [text, extra, width, expected] of inked) {
    const paragraph = new Paragraph(text, { ...style, ...extra })
    const ink = inkPerLine(paragraph, paragraph.layout(width))
    nearInk(t, ink[ink.length - 1], expected, JSON.stringify({ text, extra, width }))
  }
  // The ellipsis leaves max-content alone.
  t.is(new Paragraph('abc\nde', style).layout(100).maxIntrinsicWidth, 30)
})

test('the last line is its own text with the ellipsis after it, as Chrome has it', (t) => {
  // Chrome 154's -webkit-line-clamp, compared in screenshots as above, puts
  // the ellipsis after the last line's own text, without the spaces that
  // hang at its end under `pre-line` (kept under `pre-wrap`, which is
  // keepTrailingWhitespace), and takes grapheme clusters off the end of it
  // until the two fit, keeping the spaces that are then last. SkParagraph
  // would fill the line with the start of the next word instead ("ab cd
  // e…"). Lines as [startIndex, endIndex, width, left].
  const style: ParagraphStyle = { ...IOSEVKA, maxLines: 1, ellipsis: '…' }
  const kept: ParagraphStyle = { keepTrailingWhitespace: true }
  const cases: Array<[ParagraphContent, number, Line, ParagraphStyle?]> = [
    ['aaaa bbbb cccc', 100, [0, 8, 100, 0]], // "aaaa bbb…"
    ['aaaa bb cccc', 100, [0, 7, 90, 0]], // "aaaa bb…"
    ['aaaa bb cccc', 100, [0, 8, 100, 0], kept], // "aaaa bb …"
    ['ab cd efgh ij', 95, [0, 5, 70, 0]], // "ab cd…"
    ['ab cd efgh ij', 95, [0, 6, 80, 0], kept], // "ab cd …"
    ['a b c d e f g h', 100, [0, 8, 100, 0]], // "a b c d …"
    ['ab cd\nef', 55, [0, 3, 50, 0]], // "ab …"
    ['ab-cd-efgh-ij', 100, [0, 6, 80, 0]], // "ab-cd-…"
    [['ab ', { width: 70, height: 10 }, ' cd'], 100, [0, 3, 50, 0]], // "ab …"
  ]
  for (const [parts, width, expected, extra] of cases) {
    const layout = new Paragraph(parts, { ...style, ...extra }).layout(width)
    t.deepEqual(lines(layout), [expected], JSON.stringify({ parts, extra }))
    t.true(layout.didExceedMaxLines)
  }
  // A box wider than the line stays on the last line, overflowing it with
  // the ellipsis after it; Chrome clips both to the box.
  const wide = new Paragraph(['ab ', { width: 130, height: 10 }, ' cd'], { ...style, maxLines: 2 }).layout(100)
  t.deepEqual(lines(wide), [
    [0, 2, 20, 0],
    [3, 4, 150, 0],
  ])
  t.is(wide.placeholders[0]?.line, 1)
})

test('a clamped line is aligned with its ellipsis', (t) => {
  // Chrome 154 aligns the line by its text alone and puts the ellipsis
  // after it, past the end edge where it doesn't fit ("ab" from 80px, the
  // ellipsis from 100px; "aaaa bbb…" from 10px to 110px), where overflow
  // hides it. The paragraph aligns the line it shows, ellipsis included, so
  // the ellipsis stays in the box (docs/effing.md).
  const style: ParagraphStyle = { ...IOSEVKA, maxLines: 1, ellipsis: '…' }
  for (const [textAlign, left] of [
    ['right', 60],
    ['center', 30],
  ] as const) {
    t.deepEqual(lines(new Paragraph('ab\ncd', { ...style, textAlign }).layout(100)), [[0, 2, 40, left]])
    t.deepEqual(lines(new Paragraph('aaaa bbbb cccc', { ...style, textAlign }).layout(100)), [[0, 8, 100, 0]])
  }
})

test('an RTL clamped line is as wide as its text, placeholders and ellipsis', (t) => {
  // In RTL the ellipsis lies left of the line's text, and a placeholder can
  // end the line on its right. Chrome 154 (`dir=rtl`, `text-align: right`,
  // `-webkit-line-clamp: 2`, 110px wide, the box an inline-block) puts the
  // box at 90px, against the right edge, and the line's ink from 19px; the
  // line used to leave the ellipsis out of its width, and push the box past
  // the right edge, to 102.63px.
  const parts: ParagraphContent = ['بتث بتث بتث ', { width: 20, height: 20 }, '! 2026 بتث بتث بتث']
  const style: ParagraphStyle = {
    ...HARMATTAN,
    fontFamily: 'WB Harmattan, WB Iosevka',
    direction: 'rtl',
    maxLines: 2,
    ellipsis: '…',
  }
  // Painted, the line's ink (fillParagraph paints no placeholder) runs from
  // the ellipsis, at its left end, to the text before the box: from 19px,
  // as in Chrome, when right-aligned.
  for (const [textAlign, left, box, ink] of [
    ['right', 18.12, 90, [19, 88]],
    ['center', 9.06, 80.94, [10, 79]],
    ['left', 0, 71.88, [1, 70]],
  ] as const) {
    const paragraph = new Paragraph(parts, { ...style, textAlign })
    const layout = paragraph.layout(110)
    t.deepEqual(lines(layout)[1], [12, 22, 91.88, left], textAlign)
    t.is(round(layout.placeholders[0]?.x ?? NaN), box, textAlign)
    t.is(layout.placeholders[0]?.line, 1)
    nearInk(t, inkPerLine(paragraph, layout, 200)[1], [...ink], textAlign)
  }
})

test('the clamped line keeps the bidi levels its text has in the paragraph', (t) => {
  // An LTR paragraph of Arabic, as canvas lays it out: in Chrome 154 the box
  // and the digits on the clamped line sit where they do without the clamp,
  // between the Arabic words, since bidi is resolved for the whole
  // paragraph. Laid out on its own, the line would put them at its start.
  const style: ParagraphStyle = { ...HARMATTAN, maxLines: 2, ellipsis: '…' }
  const boxed = new Paragraph(['بتث بتث بتث ', { width: 20, height: 20 }, ' بتث بتث بتث بتث بتث'], style).layout(110)
  t.is(boxed.placeholders[0]?.line, 1)
  t.is(round(boxed.placeholders[0]!.x), 68.05) // Chrome: 68.05
  // Where '2026' is drawn on the second line: right of the Arabic, as in
  // Chrome, not at the line's start.
  const inkColumns = (paragraph: Paragraph, line: number) => {
    const canvas = createCanvas(200, 80)
    const ctx = canvas.getContext('2d')
    fillParagraph(ctx, paragraph, 0, 0)
    const data = ctx.getImageData(0, line * 40, 200, 40).data
    return Array.from({ length: 200 }, (_, x) => {
      let sum = 0
      for (let y = 0; y < 40; y++) sum += data[(y * 200 + x) * 4 + 3]
      return sum
    })
  }
  const digits = new Paragraph('2026', HARMATTAN)
  digits.layout(1000)
  const pattern = inkColumns(digits, 0).slice(0, 40)
  const at = (paragraph: Paragraph) => {
    const columns = inkColumns(paragraph, 1)
    let best = -Infinity
    let where = 0
    for (let x = 0; x < 160; x++) {
      let score = 0
      for (let k = 0; k < 40; k++) score -= Math.abs((columns[x + k] ?? 0) - pattern[k])
      if (score > best) {
        best = score
        where = x
      }
    }
    return where
  }
  const text = 'بتث بتث بتث 2026 بتث بتث بتث بتث بتث'
  const plain = new Paragraph(text, HARMATTAN)
  plain.layout(110)
  const clamped = new Paragraph(text, style)
  clamped.layout(110)
  t.is(at(plain), 68)
  // The clamped line's text is cut short before the digits, logically last.
  t.true(at(clamped) >= 40, `${at(clamped)}`)
})

test('a clamped line is letter-spaced as in the paragraph', (t) => {
  // A character of no script of its own, the "%" here, takes that of the
  // text around it, Arabic, which neither Chrome nor SkParagraph letter-
  // spaces. The clamped line used to end it before the Arabic after it, and
  // space it: the box after it (on screen, before it) moved by the letter
  // spacing. Chrome 154 puts the box at 11.17px at any letter spacing, the
  // clamped line as the paragraph (#24).
  const parts: ParagraphContent = ['بتث ', { width: 20, height: 20 }, '% بتث بتث بتث']
  for (const letterSpacing of [0, -0.5, 3]) {
    const style: ParagraphStyle = { ...HARMATTAN, letterSpacing }
    const whole = new Paragraph(parts, style).layout(85)
    const clamped = new Paragraph(parts, { ...style, maxLines: 1, ellipsis: '…' }).layout(85)
    t.is(round(whole.placeholders[0]!.x), 11.17, `${letterSpacing}`)
    t.is(round(clamped.placeholders[0]!.x), 11.17, `${letterSpacing}`)
    t.deepEqual(
      clamped.lines.map((line) => [line.startIndex, line.endIndex]),
      [[0, 6]],
    )
  }
  // As in #20: the clamped second line puts its boxes where the paragraph
  // does, whatever the letter spacing.
  const emoji = { width: 20, height: 20, lineBreak: 'emoji' } as const
  const issue: ParagraphContent = [
    'بتث -بالعالم ',
    { width: 20, height: 20 },
    '! 12 مرحبا )بتث شكرا بتث ',
    emoji,
    '% بالعالم ',
    emoji,
    ' 3.5',
  ]
  for (const letterSpacing of [-0.5, 3]) {
    const style: ParagraphStyle = { ...HARMATTAN, fontFamily: 'WB Harmattan, WB Iosevka', letterSpacing }
    const whole = new Paragraph(issue, style).layout(200)
    const clamped = new Paragraph(issue, { ...style, maxLines: 2, ellipsis: '…' }).layout(200)
    t.deepEqual(
      clamped.placeholders.slice(0, 2).map((box) => box && [round(box.x), box.line]),
      whole.placeholders.slice(0, 2).map((box) => box && [round(box.x), box.line]),
      `${letterSpacing}`,
    )
  }
})
