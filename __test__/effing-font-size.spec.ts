import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts, type SKRSContext2D } from '../index'
import { Paragraph } from '../extensions'

const __dirname = dirname(fileURLToPath(import.meta.url))

test.before((t) => {
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'), 'FS Iosevka Slab'))
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), 'FS Lato'))
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Oswald.ttf'), 'FS Oswald'))
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'FS Source Serif Pro'))
  t.truthy(
    GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'NotoSansDevanagari-Regular.ttf'), 'FS Noto Devanagari'),
  )
})

function near(t: import('ava').ExecutionContext, actual: number, expected: number, epsilon = 1e-4) {
  t.true(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`)
}

const DEVANAGARI = 'नमस्ते दुनिया'
const LATIN = 'Hxg The quick brown fox jumps over'

function layOut(text: string, fontFamily: string, fontSize: number) {
  return new Paragraph(text, { fontFamily, fontSize, noWrap: true }).layout(10000)
}

function measure(text: string, fontFamily: string, fontSize: number, textRendering: SKRSContext2D['textRendering']) {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = `${fontSize}px "${fontFamily}"`
  ctx.textRendering = textRendering
  return ctx.measureText(text).width
}

// Chrome 154 (headless, macOS) lays text out at the font size floored to
// 1/100px, in float: 17.3 (17.2999992 as a float, which times 100 is
// 1729.99988) is 17.29, while 17.301 and 17.305 are 17.30. Noto Sans
// Devanagari's hhea ascent is 896/1000, so at 17.29 it is 15.49 and rounds to
// 15, at 17.30 15.50 and 16. Measured from `<div style="font: <size>px
// <font>; line-height: normal">` with a zero-size inline-block after the
// text, with a FontFace of its own for each size: Chrome caches a face's font
// data under unsigned(size × 100), which takes 17.30 (1729.99988) for 17.29,
// so in a page that used 17.29 first, 17.301 and 17.305 lay out at 17.29 too.
test('a paragraph lays out at the font size floored to 1/100px, as Chrome does', (t) => {
  for (const [size, lineHeight, baseline] of [
    [17.29, 22, 15],
    [17.295, 22, 15],
    [17.299, 22, 15],
    [17.3, 22, 15],
    [17.301, 23, 16],
    [17.305, 23, 16],
    [17.31, 23, 16],
  ]) {
    const layout = layOut(DEVANAGARI, 'FS Noto Devanagari', size)
    t.is(layout.lineHeight, lineHeight, `line height at ${size}px`)
    t.is(layout.lines[0].baseline, baseline, `baseline at ${size}px`)
  }
  // The metrics the layout reports are the font's at that size too.
  const layout = layOut(DEVANAGARI, 'FS Noto Devanagari', 17.3)
  near(t, layout.ascent, (896 / 1000) * 17.29)
  near(t, layout.descent, (408 / 1000) * 17.29)
})

// Sizes at which flooring changes a rounded ascent, descent or line gap, and
// with it the `normal` line height or the baseline, with Chrome's [size,
// lineHeight, baseline] for each, measured as above: the first size of each
// run of such sizes, by 0.001px, from 8 to 40px. The exact size gave a line
// 1px taller in each, or a baseline 1px lower.
const CHROME_FLOORED: Array<[string, string, number[][]]> = [
  [
    'FS Iosevka Slab',
    LATIN,
    [
      [8.701, 11, 8],
      [9.724, 12, 9],
      [10.748, 13, 10],
      [11.771, 14, 11],
      [12.196, 15, 12],
      [12.795, 16, 12],
      [13.818, 17, 13],
      [14.842, 18, 14],
      [15.865, 19, 15],
      [16.889, 20, 16],
      [17.074, 21, 17],
      [17.912, 22, 17],
      [18.936, 23, 18],
      [19.96, 24, 19],
      [20.983, 25, 20],
      [21.952, 26, 21],
      [22.007, 27, 21],
      [22.059, 28, 22],
      [24.054, 30, 24],
      [25.077, 31, 25],
      [26.101, 32, 26],
      [27.124, 34, 27],
      [28.148, 35, 28],
      [29.171, 36, 29],
      [30.195, 37, 30],
      [31.219, 38, 31],
      [31.708, 39, 32],
      [32.242, 40, 32],
      [33.266, 41, 33],
      [34.289, 42, 34],
      [35.313, 43, 35],
      [36.336, 44, 36],
      [36.586, 45, 37],
      [36.765, 46, 37],
      [38.383, 48, 38],
      [39.407, 49, 39],
    ],
  ],
  [
    'FS Lato',
    LATIN,
    [
      [8.612, 10, 8],
      [9.626, 11, 9],
      [10.639, 12, 10],
      [11.652, 13, 11],
      [11.738, 14, 12],
      [12.665, 15, 12],
      [13.678, 16, 13],
      [14.691, 17, 14],
      [15.705, 18, 15],
      [16.432, 19, 16],
      [16.718, 20, 16],
      [17.731, 21, 17],
      [18.744, 22, 18],
      [19.757, 23, 19],
      [20.771, 24, 20],
      [21.127, 25, 21],
      [21.784, 26, 21],
      [22.797, 27, 22],
      [24.823, 29, 24],
      [25.822, 30, 25],
      [25.836, 31, 25],
      [27.863, 33, 27],
      [28.876, 34, 28],
      [29.889, 35, 29],
      [30.517, 36, 30],
      [30.902, 37, 30],
      [31.915, 38, 31],
      [32.929, 39, 32],
      [33.942, 40, 33],
      [34.955, 41, 34],
      [35.212, 42, 35],
      [35.968, 43, 35],
      [36.981, 44, 36],
      [37.994, 45, 37],
      [39.008, 46, 38],
      [39.907, 47, 39],
    ],
  ],
  [
    'FS Oswald',
    LATIN,
    [
      [8.651, 12, 10],
      [8.802, 13, 10],
      [10.478, 15, 12],
      [11.317, 16, 13],
      [12.111, 17, 14],
      [12.155, 18, 14],
      [12.993, 19, 15],
      [13.831, 20, 16],
      [14.669, 21, 17],
      [15.508, 22, 18],
      [15.571, 23, 19],
      [16.346, 24, 19],
      [17.184, 25, 20],
      [18.022, 26, 21],
      [18.861, 27, 22],
      [19.032, 28, 23],
      [19.699, 29, 23],
      [20.537, 30, 24],
      [21.375, 31, 25],
      [22.213, 32, 26],
      [22.492, 33, 27],
      [23.052, 34, 27],
      [24.728, 36, 29],
      [25.566, 37, 30],
      [25.952, 38, 31],
      [26.405, 39, 31],
      [27.243, 40, 32],
      [28.081, 41, 33],
      [28.919, 42, 34],
      [29.412, 43, 35],
      [29.757, 44, 35],
      [30.596, 45, 36],
      [31.434, 46, 37],
      [32.272, 47, 38],
      [32.872, 48, 39],
      [33.949, 50, 40],
      [34.787, 51, 41],
      [35.625, 52, 42],
      [36.333, 53, 43],
      [36.463, 54, 43],
      [37.301, 55, 44],
      [38.978, 57, 46],
      [39.793, 58, 47],
      [39.816, 59, 47],
    ],
  ],
  [
    'FS Source Serif Pro',
    LATIN,
    [
      [10.349, 12, 9],
      [10.448, 13, 10],
      [11.438, 14, 10],
      [12.528, 15, 11],
      [13.433, 16, 12],
      [13.617, 17, 12],
      [14.706, 18, 13],
      [15.796, 19, 14],
      [16.418, 20, 15],
      [16.885, 21, 15],
      [17.974, 22, 16],
      [19.064, 23, 17],
      [19.403, 24, 18],
      [20.153, 25, 18],
      [21.242, 26, 19],
      [22.332, 27, 20],
      [22.389, 28, 21],
      [23.421, 29, 21],
      [25.374, 31, 23],
      [26.689, 33, 24],
      [27.778, 34, 25],
      [28.359, 35, 26],
      [28.868, 36, 26],
      [29.957, 37, 27],
      [31.046, 38, 28],
      [31.344, 39, 29],
      [32.136, 40, 29],
      [33.225, 41, 30],
      [34.314, 42, 31],
      [34.329, 43, 32],
      [35.404, 44, 32],
      [36.493, 45, 33],
      [37.314, 46, 34],
      [37.582, 47, 34],
      [38.672, 48, 35],
      [39.761, 49, 36],
    ],
  ],
  [
    'FS Noto Devanagari',
    DEVANAGARI,
    [
      [8.371, 10, 7],
      [8.579, 11, 8],
      [9.487, 12, 8],
      [10.603, 13, 9],
      [11.719, 15, 10],
      [12.835, 16, 11],
      [13.481, 17, 12],
      [13.951, 18, 12],
      [15.067, 19, 13],
      [15.932, 20, 14],
      [16.184, 21, 14],
      [18.383, 23, 16],
      [18.416, 24, 16],
      [19.532, 25, 17],
      [20.648, 26, 18],
      [20.834, 27, 19],
      [21.764, 28, 19],
      [23.285, 30, 21],
      [23.996, 31, 21],
      [25.112, 32, 22],
      [25.736, 33, 23],
      [26.228, 34, 23],
      [27.344, 35, 24],
      [28.187, 36, 25],
      [29.576, 38, 26],
      [30.638, 39, 27],
      [30.692, 40, 27],
      [31.809, 41, 28],
      [32.925, 42, 29],
      [33.089, 43, 30],
      [34.041, 44, 30],
      [35.157, 45, 31],
      [36.273, 47, 32],
      [37.389, 48, 33],
      [38.505, 50, 34],
      [39.621, 51, 35],
    ],
  ],
]

test("a paragraph's normal line height and baseline are Chrome's at sizes the floor changes them", (t) => {
  let cases = 0
  for (const [family, text, rows] of CHROME_FLOORED) {
    for (const [size, lineHeight, baseline] of rows) {
      const layout = layOut(text, family, size)
      t.is(layout.lineHeight, lineHeight, `${family} ${size}px line height`)
      t.is(layout.lines[0].baseline, baseline, `${family} ${size}px baseline`)
      cases++
    }
  }
  t.is(cases, 188)
})

// Chrome's measureText widths are the same from 17.29 to 17.3, and so are
// its paragraphs' (78.7732 for DEVANAGARI in Noto Sans Devanagari, 272.3864
// for LATIN in Lato), and 13.333 is 13.33. The fork's differ from Chrome's
// by Skia's FreeType size, the floored size to the nearest 1/64px (below).
test('a paragraph and geometricPrecision text are as wide at 17.3px as at 17.29px', (t) => {
  for (const [family, text] of [
    ['FS Noto Devanagari', DEVANAGARI],
    ['FS Lato', LATIN],
  ]) {
    const floored = layOut(text, family, 17.29).lines[0].width
    const measured = measure(text, family, 17.29, 'geometricPrecision')
    for (const size of [17.295, 17.299, 17.3]) {
      t.is(layOut(text, family, size).lines[0].width, floored, `${family} paragraph at ${size}px`)
      t.is(measure(text, family, size, 'geometricPrecision'), measured, `${family} measureText at ${size}px`)
    }
    t.true(layOut(text, family, 17.31).lines[0].width > floored)
    t.true(measure(text, family, 17.31, 'geometricPrecision') > measured)
    t.is(layOut(text, family, 13.333).lines[0].width, layOut(text, family, 13.33).lines[0].width)
  }
})

// Chrome's measureText widths at fractional sizes (Chrome 154, macOS, a
// fresh FontFace per size), which CoreText lays out at the floored size
// exactly. Skia's FreeType takes sizes in 1/64px, so the fork lays the glyphs
// out at the floored size to the nearest 1/64px: within 0.06px of Chrome
// here, where the size truncated to 1/64px was 0.16 to 0.21px off.
const CHROME_WIDTHS: Array<[string, string, number, number]> = [
  ['FS Lato', LATIN, 14.7, 231.5835],
  ['FS Lato', LATIN, 17.31, 272.7015],
  ['FS Oswald', LATIN, 14.7, 191.1291],
  ['FS Oswald', LATIN, 17.31, 225.0644],
  ['FS Noto Devanagari', DEVANAGARI, 17.31, 78.8643],
]

test("a paragraph's widths at fractional sizes are near Chrome's", (t) => {
  for (const [family, text, size, width] of CHROME_WIDTHS) {
    near(t, layOut(text, family, size).lines[0].width, width, 0.06)
    near(t, measure(text, family, size, 'geometricPrecision'), width, 0.06)
  }
})

test('other textRendering values keep the exact font size', (t) => {
  // 17.299 is 17.296875 to FreeType, 17.29 is 17.28125.
  t.not(measure(LATIN, 'FS Lato', 17.299, 'auto'), measure(LATIN, 'FS Lato', 17.29, 'auto'))
})

test('a font size that floors to 0 keeps its size', (t) => {
  const layout = layOut(LATIN, 'FS Lato', 0.005)
  t.true(Number.isFinite(layout.lineHeight))
  t.true(Number.isFinite(layout.lines[0].width))
})
