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
