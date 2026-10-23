import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, ImageData, createCanvas, loadImage, type Image, type SKRSContext2D } from '../index'
import { beginGroup, endGroup } from '../extensions'

// encode() on a canvas whose surface is still blank rasterises the recording
// on the encode pool instead of flushing it on the calling thread
// (docs/effing.md). Each test draws the same thing on two canvases, and
// checks that the async encode of one is the sync encode of the other.
const root = join(fileURLToPath(import.meta.url), '..')

let image: Image

test.before(async () => {
  GlobalFonts.registerFromPath(join(root, 'fonts', 'iosevka-slab-regular.ttf'), 'Async Raster Slab')
  image = await loadImage(readFileSync(join(root, 'fixtures', 'firefox-logo.png')))
})

function scene(ctx: SKRSContext2D) {
  const gradient = ctx.createLinearGradient(0, 0, 320, 200)
  gradient.addColorStop(0, '#1d3557')
  gradient.addColorStop(1, '#e63946')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 320, 200)
  ctx.globalAlpha = 0.8
  ctx.drawImage(image, 20, 20, 120, 120)
  ctx.globalAlpha = 1
  ctx.save()
  ctx.translate(160, 100)
  ctx.rotate(0.3)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(0, 0, 60, 0, Math.PI * 1.5)
  ctx.stroke()
  ctx.restore()
  beginGroup(ctx, { opacity: 0.5, filter: 'blur(2px)' })
  ctx.fillStyle = '#ffd166'
  ctx.fillRect(200, 40, 80, 80)
  endGroup(ctx)
  ctx.fillStyle = 'white'
  ctx.font = '28px "Async Raster Slab"'
  ctx.fillText('Off the JS thread', 24, 180)
}

function drawn(draw = scene) {
  const canvas = createCanvas(320, 200)
  draw(canvas.getContext('2d'))
  return canvas
}

test('an async encode of a fresh canvas is its sync encode', async (t) => {
  for (const [format, quality] of [['png'], ['jpeg', 90], ['webp', 80], ['gif'], ['qoi'], ['avif']] as const) {
    // @ts-expect-error -- overloads don't take a union of formats
    const encoded: Buffer = await drawn().encode(format, quality)
    // @ts-expect-error -- overloads don't take a union of formats
    t.true(encoded.equals(drawn().encodeSync(format, quality)), format)
  }
})

test('draws after encode() are not in the encode, and stay on the canvas', async (t) => {
  const canvas = drawn()
  const ctx = canvas.getContext('2d')
  const promise = canvas.encode('png')
  ctx.fillStyle = 'black'
  ctx.fillRect(0, 0, 40, 40)
  t.true((await promise).equals(drawn().encodeSync('png')))
  const reference = drawn((c) => {
    scene(c)
    c.fillStyle = 'black'
    c.fillRect(0, 0, 40, 40)
  })
  t.true(canvas.encodeSync('png').equals(reference.encodeSync('png')))
  t.deepEqual(ctx.getImageData(0, 0, 320, 200).data, reference.getContext('2d').getImageData(0, 0, 320, 200).data)
})

test('encoding the same canvas again, with and without more draws', async (t) => {
  const canvas = drawn()
  const ctx = canvas.getContext('2d')
  const first = await canvas.encode('png')
  t.true((await canvas.encode('png')).equals(first))
  ctx.fillStyle = 'black'
  ctx.fillRect(0, 0, 40, 40)
  const reference = drawn((c) => {
    scene(c)
    c.fillStyle = 'black'
    c.fillRect(0, 0, 40, 40)
  })
  t.true((await canvas.encode('png')).equals(reference.encodeSync('png')))
})

// putImageData splits the recording into layers, which a flush consolidates
// into a snapshot. An unchanged canvas takes the encoded image in their place
// when the encode resolves, and must go on to encode, draw and be drawn the
// same.
test('a canvas that takes the encoded image in place of its layers', async (t) => {
  const layered = (c: SKRSContext2D) => {
    scene(c)
    c.putImageData(new ImageData(new Uint8ClampedArray(16 * 16 * 4).fill(200), 16, 16), 280, 160)
    c.fillStyle = 'rgba(0, 128, 255, 0.5)'
    c.fillRect(250, 150, 50, 40)
  }
  const canvas = drawn(layered)
  const reference = drawn(layered)
  const encoded = reference.encodeSync('png') // flushes and consolidates
  t.true((await canvas.encode('png')).equals(encoded))
  t.true((await canvas.encode('png')).equals(encoded))
  const drawnInto = (source: ReturnType<typeof createCanvas>) => {
    const into = createCanvas(320, 200)
    into.getContext('2d').drawImage(source, 10, 10, 160, 100)
    return into.encodeSync('png')
  }
  t.true(drawnInto(canvas).equals(drawnInto(reference)))
  for (const c of [canvas, reference]) {
    c.getContext('2d').fillStyle = 'black'
    c.getContext('2d').fillRect(0, 0, 40, 40)
  }
  t.true((await canvas.encode('png')).equals(reference.encodeSync('png')))
  t.deepEqual(
    canvas.getContext('2d').getImageData(0, 0, 320, 200).data,
    reference.getContext('2d').getImageData(0, 0, 320, 200).data,
  )
})

test('a canvas reused frame after frame with a clear', async (t) => {
  const canvas = createCanvas(320, 200)
  const ctx = canvas.getContext('2d')
  for (let frame = 0; frame < 3; frame++) {
    ctx.clearRect(0, 0, 320, 200)
    const draw = (c: SKRSContext2D) => {
      scene(c)
      c.fillStyle = 'black'
      c.fillRect(frame * 50, 0, 40, 40)
    }
    draw(ctx)
    t.true((await canvas.encode('png')).equals(drawn(draw).encodeSync('png')), `frame ${frame}`)
  }
})

test('a canvas without alpha, and one drawn on after a read, encode what they hold', async (t) => {
  const opaque = createCanvas(320, 200)
  scene(opaque.getContext('2d', { alpha: false }))
  const opaqueReference = createCanvas(320, 200)
  scene(opaqueReference.getContext('2d', { alpha: false }))
  t.true((await opaque.encode('png')).equals(opaqueReference.encodeSync('png')))

  const read = drawn()
  read.getContext('2d').getImageData(0, 0, 1, 1)
  read.getContext('2d').fillRect(0, 0, 40, 40)
  const readReference = drawn((c) => {
    scene(c)
    c.fillRect(0, 0, 40, 40)
  })
  t.true((await read.encode('png')).equals(readReference.encodeSync('png')))
})

test('a source canvas changed after the encode stays as it was drawn', async (t) => {
  const source = drawn()
  const canvas = createCanvas(320, 200)
  canvas.getContext('2d').drawImage(source, 0, 0, 160, 100)
  const promise = canvas.encode('png')
  source.getContext('2d').clearRect(0, 0, 320, 200)
  const reference = createCanvas(320, 200)
  reference.getContext('2d').drawImage(drawn(), 0, 0, 160, 100)
  t.true((await promise).equals(reference.encodeSync('png')))
})

test('many canvases encoding at once each get their own pixels', async (t) => {
  const draw = (i: number) => (c: SKRSContext2D) => {
    scene(c)
    c.fillStyle = `rgb(${i * 8}, 0, 0)`
    c.fillRect(i * 4, 0, 20, 20)
  }
  const encoded = await Promise.all(Array.from({ length: 32 }, (_, i) => drawn(draw(i)).encode('jpeg', 90)))
  encoded.forEach((buffer, i) => t.true(buffer.equals(drawn(draw(i)).encodeSync('jpeg', 90)), `canvas ${i}`))
})
