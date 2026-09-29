import test from 'ava'

import { createCanvas, type SKRSContext2D } from '../index'
import { beginGroup, endGroup } from '../extensions'

function pixel(ctx: SKRSContext2D, x: number, y: number) {
  return Array.from(ctx.getImageData(x, y, 1, 1).data)
}

test('a group composites overlapping draws once', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.fillStyle = 'black'
  beginGroup(ctx, { opacity: 0.5 })
  ctx.fillRect(0, 0, 60, 100)
  ctx.fillRect(40, 0, 60, 100)
  endGroup(ctx)
  // The overlap is as translucent as the rest, unlike per-draw globalAlpha.
  t.deepEqual(pixel(ctx, 50, 50), pixel(ctx, 10, 50))
  t.is(pixel(ctx, 50, 50)[3], 128)
})

test('a group without options is a plain save/restore', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.fillStyle = 'red'
  beginGroup(ctx)
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 10, 10)
  endGroup(ctx)
  t.deepEqual(pixel(ctx, 5, 5), [0, 0, 255, 255])
  // The state is restored.
  ctx.fillRect(0, 0, 10, 10)
  t.deepEqual(pixel(ctx, 5, 5), [255, 0, 0, 255])
})

test('blendMode blends the whole group with what is behind it', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.fillStyle = 'rgb(0, 255, 255)'
  ctx.fillRect(0, 0, 10, 10)
  beginGroup(ctx, { blendMode: 'multiply' })
  ctx.fillStyle = 'rgb(255, 0, 0)'
  ctx.fillRect(0, 0, 10, 10)
  endGroup(ctx)
  t.deepEqual(pixel(ctx, 5, 5), [0, 0, 0, 255])
})

test('filter applies to the group as a whole', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.fillStyle = 'black'
  beginGroup(ctx, { filter: 'blur(4px)' })
  ctx.fillRect(20, 20, 40, 40)
  endGroup(ctx)
  // Blur bleeds past the rect's edge.
  const outside = pixel(ctx, 63, 40)[3]
  t.true(outside > 0 && outside < 255, `edge alpha ${outside}`)
})

test('backdropFilter starts the group from the filtered backdrop', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.fillStyle = 'black'
  ctx.fillRect(0, 0, 50, 100)
  beginGroup(ctx, { backdropFilter: 'blur(6px)', bounds: [0, 0, 100, 100] })
  endGroup(ctx)
  // The hard edge at x = 50 is now a gradient.
  const near = pixel(ctx, 53, 50)[3]
  t.true(near > 0 && near < 255, `edge alpha ${near}`)
})

test('bounds clip the group', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.fillStyle = 'black'
  beginGroup(ctx, { bounds: [0, 0, 50, 50] })
  ctx.fillRect(0, 0, 100, 100)
  endGroup(ctx)
  t.is(pixel(ctx, 25, 25)[3], 255)
  t.is(pixel(ctx, 75, 75)[3], 0)
})

test("reading the canvas mid-group keeps the group's options", (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.fillStyle = 'black'
  beginGroup(ctx, { opacity: 0.5, bounds: [0, 0, 100, 50] })
  ctx.fillRect(0, 0, 50, 100)
  t.is(pixel(ctx, 25, 25)[3], 128)
  ctx.fillRect(50, 0, 50, 100)
  endGroup(ctx)
  t.is(pixel(ctx, 25, 25)[3], 128)
  t.is(pixel(ctx, 75, 25)[3], 128)
  t.is(pixel(ctx, 75, 75)[3], 0)
  // The state after the group is the one before it.
  ctx.fillRect(0, 0, 100, 100)
  t.is(pixel(ctx, 75, 75)[3], 255)
})

test('reading the canvas mid-group keeps the clip around the group', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.fillStyle = 'black'
  ctx.rect(0, 0, 50, 50)
  ctx.clip()
  beginGroup(ctx, { filter: 'blur(10px)' })
  ctx.fillRect(0, 0, 50, 50)
  ctx.getImageData(0, 0, 1, 1)
  ctx.fillRect(0, 0, 50, 50)
  endGroup(ctx)
  // The rest of the group is composited inside the clip set before it, so
  // the blur doesn't bleed past it.
  t.true(pixel(ctx, 25, 25)[3] > 0)
  t.is(pixel(ctx, 55, 25)[3], 0)
  t.is(pixel(ctx, 25, 55)[3], 0)
})

test('groups nest', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.fillStyle = 'black'
  beginGroup(ctx, { opacity: 0.5 })
  beginGroup(ctx, { opacity: 0.5 })
  ctx.fillRect(0, 0, 10, 10)
  endGroup(ctx)
  endGroup(ctx)
  t.is(pixel(ctx, 5, 5)[3], 64)
})

test('endGroup without a matching beginGroup throws', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  t.throws(() => endGroup(ctx), { message: /beginGroup/ })
  ctx.save()
  t.throws(() => endGroup(ctx), { message: /beginGroup/ })
  ctx.restore()
  beginGroup(ctx)
  ctx.save()
  t.throws(() => endGroup(ctx), { message: /beginGroup/ })
  ctx.restore()
  t.notThrows(() => endGroup(ctx))
})

test('restore closes a group too', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.fillStyle = 'black'
  beginGroup(ctx, { opacity: 0.5 })
  ctx.fillRect(0, 0, 10, 10)
  ctx.restore()
  t.is(pixel(ctx, 5, 5)[3], 128)
  t.throws(() => endGroup(ctx), { message: /beginGroup/ })
})

test('an invalid blendMode throws', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  t.throws(() => beginGroup(ctx, { blendMode: 'nope' }))
})
