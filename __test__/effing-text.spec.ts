import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, createCanvas, type SKRSContext2D } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type TextRendering = SKRSContext2D['textRendering']

test.before((t) => {
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf')))
})

// Draws the text at (x, y) on a canvas scaled by `scale` and returns the
// ink's coverage-weighted centre, in user space.
function inkCentroid(textRendering: TextRendering, scale: number, x: number, y: number) {
  const width = 200 * scale
  const height = 60 * scale
  const ctx = createCanvas(width, height).getContext('2d')
  ctx.scale(scale, scale)
  ctx.font = '24px Iosevka Slab'
  ctx.textRendering = textRendering
  ctx.fillStyle = 'black'
  ctx.fillText('Hello Canvas', x, y)
  const { data } = ctx.getImageData(0, 0, width, height)
  let sum = 0
  let sumX = 0
  let sumY = 0
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const alpha = data[(row * width + col) * 4 + 3]
      sum += alpha
      sumX += alpha * (col + 0.5)
      sumY += alpha * (row + 0.5)
    }
  }
  return { x: sumX / sum / scale, y: sumY / sum / scale }
}

test('geometricPrecision text keeps color glyphs in color', (t) => {
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'COLR-v1.ttf'), 'Colrv1'))
  const ctx = createCanvas(300, 150).getContext('2d')
  ctx.font = '100px Colrv1'
  ctx.textRendering = 'geometricPrecision'
  ctx.fillStyle = 'black'
  ctx.fillText('abc', 20, 110)
  const { data } = ctx.getImageData(0, 0, 300, 150)
  let colored = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0 && (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2])) colored++
  }
  t.true(colored > 100, `${colored} colored pixels`)
})

test('geometricPrecision text follows sub-pixel positions', (t) => {
  const a = inkCentroid('geometricPrecision', 1, 10.29, 40.1)
  const b = inkCentroid('geometricPrecision', 1, 10.29, 40.6)
  t.true(Math.abs(b.y - a.y - 0.5) < 0.1, `a 0.5px shift moved the ink by ${b.y - a.y}`)
})

test('auto text snaps its baseline to the pixel grid', (t) => {
  // The control for the test above: the baseline lands on a pixel row, so
  // the ink moves by a whole pixel or not at all.
  const a = inkCentroid('auto', 1, 10.29, 40.1)
  const b = inkCentroid('auto', 1, 10.29, 40.6)
  t.true(Math.abs(b.y - a.y - 0.5) > 0.4, `a 0.5px shift moved the ink by ${b.y - a.y}`)
})

test('geometricPrecision text lands in the same place at any scale', (t) => {
  const at1x = inkCentroid('geometricPrecision', 1, 10.29, 40.37)
  for (const scale of [2, 3, 4]) {
    const scaled = inkCentroid('geometricPrecision', scale, 10.29, 40.37)
    t.true(Math.abs(scaled.x - at1x.x) < 0.15, `x moved ${at1x.x} -> ${scaled.x} at ${scale}x`)
    t.true(Math.abs(scaled.y - at1x.y) < 0.15, `y moved ${at1x.y} -> ${scaled.y} at ${scale}x`)
  }
})

// What one fillText and measureText of the same text give, to compare whole.
function drawAndMeasure(textRendering: TextRendering, fontFamily: string) {
  const ctx = createCanvas(240, 60).getContext('2d')
  ctx.font = `17px ${fontFamily}`
  ctx.textRendering = textRendering
  ctx.fillStyle = 'black'
  ctx.fillText('Hello fjord 123', 10.3, 30.4)
  const metrics = ctx.measureText('Hello fjord 123')
  return {
    pixels: createHash('sha1')
      .update(ctx.getImageData(0, 0, 240, 60).data)
      .digest('hex'),
    width: metrics.width,
    box: [
      metrics.actualBoundingBoxLeft,
      metrics.actualBoundingBoxRight,
      metrics.actualBoundingBoxAscent,
      metrics.actualBoundingBoxDescent,
    ],
  }
}

test('text under one textRendering is not affected by the same text under another', (t) => {
  // Skia caches shaped text per text and style. One font under two names is
  // two cache entries for the same rendering, so each mode can be drawn both
  // first and after the other mode has put the text in the cache.
  const font = join(__dirname, 'fonts', 'Lato-Regular.ttf')
  t.truthy(GlobalFonts.registerFromPath(font, 'Lato First'))
  t.truthy(GlobalFonts.registerFromPath(font, 'Lato Second'))
  const hinted = drawAndMeasure('auto', 'Lato First')
  const unhinted = drawAndMeasure('geometricPrecision', 'Lato Second')
  t.notDeepEqual(unhinted, hinted)
  t.deepEqual(drawAndMeasure('geometricPrecision', 'Lato First'), unhinted)
  t.deepEqual(drawAndMeasure('auto', 'Lato Second'), hinted)
})
