import test from 'ava'

import { createCanvas, type SKRSContext2D } from '../index'

function pixel(ctx: SKRSContext2D, x: number, y: number) {
  return Array.from(ctx.getImageData(x, y, 1, 1).data)
}

test('a group composites overlapping draws once', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.fillStyle = 'black'
  ctx.beginGroup({ opacity: 0.5 })
  ctx.fillRect(0, 0, 60, 100)
  ctx.fillRect(40, 0, 60, 100)
  ctx.endGroup()
  // The overlap is as translucent as the rest, unlike per-draw globalAlpha.
  t.deepEqual(pixel(ctx, 50, 50), pixel(ctx, 10, 50))
  t.is(pixel(ctx, 50, 50)[3], 128)
})

test('a group without options is a plain save/restore', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.fillStyle = 'red'
  ctx.beginGroup()
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 10, 10)
  ctx.endGroup()
  t.deepEqual(pixel(ctx, 5, 5), [0, 0, 255, 255])
  // The state is restored.
  ctx.fillRect(0, 0, 10, 10)
  t.deepEqual(pixel(ctx, 5, 5), [255, 0, 0, 255])
})

test('blendMode blends the whole group with what is behind it', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.fillStyle = 'rgb(0, 255, 255)'
  ctx.fillRect(0, 0, 10, 10)
  ctx.beginGroup({ blendMode: 'multiply' })
  ctx.fillStyle = 'rgb(255, 0, 0)'
  ctx.fillRect(0, 0, 10, 10)
  ctx.endGroup()
  t.deepEqual(pixel(ctx, 5, 5), [0, 0, 0, 255])
})

test('filter applies to the group as a whole', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.fillStyle = 'black'
  ctx.beginGroup({ filter: 'blur(4px)' })
  ctx.fillRect(20, 20, 40, 40)
  ctx.endGroup()
  // Blur bleeds past the rect's edge.
  const outside = pixel(ctx, 63, 40)[3]
  t.true(outside > 0 && outside < 255, `edge alpha ${outside}`)
})

test('backdropFilter starts the group from the filtered backdrop', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.fillStyle = 'black'
  ctx.fillRect(0, 0, 50, 100)
  ctx.beginGroup({ backdropFilter: 'blur(6px)', bounds: [0, 0, 100, 100] })
  ctx.endGroup()
  // The hard edge at x = 50 is now a gradient.
  const near = pixel(ctx, 53, 50)[3]
  t.true(near > 0 && near < 255, `edge alpha ${near}`)
})

test('bounds clip the group', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.fillStyle = 'black'
  ctx.beginGroup({ bounds: [0, 0, 50, 50] })
  ctx.fillRect(0, 0, 100, 100)
  ctx.endGroup()
  t.is(pixel(ctx, 25, 25)[3], 255)
  t.is(pixel(ctx, 75, 75)[3], 0)
})

test('groups nest', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.fillStyle = 'black'
  ctx.beginGroup({ opacity: 0.5 })
  ctx.beginGroup({ opacity: 0.5 })
  ctx.fillRect(0, 0, 10, 10)
  ctx.endGroup()
  ctx.endGroup()
  t.is(pixel(ctx, 5, 5)[3], 64)
})

test('endGroup without a matching beginGroup throws', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  t.throws(() => ctx.endGroup(), { message: /beginGroup/ })
  ctx.save()
  t.throws(() => ctx.endGroup(), { message: /beginGroup/ })
  ctx.restore()
  ctx.beginGroup()
  ctx.save()
  t.throws(() => ctx.endGroup(), { message: /beginGroup/ })
  ctx.restore()
  t.notThrows(() => ctx.endGroup())
})

test('restore closes a group too', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.fillStyle = 'black'
  ctx.beginGroup({ opacity: 0.5 })
  ctx.fillRect(0, 0, 10, 10)
  ctx.restore()
  t.is(pixel(ctx, 5, 5)[3], 128)
  t.throws(() => ctx.endGroup(), { message: /beginGroup/ })
})

test('an invalid blendMode throws', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  t.throws(() => ctx.beginGroup({ blendMode: 'nope' }))
})
