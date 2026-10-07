import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts } from '../index'
import { Paragraph, type ParagraphLayout } from '../extensions'

const __dirname = dirname(fileURLToPath(import.meta.url))

test.before((t) => {
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'), 'HL Iosevka Slab'))
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), 'HL Lato'))
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Oswald.ttf'), 'HL Oswald'))
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'HL Source Serif Pro'))
  t.truthy(
    GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'NotoSansDevanagari-Regular.ttf'), 'HL Noto Devanagari'),
  )
})

function near(t: import('ava').ExecutionContext, actual: number, expected: number, epsilon = 1e-4) {
  t.true(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`)
}

function layOut(fontFamily: string, fontSize: number, lineHeight: number): ParagraphLayout {
  return new Paragraph('Hxg\nHxg', { fontFamily, fontSize, lineHeight }).layout(400)
}

// A px line height as Chrome lays it out, in LayoutUnits of 1/64px.
const layoutUnits = (px: number) => Math.round(px * 64) / 64

// Line heights in px: 0, smaller than the content area, fractional (18.75 is
// 1.25 × 15px), and ones Chrome rounds to 1/64px (33.3 is 33.296875).
const LINE_HEIGHTS = [0, 1, 7, 12.5, 18.75, 22, 25, 29.25, 30, 30.5, 31, 33.3, 41.17]

// The first line's baseline at each of LINE_HEIGHTS, measured in Chrome 154
// (headless, macOS) from `<div style="font: <size>px <font>; line-height:
// <lh>px"><span>Hxg</span><br><span>Hxg</span></div>`: the top of each
// span's Range rect from the div's top, plus the rounded ascent (the
// baseline of a zero-size inline-block in a `line-height: normal` div less
// its span's top). The second line's is the line height in LayoutUnits
// further down, and the div is two of them tall, in every case.
const CHROME_BASELINES: Array<[string, number, number[]]> = [
  ['HL Iosevka Slab', 7, [3, 3, 6, 9, 12, 14, 15, 17, 18, 18, 18, 19, 23]],
  ['HL Iosevka Slab', 11, [4, 5, 8, 10, 13, 15, 17, 19, 19, 19, 20, 21, 25]],
  ['HL Iosevka Slab', 13, [5, 5, 8, 11, 14, 16, 17, 19, 20, 20, 20, 21, 25]],
  ['HL Iosevka Slab', 15, [6, 6, 9, 12, 15, 17, 18, 20, 21, 21, 21, 22, 26]],
  ['HL Iosevka Slab', 16, [6, 7, 10, 12, 15, 17, 19, 21, 21, 21, 22, 23, 27]],
  ['HL Iosevka Slab', 17, [7, 7, 10, 13, 16, 18, 19, 21, 22, 22, 22, 23, 27]],
  ['HL Iosevka Slab', 20, [8, 8, 11, 14, 17, 19, 20, 22, 23, 23, 23, 24, 28]],
  ['HL Iosevka Slab', 23, [8, 9, 12, 14, 17, 19, 21, 23, 23, 23, 24, 25, 29]],
  ['HL Iosevka Slab', 37, [14, 14, 17, 20, 23, 25, 26, 28, 29, 29, 29, 30, 34]],
  ['HL Lato', 7, [3, 3, 6, 9, 12, 14, 15, 17, 18, 18, 18, 19, 23]],
  ['HL Lato', 11, [4, 5, 8, 10, 13, 15, 17, 19, 19, 19, 20, 21, 25]],
  ['HL Lato', 13, [5, 5, 8, 11, 14, 16, 17, 19, 20, 20, 20, 21, 25]],
  ['HL Lato', 15, [6, 6, 9, 12, 15, 17, 18, 20, 21, 21, 21, 22, 26]],
  ['HL Lato', 16, [6, 7, 10, 12, 15, 17, 19, 21, 21, 21, 22, 23, 27]],
  ['HL Lato', 17, [6, 7, 10, 12, 15, 17, 19, 21, 21, 21, 22, 23, 27]],
  ['HL Lato', 20, [8, 8, 11, 14, 17, 19, 20, 22, 23, 23, 23, 24, 28]],
  ['HL Lato', 23, [9, 9, 12, 15, 18, 20, 21, 23, 24, 24, 24, 25, 29]],
  ['HL Lato', 37, [14, 15, 18, 20, 23, 25, 27, 29, 29, 29, 30, 31, 35]],
  ['HL Oswald', 7, [3, 3, 6, 9, 12, 14, 15, 17, 18, 18, 18, 19, 23]],
  ['HL Oswald', 11, [5, 5, 8, 11, 14, 16, 17, 19, 20, 20, 20, 21, 25]],
  ['HL Oswald', 13, [6, 6, 9, 12, 15, 17, 18, 20, 21, 21, 21, 22, 26]],
  ['HL Oswald', 15, [7, 7, 10, 13, 16, 18, 19, 21, 22, 22, 22, 23, 27]],
  ['HL Oswald', 16, [7, 7, 10, 13, 16, 18, 19, 21, 22, 22, 22, 23, 27]],
  ['HL Oswald', 17, [7, 8, 11, 13, 16, 18, 20, 22, 22, 22, 23, 24, 28]],
  ['HL Oswald', 20, [9, 9, 12, 15, 18, 20, 21, 23, 24, 24, 24, 25, 29]],
  ['HL Oswald', 23, [10, 10, 13, 16, 19, 21, 22, 24, 25, 25, 25, 26, 30]],
  ['HL Oswald', 37, [16, 17, 20, 22, 25, 27, 29, 31, 31, 31, 32, 33, 37]],
  ['HL Source Serif Pro', 7, [2, 2, 5, 8, 11, 13, 14, 16, 17, 17, 17, 18, 22]],
  ['HL Source Serif Pro', 11, [3, 3, 6, 9, 12, 14, 15, 17, 18, 18, 18, 19, 23]],
  ['HL Source Serif Pro', 13, [4, 4, 7, 10, 13, 15, 16, 18, 19, 19, 19, 20, 24]],
  ['HL Source Serif Pro', 15, [4, 5, 8, 10, 13, 15, 17, 19, 19, 19, 20, 21, 25]],
  ['HL Source Serif Pro', 16, [5, 5, 8, 11, 14, 16, 17, 19, 20, 20, 20, 21, 25]],
  ['HL Source Serif Pro', 17, [5, 5, 8, 11, 14, 16, 17, 19, 20, 20, 20, 21, 25]],
  ['HL Source Serif Pro', 20, [5, 6, 9, 11, 14, 16, 18, 20, 20, 20, 21, 22, 26]],
  ['HL Source Serif Pro', 23, [6, 7, 10, 12, 15, 17, 19, 21, 21, 21, 22, 23, 27]],
  ['HL Source Serif Pro', 37, [11, 11, 14, 17, 20, 22, 23, 25, 26, 26, 26, 27, 31]],
  ['HL Noto Devanagari', 7, [1, 2, 5, 7, 10, 12, 14, 16, 16, 16, 17, 18, 22]],
  ['HL Noto Devanagari', 11, [3, 3, 6, 9, 12, 14, 15, 17, 18, 18, 18, 19, 23]],
  ['HL Noto Devanagari', 13, [3, 4, 7, 9, 12, 14, 16, 18, 18, 18, 19, 20, 24]],
  ['HL Noto Devanagari', 15, [3, 4, 7, 9, 12, 14, 16, 18, 18, 18, 19, 20, 24]],
  ['HL Noto Devanagari', 16, [3, 4, 7, 9, 12, 14, 16, 18, 18, 18, 19, 20, 24]],
  ['HL Noto Devanagari', 17, [4, 4, 7, 10, 13, 15, 16, 18, 19, 19, 19, 20, 24]],
  ['HL Noto Devanagari', 20, [5, 5, 8, 11, 14, 16, 17, 19, 20, 20, 20, 21, 25]],
  ['HL Noto Devanagari', 23, [6, 6, 9, 12, 15, 17, 18, 20, 21, 21, 21, 22, 26]],
  ['HL Noto Devanagari', 37, [9, 9, 12, 15, 18, 20, 21, 23, 24, 24, 24, 25, 29]],
]

test('the baselines sit where Chrome puts them', (t) => {
  for (const [fontFamily, fontSize, baselines] of CHROME_BASELINES) {
    for (const [i, lineHeight] of LINE_HEIGHTS.entries()) {
      const layout = layOut(fontFamily, fontSize, lineHeight)
      const at = `${fontFamily} ${fontSize}px at ${lineHeight}px`
      t.is(layout.lines.length, 2, at)
      t.is(layout.lineHeight, layoutUnits(lineHeight), at)
      t.is(layout.height, 2 * layoutUnits(lineHeight), at)
      t.is(layout.lines[0].baseline, baselines[i], at)
      t.is(layout.lines[1].baseline, layoutUnits(lineHeight) + baselines[i], at)
    }
  }
})

test('the half-leading is floored from the rounded ascent and descent', (t) => {
  // Chrome's rule (Blink's CalculateLeadingSpace): round the ascent and
  // descent, take the leading as the line height less their sum, and floor
  // the half above the text, the odd pixel going below.
  for (const [fontFamily, fontSize] of CHROME_BASELINES) {
    for (const lineHeight of LINE_HEIGHTS) {
      const layout = layOut(fontFamily, fontSize, lineHeight)
      const ascent = Math.round(layout.ascent)
      const descent = Math.round(layout.descent)
      const baseline = ascent + Math.floor((layout.lineHeight - ascent - descent) / 2)
      t.is(layout.lines[0].baseline, baseline, `${fontFamily} ${fontSize}px at ${lineHeight}px`)
    }
  }
})

test('a line height rounds to LayoutUnits, and the leading halves towards 0 in them', (t) => {
  // Measured in Chrome 154 as above, Lato at 20px (ascent 19.74 and descent
  // 4.26, so a content area of 24px): [line height, Chrome's line height, first
  // baseline]. A leading of -1/64px halves to 0, which puts the baseline at
  // the ascent, where one of -2/64px halves to -1/64px, which floors to -1.
  const cases: Array<[number, number, number]> = [
    [23.984375, 23.984375, 20],
    [23.96875, 23.96875, 19],
    [23.99, 23.984375, 20],
    [23.995, 24, 20],
    [24, 24, 20],
    [24.0078125, 24.015625, 20],
    [0.0078125, 0.015625, 8],
  ]
  for (const [lineHeight, chrome, baseline] of cases) {
    const layout = layOut('HL Lato', 20, lineHeight)
    t.is(layout.lineHeight, chrome, `${lineHeight}`)
    t.is(layout.height, 2 * chrome, `${lineHeight}`)
    t.is(layout.lines[0].baseline, baseline, `${lineHeight}`)
    t.is(layout.lines[1].baseline, chrome + baseline, `${lineHeight}`)
  }
})

test('text-top and text-bottom placeholders align with the rounded ascent and descent', (t) => {
  // In Chrome, as above with a 1px by 3px inline-block of `vertical-align:
  // text-top` and one of `text-bottom` in a line three font sizes tall: their
  // top and bottom were the rounded ascent above and the rounded descent below
  // the baseline in every case.
  for (const [fontFamily, fontSize] of CHROME_BASELINES) {
    const layout = new Paragraph(
      [
        'Hxg',
        { width: 1, height: 3, verticalAlign: 'text-top' },
        { width: 1, height: 3, verticalAlign: 'text-bottom' },
      ],
      { fontFamily, fontSize, lineHeight: 3 * fontSize },
    ).layout(400)
    const baseline = layout.lines[0].baseline
    near(t, layout.placeholders[0]!.y, baseline - Math.round(layout.ascent))
    near(t, layout.placeholders[1]!.y + 3, baseline + Math.round(layout.descent))
  }
})
