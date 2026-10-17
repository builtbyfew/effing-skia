import PNG from '@jimp/png'
import test from 'ava'

import { createCanvas, ImageData } from '../index'

const END_MARKER = [0, 0, 0, 0, 0, 0, 0, 1]

// A decoder written from the spec (https://qoiformat.org/qoi-specification.pdf),
// independent of the encoder.
function decode(qoi: Buffer) {
  const width = qoi.readUInt32BE(4)
  const height = qoi.readUInt32BE(8)
  const pixels = new Uint8ClampedArray(width * height * 4)
  const index = new Uint8Array(64 * 4)
  let [r, g, b, a] = [0, 0, 0, 255]
  let p = 14
  let run = 0
  for (let i = 0; i < pixels.length; i += 4) {
    if (run > 0) {
      run--
    } else {
      const tag = qoi[p++]
      if (tag === 0xfe) {
        ;[r, g, b] = [qoi[p++], qoi[p++], qoi[p++]]
      } else if (tag === 0xff) {
        ;[r, g, b, a] = [qoi[p++], qoi[p++], qoi[p++], qoi[p++]]
      } else if (tag >> 6 === 0) {
        ;[r, g, b, a] = index.subarray((tag & 63) * 4, (tag & 63) * 4 + 4)
      } else if (tag >> 6 === 1) {
        r = (r + ((tag >> 4) & 3) - 2) & 255
        g = (g + ((tag >> 2) & 3) - 2) & 255
        b = (b + (tag & 3) - 2) & 255
      } else if (tag >> 6 === 2) {
        const dg = (tag & 63) - 32
        const next = qoi[p++]
        r = (r + dg + (next >> 4) - 8) & 255
        g = (g + dg) & 255
        b = (b + dg + (next & 15) - 8) & 255
      } else {
        run = tag & 63
      }
      index.set([r, g, b, a], ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4)
    }
    pixels.set([r, g, b, a], i)
  }
  return { width, height, pixels, rest: [...qoi.subarray(p)] }
}

function drawn() {
  const canvas = createCanvas(320, 200)
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, 320, 200)
  gradient.addColorStop(0, '#f80')
  gradient.addColorStop(1, 'rgba(0, 64, 255, 0.4)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 320, 120)
  ctx.fillStyle = 'rgba(30, 200, 90, 0.7)'
  ctx.beginPath()
  ctx.arc(160, 120, 70, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#123'
  ctx.font = '28px sans-serif'
  ctx.fillText('Quite OK', 20, 180)
  return canvas
}

test('the header names the size, four channels and sRGB', (t) => {
  const qoi = createCanvas(300, 17).encodeSync('qoi')
  t.is(qoi.subarray(0, 4).toString('latin1'), 'qoif')
  t.is(qoi.readUInt32BE(4), 300)
  t.is(qoi.readUInt32BE(8), 17)
  t.is(qoi[12], 4)
  t.is(qoi[13], 0)
})

test('each op is encoded as the reference encoder does', (t) => {
  const canvas = createCanvas(8, 1)
  // prettier-ignore
  const pixels = [
    0, 0, 0, 255,       // the start pixel again: a run...
    0, 0, 0, 255,       // ...of two
    1, 0, 255, 255,     // diff (+1, 0, -1), wrapping
    21, 20, 19, 255,    // luma (+20, +20, +20)
    200, 10, 90, 255,   // rgb
    0, 0, 0, 0,         // index 0, which starts out transparent black
    255, 255, 255, 51,  // rgba
    1, 0, 255, 255,     // index 49
  ]
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), 8, 1), 0, 0)
  // prettier-ignore
  t.deepEqual([...canvas.encodeSync('qoi').subarray(14)], [
    0xc1,
    0x79,
    0xb4, 0x88,
    0xfe, 200, 10, 90,
    0x00,
    0xff, 255, 255, 255, 51,
    0x31,
    ...END_MARKER,
  ])
})

test('runs longer than 62 pixels are split', (t) => {
  const canvas = createCanvas(200, 1)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, 200, 1)
  t.deepEqual([...canvas.encodeSync('qoi').subarray(14)], [0xfd, 0xfd, 0xfd, 0xc0 | 13, ...END_MARKER])
})

test('the pixels decode to what getImageData reads', (t) => {
  const canvas = drawn()
  const { width, height, pixels, rest } = decode(canvas.encodeSync('qoi'))
  t.is(width, 320)
  t.is(height, 200)
  t.deepEqual(rest, END_MARKER)
  const expected = canvas.getContext('2d').getImageData(0, 0, 320, 200).data
  t.true(Buffer.from(pixels.buffer).equals(Buffer.from(expected.buffer)))
})

test('the pixels are the ones encode(png) stores, for any premultiplied color', (t) => {
  // Random RGBA, which the canvas stores premultiplied, and unpremultiplies
  // for QOI with getImageData()'s conversion and for PNG with Skia's own.
  const [width, height] = [97, 61]
  const pixels = new Uint8ClampedArray(width * height * 4)
  let seed = 7
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    pixels[i] = (seed >> 16) & 255
  }
  const canvas = createCanvas(width, height)
  canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0)
  const png = PNG().decoders['image/png'](canvas.encodeSync('png'))
  t.deepEqual(Buffer.from(decode(canvas.encodeSync('qoi')).pixels.buffer), Buffer.from(png.data))
})

test('an image that changes alpha at every pixel outgrows the raw size and still decodes', (t) => {
  const canvas = createCanvas(256, 64)
  const pixels = new Uint8ClampedArray(256 * 64 * 4)
  // White keeps its exact alpha through the canvas's premultiplied storage.
  for (let i = 0; i < pixels.length; i += 4) pixels.set([255, 255, 255, (i * 7) & 255], i)
  const ctx = canvas.getContext('2d')
  ctx.putImageData(new ImageData(pixels, 256, 64), 0, 0)
  const qoi = canvas.encodeSync('qoi')
  t.true(qoi.length > pixels.length)
  t.deepEqual(decode(qoi).pixels, ctx.getImageData(0, 0, 256, 64).data)
})

test('it encodes pending draws, and the canvas as it was when called', async (t) => {
  const canvas = drawn()
  const sync = canvas.encodeSync('qoi')
  const pending = canvas.encode('qoi')
  canvas.getContext('2d').fillRect(0, 0, 320, 200)
  t.true((await pending).equals(sync))
  t.false(canvas.encodeSync('qoi').equals(sync))
})

test('every method that takes a mime type encodes image/qoi to the same bytes', async (t) => {
  const canvas = drawn()
  const qoi = canvas.encodeSync('qoi')
  const dataUrl = `data:image/qoi;base64,${qoi.toString('base64')}`
  t.true(canvas.toBuffer('image/qoi').equals(qoi))
  t.is(canvas.toDataURL('image/qoi'), dataUrl)
  t.is(await canvas.toDataURLAsync('image/qoi'), dataUrl)
  const blob = await canvas.convertToBlob({ mime: 'image/qoi' })
  t.true(Buffer.from(await blob.arrayBuffer()).equals(qoi))
  const callbackBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/qoi'))
  t.true(Buffer.from(await callbackBlob!.arrayBuffer()).equals(qoi))
})

test('a canvas without alpha encodes opaque, in four channels', (t) => {
  const canvas = createCanvas(64, 64)
  canvas.getContext('2d', { alpha: false }) // filled white
  const qoi = canvas.encodeSync('qoi')
  t.is(qoi[12], 4)
  t.true(decode(qoi).pixels.every((value) => value === 255))
})
