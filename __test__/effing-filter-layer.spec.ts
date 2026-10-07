import test from 'ava'

import { createCanvas, type SKRSContext2D } from '../index'
import { beginGroup, endGroup } from '../extensions'

// `ctx.filter` and image-filter shadows draw through a layer the size of what
// the draw paints (src/ctx/effing/filter_layer.rs). These pin what that layer
// must still do as the canvas-sized one did.

function pixels(ctx: SKRSContext2D, x: number, y: number, width: number, height: number) {
  return Array.from(ctx.getImageData(x, y, width, height).data)
}

for (const [group, copy] of [
  [false, false],
  [true, false],
  [false, true],
]) {
  const where = group ? ' in a group' : copy ? " under 'copy'" : ''

  test(`a blur takes in what is drawn past the clip${where}`, (t) => {
    const draw = (clip: boolean) => {
      const ctx = createCanvas(100, 100).getContext('2d')
      // A group records its draws on their own (src/page_recorder/effing.rs).
      if (group) beginGroup(ctx, { opacity: 0.5 })
      // `copy` draws through an isolation layer of its own (`render_canvas`),
      // whose recording the filter layer is opened in.
      if (copy) ctx.globalCompositeOperation = 'copy'
      if (clip) {
        ctx.beginPath()
        ctx.rect(0, 40, 100, 60)
        ctx.clip()
      }
      ctx.filter = 'blur(8px)'
      // Ends 10px above the clip.
      ctx.fillRect(20, 10, 60, 20)
      if (group) endGroup(ctx)
      return ctx
    }
    const clipped = pixels(draw(true), 0, 40, 100, 60)
    t.true(clipped.some((value) => value > 0))
    t.deepEqual(clipped, pixels(draw(false), 0, 40, 100, 60))
  })

  if (copy) continue

  test(`a drop shadow is cast into the clip by a draw outside it${where}`, (t) => {
    const ctx = createCanvas(100, 100).getContext('2d')
    if (group) beginGroup(ctx, { opacity: 0.5 })
    ctx.beginPath()
    ctx.rect(0, 50, 100, 50)
    ctx.clip()
    ctx.filter = 'drop-shadow(0px 40px 0px blue)'
    ctx.fillStyle = 'red'
    ctx.fillRect(20, 10, 60, 20)
    if (group) endGroup(ctx)
    t.deepEqual(pixels(ctx, 50, 60, 1, 1), [0, 0, 255, group ? 128 : 255])
    t.deepEqual(pixels(ctx, 50, 20, 1, 1), [0, 0, 0, 0])
  })
}

test('a filtered draw whose mode changes what it leaves transparent covers the clip', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 100, 100)
  // Clears everything the layer covers, transparent or not.
  ctx.globalCompositeOperation = 'clear'
  ctx.filter = 'blur(2px)'
  ctx.fillRect(10, 10, 10, 10)
  t.deepEqual(pixels(ctx, 90, 90, 1, 1), [0, 0, 0, 0])
})

test('a filtered draw under a singular transform draws nothing', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.scale(0, 0)
  ctx.filter = 'blur(4px)'
  t.notThrows(() => {
    ctx.fillRect(10, 10, 50, 50)
    ctx.fillText('text', 10, 50)
  })
  t.true(pixels(ctx, 0, 0, 100, 100).every((value) => value === 0))
})
