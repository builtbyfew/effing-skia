import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test, { type ExecutionContext } from 'ava'

import { GlobalFonts } from '../index'
import { Paragraph, type ParagraphContent, type ParagraphLayout, type ParagraphStyle } from '../extensions'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const fonts = join(__dirname, 'fonts')

// When not even a line's first grapheme cluster fits with the ellipsis, or
// the ellipsis alone doesn't, Chrome keeps that cluster and puts the
// ellipsis after it, both overflowing the line, for -webkit-line-clamp and
// for text-overflow alike (Chrome 154, headless, macOS, the same font files).
// Iosevka Slab advances every character, the ellipsis too, 10px at 20px:
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

// Lays each case out in a child process, so that a layout that never
// returns fails the test instead of hanging the run.
function layOutInChild(t: ExecutionContext, cases: Case[]) {
  const script = `
    const { join } = require('node:path')
    const { GlobalFonts } = require(join(process.cwd(), 'index.js'))
    const { Paragraph } = require(join(process.cwd(), 'extensions.js'))
    const fonts = join(process.cwd(), '__test__', 'fonts')
    GlobalFonts.registerFromPath(join(fonts, 'iosevka-slab-regular.ttf'), 'WB Iosevka')
    GlobalFonts.registerFromPath(join(fonts, 'Harmattan-Regular.ttf'), 'WB Harmattan')
    GlobalFonts.registerFromPath(join(fonts, 'SourceHanSerifCN-Bold.ttf'), 'WB Source Han')
    const round = (x) => Math.round(x * 100) / 100
    const cases = JSON.parse(process.argv[1])
    console.log(JSON.stringify(cases.map(({ parts, style, width }) => {
      const layout = new Paragraph(parts, style).layout(width)
      return {
        lines: layout.lines.map((line) => [line.startIndex, line.endIndex, round(line.width), round(line.left)]),
        placeholders: layout.placeholders.map((p) => p && round(p.x)),
        didExceedMaxLines: layout.didExceedMaxLines,
      }
    })))
  `
  try {
    const out = execFileSync(process.execPath, ['-e', script, JSON.stringify(cases)], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
      timeout: 60_000,
      killSignal: 'SIGKILL',
    })
    return JSON.parse(out) as { lines: Line[]; placeholders: (number | null)[]; didExceedMaxLines: boolean }[]
  } catch (e) {
    t.fail(`layout did not return: ${(e as Error).message}`)
    return []
  }
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
