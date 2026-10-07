import { readFileSync } from 'node:fs'
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

// A copy of a TrueType font with its hhea lineGap set to `lineGap`.
function withLineGap(font: Buffer, lineGap: number): Buffer {
  const copy = Buffer.from(font)
  const tables = copy.readUInt16BE(4)
  for (let i = 0; i < tables; i++) {
    const record = 12 + 16 * i
    if (copy.toString('latin1', record, record + 4) === 'hhea') {
      copy.writeInt16BE(lineGap, copy.readUInt32BE(record + 8) + 8)
      return copy
    }
  }
  throw new Error('no hhea table')
}

const NORMAL_SIZES = [7, 11, 13, 16, 20, 23, 33, 37]

// `line-height: normal` at each of NORMAL_SIZES: [line height, baseline],
// measured in Chrome 154 (headless, macOS) from `<div style="font: <size>px
// <font>"><i></i><br><i></i></div>` with the <i>s zero-size inline-blocks
// (no text, so no fallback font grows the lines): the div is two line heights
// tall and the <i>s' tops are the baselines. Lato+200 and Lato+333 are Lato
// with its hhea line gap set to 200 and 333 units.
const CHROME_NORMAL: Array<[string, Array<[number, number]>]> = [
  [
    'COLR-v1.ttf',
    [
      [8, 6],
      [13, 10],
      [15, 12],
      [19, 15],
      [24, 19],
      [27, 21],
      [39, 31],
      [43, 34],
    ],
  ],
  [
    'Cascadia.woff2',
    [
      [9, 7],
      [14, 11],
      [16, 13],
      [19, 15],
      [24, 19],
      [27, 22],
      [40, 32],
      [45, 36],
    ],
  ],
  [
    'HYXiXingKaiW.ttf',
    [
      [7, 6],
      [11, 9],
      [13, 10],
      [16, 13],
      [20, 16],
      [23, 18],
      [33, 26],
      [37, 30],
    ],
  ],
  [
    'Harmattan-Regular.ttf',
    [
      [12, 7],
      [19, 12],
      [22, 14],
      [27, 17],
      [34, 21],
      [39, 24],
      [56, 35],
      [63, 39],
    ],
  ],
  [
    'Inconsolata-VariableFont_wdth,wght.woff2',
    [
      [7, 6],
      [11, 9],
      [13, 11],
      [17, 14],
      [21, 17],
      [24, 20],
      [34, 28],
      [39, 32],
    ],
  ],
  [
    'Lato-Regular.ttf',
    [
      [8, 7],
      [13, 11],
      [16, 13],
      [19, 16],
      [24, 20],
      [28, 23],
      [40, 33],
      [45, 37],
    ],
  ],
  [
    'NotoSansDevanagari-Regular.ttf',
    [
      [9, 6],
      [14, 10],
      [17, 12],
      [21, 14],
      [26, 18],
      [30, 21],
      [43, 30],
      [48, 33],
    ],
  ],
  [
    'NotoSansMongolian-Regular.ttf',
    [
      [12, 10],
      [19, 16],
      [23, 19],
      [28, 23],
      [35, 29],
      [41, 34],
      [58, 48],
      [65, 54],
    ],
  ],
  [
    'NotoSansNKo-Regular.ttf',
    [
      [9, 7],
      [15, 12],
      [18, 14],
      [22, 17],
      [27, 21],
      [32, 25],
      [45, 35],
      [51, 40],
    ],
  ],
  [
    'Oswald.ttf',
    [
      [10, 8],
      [16, 13],
      [20, 16],
      [24, 19],
      [30, 24],
      [34, 27],
      [49, 39],
      [55, 44],
    ],
  ],
  [
    'RobotoMono-VariableFont_wght.ttf',
    [
      [9, 7],
      [15, 12],
      [18, 14],
      [21, 17],
      [26, 21],
      [30, 24],
      [44, 35],
      [49, 39],
    ],
  ],
  [
    'ScienceGothic-VariableFont.ttf',
    [
      [11, 8],
      [16, 12],
      [19, 14],
      [23, 17],
      [30, 22],
      [34, 25],
      [49, 36],
      [54, 40],
    ],
  ],
  [
    'SourceHanSerifCN-Bold.ttf',
    [
      [10, 8],
      [16, 13],
      [19, 15],
      [23, 18],
      [29, 23],
      [33, 26],
      [47, 38],
      [54, 43],
    ],
  ],
  [
    'SourceSerifPro-Regular.ttf',
    [
      [8, 6],
      [14, 10],
      [16, 12],
      [20, 15],
      [25, 18],
      [29, 21],
      [41, 30],
      [46, 34],
    ],
  ],
  [
    'Virgil.woff2',
    [
      [9, 6],
      [14, 10],
      [17, 12],
      [20, 14],
      [25, 18],
      [29, 20],
      [41, 29],
      [47, 33],
    ],
  ],
  [
    'iosevka-slab-regular.ttf',
    [
      [8, 7],
      [14, 11],
      [17, 13],
      [20, 16],
      [25, 20],
      [29, 23],
      [41, 33],
      [47, 37],
    ],
  ],
  [
    'osrs-font-compact.otf',
    [
      [5, 4],
      [8, 7],
      [10, 8],
      [12, 10],
      [16, 13],
      [17, 14],
      [25, 21],
      [28, 23],
    ],
  ],
  [
    'Lato+200',
    [
      [9, 7],
      [14, 11],
      [17, 13],
      [21, 17],
      [26, 21],
      [30, 24],
      [43, 34],
      [49, 39],
    ],
  ],
  [
    'Lato+333',
    [
      [9, 7],
      [15, 12],
      [18, 14],
      [22, 17],
      [27, 21],
      [32, 25],
      [45, 35],
      [51, 40],
    ],
  ],
]

test('normal is Chrome line-height: normal', (t) => {
  const lato = readFileSync(join(__dirname, 'fonts', 'Lato-Regular.ttf'))
  for (const [n, [file, boxes]] of CHROME_NORMAL.entries()) {
    // Not the file name, which can have a comma.
    const fontFamily = `HL Normal ${n}`
    const gap = /^Lato\+(\d+)$/.exec(file)
    t.truthy(
      gap
        ? GlobalFonts.register(withLineGap(lato, Number(gap[1])), fontFamily)
        : GlobalFonts.registerFromPath(join(__dirname, 'fonts', file), fontFamily),
      file,
    )
    for (const [i, fontSize] of NORMAL_SIZES.entries()) {
      const [lineHeight, baseline] = boxes[i]
      const at = `${file} ${fontSize}px`
      for (const omitted of [undefined, null]) {
        const layout = new Paragraph('a\nb', { fontFamily, fontSize, lineHeight: omitted }).layout(400)
        t.is(layout.lineHeight, lineHeight, at)
        t.is(layout.height, 2 * lineHeight, at)
        t.is(layout.lines[0].baseline, baseline, at)
        t.is(layout.lines[1].baseline, lineHeight + baseline, at)
        // Chrome's line spacing, and its half-leading of the line gap.
        const [a, d, g] = [layout.ascent, layout.descent, layout.lineGap].map(Math.round)
        t.is(lineHeight, a + d + g, at)
        t.is(baseline, a + Math.floor(g / 2), at)
      }
    }
  }
})
