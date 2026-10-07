import test from 'ava'

import { createCanvas, type SKRSContext2D } from '../index'
import { beginGroup, endGroup } from '../extensions'

// `ctx.filter`'s `blur()` and `drop-shadow()`, and a drawn image's shadow,
// blur as Chrome's software canvas does. Chromium builds Skia with
// SK_AVOID_SLOW_RASTER_PIPELINE_BLURS, which blurs with three boxes at every
// sigma, where Skia's default is a Gaussian kernel below sigma 2: below 2,
// the fork used to be up to 172 levels off. A sigma under about 0.8 has boxes
// of one pixel, so it doesn't blur at all, and 1.5 and 1.75 have the same
// boxes. https://github.com/builtbyfew/effing-skia/issues/45
//
// The expected values are Chrome 154's (headless, macOS arm64), from a canvas
// with `willReadFrequently: true`, which Chrome draws in software: the red
// channel along a row and a column across an edge, on white.

const SIZE = 200

interface Case {
  filter?: string
  rotate?: number
  shadowBlur?: number
  image?: boolean
  // [y, x0, x1) and [x, y0, y1)
  row: [number, number, number]
  column: [number, number, number]
  chromeRow: number[]
  chromeColumn: number[]
}

function draw(c: Case) {
  const ctx = createCanvas(SIZE, SIZE).getContext('2d')
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, SIZE, SIZE)
  if (c.rotate) {
    ctx.translate(100, 100)
    ctx.rotate(c.rotate)
    ctx.translate(-100, -100)
  }
  if (c.filter) {
    ctx.filter = c.filter
  }
  if (c.shadowBlur) {
    ctx.shadowBlur = c.shadowBlur
    ctx.shadowColor = 'black'
    ctx.shadowOffsetX = 10
    ctx.shadowOffsetY = 10
  }
  if (c.image) {
    // A translucent image, whose shadow Chrome casts through an image filter.
    const image = createCanvas(80, 80)
    const imageCtx = image.getContext('2d')
    imageCtx.fillStyle = 'rgba(48, 112, 208, 0.8)'
    imageCtx.fillRect(10, 10, 60, 50)
    ctx.drawImage(image, 30, 30)
  } else {
    ctx.fillStyle = '#3070d0'
    ctx.fillRect(40, 40, 60, 50)
  }
  return ctx
}

function sample(ctx: SKRSContext2D, c: Case) {
  const data = ctx.getImageData(0, 0, SIZE, SIZE).data
  const [y, x0, x1] = c.row
  const [x, y0, y1] = c.column
  const row: number[] = []
  const column: number[] = []
  for (let i = x0; i < x1; i++) row.push(data[(y * SIZE + i) * 4])
  for (let i = y0; i < y1; i++) column.push(data[(i * SIZE + x) * 4])
  return { row, column }
}

const EDGE: Pick<Case, 'row' | 'column'> = { row: [60, 33, 48], column: [60, 33, 48] }
const ROTATED: Pick<Case, 'row' | 'column'> = { row: [70, 28, 46], column: [70, 22, 40] }

const NONE = [255, 255, 255, 255, 255, 255, 255, 48, 48, 48, 48, 48, 48, 48, 48]
const SIGMA_1 = [255, 255, 255, 255, 255, 238, 186, 117, 65, 48, 48, 48, 48, 48, 48]
const SIGMA_1_5 = [255, 255, 255, 255, 248, 224, 179, 124, 79, 55, 48, 48, 48, 48, 48]
const SIGMA_2 = [255, 255, 253, 244, 229, 203, 170, 133, 100, 74, 59, 50, 48, 48, 48]
const SIGMA_2_5 = [255, 253, 249, 239, 222, 197, 167, 136, 106, 81, 64, 54, 50, 48, 48]

const CASES: [string, Case][] = [
  ['blur(0.5px) draws unblurred', { filter: 'blur(0.5px)', ...EDGE, chromeRow: NONE, chromeColumn: NONE }],
  ['blur(1px)', { filter: 'blur(1px)', ...EDGE, chromeRow: SIGMA_1, chromeColumn: SIGMA_1 }],
  ['blur(1.5px)', { filter: 'blur(1.5px)', ...EDGE, chromeRow: SIGMA_1_5, chromeColumn: SIGMA_1_5 }],
  [
    'blur(1.75px) draws as blur(1.5px)',
    { filter: 'blur(1.75px)', ...EDGE, chromeRow: SIGMA_1_5, chromeColumn: SIGMA_1_5 },
  ],
  ['blur(2px)', { filter: 'blur(2px)', ...EDGE, chromeRow: SIGMA_2, chromeColumn: SIGMA_2 }],
  ['blur(2.5px)', { filter: 'blur(2.5px)', ...EDGE, chromeRow: SIGMA_2_5, chromeColumn: SIGMA_2_5 }],
  [
    'blur(1px) under a rotation',
    {
      filter: 'blur(1px)',
      rotate: 0.2,
      ...ROTATED,
      chromeRow: [255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 250, 224, 169, 105],
      chromeColumn: [255, 255, 255, 255, 255, 255, 255, 255, 251, 226, 172, 107, 63, 49, 48, 48, 48, 48],
    },
  ],
  [
    'blur(2px) under a rotation',
    {
      filter: 'blur(2px)',
      rotate: 0.2,
      ...ROTATED,
      chromeRow: [255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 254, 250, 240, 222, 194, 160, 125],
      chromeColumn: [255, 255, 255, 255, 255, 254, 250, 240, 223, 196, 162, 127, 95, 71, 58, 50, 48, 48],
    },
  ],
  [
    'blur(1px) grayscale(1)',
    {
      filter: 'blur(1px) grayscale(1)',
      ...EDGE,
      chromeRow: [255, 255, 255, 255, 255, 243, 205, 155, 118, 105, 105, 105, 105, 105, 105],
      chromeColumn: [255, 255, 255, 255, 255, 243, 205, 155, 118, 105, 105, 105, 105, 105, 105],
    },
  ],
  [
    'drop-shadow(10px 10px 1px black)',
    {
      filter: 'drop-shadow(10px 10px 1px black)',
      row: [80, 95, 112],
      column: [80, 85, 102],
      chromeRow: [48, 48, 48, 48, 48, 0, 0, 0, 0, 0, 0, 0, 0, 21, 85, 170, 234],
      chromeColumn: [48, 48, 48, 48, 48, 0, 0, 0, 0, 0, 0, 0, 0, 21, 85, 170, 234],
    },
  ],
  [
    "a drawn image's shadowBlur 2",
    {
      shadowBlur: 2,
      image: true,
      row: [95, 102, 118],
      column: [105, 42, 58],
      chromeRow: [51, 51, 51, 51, 51, 51, 68, 119, 187, 238, 255, 255, 255, 255, 255, 255],
      chromeColumn: [255, 255, 255, 255, 255, 255, 238, 187, 119, 68, 51, 51, 51, 51, 51, 51],
    },
  ],
  [
    "a drawn image's shadowBlur 3",
    {
      shadowBlur: 3,
      image: true,
      row: [95, 102, 118],
      column: [105, 42, 58],
      chromeRow: [51, 51, 51, 51, 51, 59, 81, 127, 179, 225, 247, 255, 255, 255, 255, 255],
      chromeColumn: [255, 255, 255, 255, 255, 247, 225, 179, 127, 81, 59, 51, 51, 51, 51, 51],
    },
  ],
]

function maxDifference(a: number[], b: number[]) {
  return Math.max(...a.map((v, i) => Math.abs(v - b[i])))
}

for (const [name, c] of CASES) {
  test(`${name} blurs as Chrome's canvas does`, (t) => {
    const { row, column } = sample(draw(c), c)
    // One level for rounding that differs between CPUs; the Gaussian kernel
    // was at least two off in each of these.
    t.true(maxDifference(row, c.chromeRow) <= 1, `row ${JSON.stringify(row)}`)
    t.true(maxDifference(column, c.chromeColumn) <= 1, `column ${JSON.stringify(column)}`)
  })
}

test("a group's blur stays Skia's, which follows the group's transform", (t) => {
  // A group's filter is CSS's on an element, whose lengths scale with the
  // transform; the canvas blur's would not. blur(0.5px) still blurs.
  const ctx = createCanvas(SIZE, SIZE).getContext('2d')
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, SIZE, SIZE)
  beginGroup(ctx, { filter: 'blur(0.5px)' })
  ctx.fillStyle = '#3070d0'
  ctx.fillRect(40, 40, 60, 50)
  endGroup(ctx)
  const { row } = sample(ctx, { ...EDGE, chromeRow: [], chromeColumn: [] })
  t.true(maxDifference(row, NONE) > 1)
})
