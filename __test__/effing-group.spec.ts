import test from 'ava'

import { SvgExportFlag, createCanvas, type SKRSContext2D } from '../index'
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

test('a filter takes in what is drawn past the clip', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.rect(0, 0, 50, 100)
  ctx.clip()
  beginGroup(ctx, { filter: 'drop-shadow(-20px 0 0 red)' })
  ctx.fillRect(60, 0, 20, 100)
  endGroup(ctx)
  // The shadow of the clipped-out rect falls inside the clip.
  t.deepEqual(pixel(ctx, 45, 50), [255, 0, 0, 255])
  t.is(pixel(ctx, 35, 50)[3], 0)
})

test('a filter takes in what is drawn past the canvas edge', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  beginGroup(ctx, { filter: 'drop-shadow(-20px 0 0 red)' })
  ctx.fillRect(110, 0, 20, 100)
  endGroup(ctx)
  t.deepEqual(pixel(ctx, 95, 50), [255, 0, 0, 255])
})

test('a blend mode that changes what is behind the group where it draws nothing applies to the whole canvas', (t) => {
  for (const blendMode of ['copy', 'destination-in'] as const) {
    const ctx = createCanvas(100, 100).getContext('2d')
    ctx.fillStyle = 'red'
    ctx.fillRect(0, 0, 100, 100)
    beginGroup(ctx, { blendMode })
    ctx.fillStyle = 'blue'
    ctx.fillRect(10, 10, 20, 20)
    endGroup(ctx)
    t.is(pixel(ctx, 75, 75)[3], 0, blendMode)
  }
})

test('a group holding more than the recording limit is composited whole', (t) => {
  // 2900 x 2900 x 4 bytes is past the 32 MiB the deferred recording holds
  // before it is flushed.
  const source = createCanvas(2900, 2900)
  const sourceCtx = source.getContext('2d')
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(0, 0, 2900, 2900)
  const ctx = createCanvas(64, 64).getContext('2d')
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 64, 64)
  beginGroup(ctx, { opacity: 0.5 })
  ctx.drawImage(source, 0, 0, 64, 64)
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 64, 64)
  endGroup(ctx)
  // The blue hides the red within the group: half blue over white.
  const [r, g, b] = pixel(ctx, 32, 32)
  t.true(Math.abs(r - 127) <= 1 && Math.abs(g - 127) <= 1 && b === 255, `rgb ${r},${g},${b}`)
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

test('a non-numeric opacity and malformed bounds throw', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  t.throws(() => beginGroup(ctx, { opacity: NaN }), { message: /opacity/ })
  const three = [0, 0, 5] as unknown as [number, number, number, number]
  t.throws(() => beginGroup(ctx, { bounds: three }), { message: /bounds/ })
  t.throws(() => beginGroup(ctx, { bounds: [0, 0, 5, Infinity] }), { message: /bounds/ })
  // Out of range is clamped, as an alpha is.
  ctx.fillStyle = 'black'
  beginGroup(ctx, { opacity: 2 })
  ctx.fillRect(0, 0, 10, 10)
  endGroup(ctx)
  t.is(pixel(ctx, 5, 5)[3], 255)
})

test('a group that composites nothing is a plain save on an SVG canvas', (t) => {
  // SkSVGDevice has no layers, so a group only works there without one.
  const canvas = createCanvas(50, 50, SvgExportFlag.NoPrettyXML)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'red'
  beginGroup(ctx, { bounds: [0, 0, 20, 20] })
  ctx.fillRect(5, 5, 10, 10)
  endGroup(ctx)
  t.regex(canvas.getContent().toString(), /<rect fill="red"/)
})

test('a group that composites throws on an SVG canvas', (t) => {
  const ctx = createCanvas(50, 50, SvgExportFlag.NoPrettyXML).getContext('2d')
  for (const options of [
    { opacity: 0.5 },
    { blendMode: 'multiply' },
    { filter: 'blur(2px)' },
    { backdropFilter: 'blur(2px)' },
  ]) {
    t.throws(() => beginGroup(ctx, options), { message: /SVG/ })
  }
  // And left the context usable, outside any group.
  t.throws(() => endGroup(ctx), { message: /beginGroup/ })
})
