import test from 'ava'

import { createCanvas, type SKRSContext2D } from '../index'
import { beginGroup, endGroup } from '../extensions'

// `drop-shadow(dx dy r color)` in a CSS filter blurs with a standard deviation
// of r, as `blur(r)` does (Filter Effects 1, and Chrome, which draws
// `drop-shadow(0 0 4px)` exactly like `blur(4px)`). It used to blur with r / 2,
// the `shadowBlur` rule. https://github.com/builtbyfew/effing-skia/issues/39

const SIZE = 200

// On white, so that the comparison is of what shows rather than of the
// unpremultiplied colour of nearly transparent pixels.
function canvas(setup?: Setup) {
  const ctx = createCanvas(SIZE, SIZE).getContext('2d')
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, SIZE, SIZE)
  setup?.(ctx)
  return ctx
}

function pixels(ctx: SKRSContext2D) {
  return ctx.getImageData(0, 0, SIZE, SIZE).data
}

function maxDifference(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let max = 0
  for (let i = 0; i < a.length; i++) {
    max = Math.max(max, Math.abs(a[i] - b[i]))
  }
  return max
}

type Setup = (ctx: SKRSContext2D) => void

// The shape under `drop-shadow(dx dy r color)`.
function dropShadow(dx: number, dy: number, r: number, color: string, setup?: Setup) {
  const ctx = canvas(setup)
  ctx.filter = `drop-shadow(${dx}px ${dy}px ${r}px ${color})`
  ctx.fillStyle = '#3070d0'
  ctx.fillRect(70, 70, 40, 30)
  return ctx
}

// The same, built by hand: the shape in the shadow colour under `blur(r)`,
// offset by (dx, dy) in device pixels, then the shape itself.
function blurredShape(dx: number, dy: number, r: number, color: string, setup?: Setup) {
  const ctx = canvas(setup)
  const transform = ctx.getTransform()
  ctx.setTransform(1, 0, 0, 1, dx, dy)
  ctx.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f)
  ctx.filter = `blur(${r}px)`
  ctx.fillStyle = color
  ctx.fillRect(70, 70, 40, 30)
  ctx.setTransform(transform)
  ctx.filter = 'none'
  ctx.fillStyle = '#3070d0'
  ctx.fillRect(70, 70, 40, 30)
  return ctx
}

const CASES: [number, number, number, string][] = [
  [0, 0, 4, 'black'],
  [0, 0, 12, 'black'],
  [6, 8, 12, 'rgba(0, 0, 0, 0.6)'],
  [-5, 3, 8, 'red'],
  [10, 10, 2, 'green'],
]

const TRANSFORMS: [string, Setup | undefined][] = [
  ['', undefined],
  [' under a scale', (ctx) => ctx.scale(1.5, 1.5)],
  [' under a rotation', (ctx) => ctx.rotate(0.2)],
]

for (const [dx, dy, r, color] of CASES) {
  for (const [where, setup] of TRANSFORMS) {
    test(`drop-shadow(${dx}px ${dy}px ${r}px ${color}) blurs like blur(${r}px)${where}`, (t) => {
      const expected = pixels(blurredShape(dx, dy, r, color, setup))
      const actual = pixels(dropShadow(dx, dy, r, color, setup))
      // Both go through the same Gaussian; the layers they draw into start in
      // different places, which moves the rounding by up to 4 levels under a
      // rotation (docs/effing.md, filtered draws; 3 on x64).
      t.true(maxDifference(actual, expected) <= 4, `max difference ${maxDifference(actual, expected)}`)
      // With r / 2 the shadow is visibly tighter.
      const halved = pixels(dropShadow(dx, dy, r / 2, color, setup))
      t.true(maxDifference(halved, expected) > 8)
    })
  }
}

// The layer a filtered draw goes through is sized from the filter's reach
// (src/ctx/effing/filter_layer.rs); it has to take in the whole, wider halo.
test('the filter layer takes in the whole drop-shadow halo', (t) => {
  const ctx = createCanvas(SIZE, SIZE).getContext('2d')
  ctx.filter = 'drop-shadow(0 0 10px black)'
  ctx.fillRect(95, 95, 10, 10)
  const alpha = (x: number) => ctx.getImageData(x, 100, 1, 1).data[3]
  // 1.5 standard deviations past the edge; 3 with r / 2, where Skia stops.
  t.true(alpha(120) > 0, `alpha ${alpha(120)}`)
  // Skia stops the Gaussian at 3 standard deviations.
  t.is(alpha(150), 0)
})

test('a group drop-shadow blurs like ctx.filter', (t) => {
  const group = canvas()
  beginGroup(group, { filter: 'drop-shadow(6px 8px 12px black)' })
  group.fillStyle = '#3070d0'
  group.fillRect(70, 70, 40, 30)
  endGroup(group)
  const expected = pixels(dropShadow(6, 8, 12, 'black'))
  const actual = pixels(group)
  t.true(maxDifference(actual, expected) <= 2, `max difference ${maxDifference(actual, expected)}`)
})

// `shadowBlur` is not a standard deviation: the canvas spec halves it.
test('shadowBlur still blurs with half its value', (t) => {
  const ctx = canvas()
  ctx.shadowColor = 'black'
  ctx.shadowBlur = 16
  ctx.shadowOffsetX = 6
  ctx.shadowOffsetY = 8
  ctx.fillStyle = '#3070d0'
  ctx.fillRect(70, 70, 40, 30)
  const expected = pixels(dropShadow(6, 8, 8, 'black'))
  const actual = pixels(ctx)
  t.true(maxDifference(actual, expected) <= 2, `max difference ${maxDifference(actual, expected)}`)
})
