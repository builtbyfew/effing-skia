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
