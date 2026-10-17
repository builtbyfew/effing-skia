// QOI against PNG and JPEG: encode time and size of 1920×1080 frames.
//
//   node --import @oxc-node/core/register benchmark/encode.ts
//
// Each scene is encoded on the calling thread (`encodeSync`) for the latency
// of one frame, then 48 at once on the encode pool (`encode`) for throughput
// across cores.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'

import { cyan } from 'colorette'

import { createCanvas, Canvas, loadImage, Path2D } from '../index'
import { getEncodeThreads } from '../extensions'

const WIDTH = 1920
const HEIGHT = 1080
const SYNC_RUNS = 30
const POOL_FRAMES = 48
const POOL_RUNS = 5

const root = join(fileURLToPath(import.meta.url), '..', '..')

interface Format {
  name: string
  sync: (canvas: Canvas) => Buffer
  async: (canvas: Canvas) => Promise<Buffer>
}

const formats: Format[] = [
  { name: 'png', sync: (c) => c.encodeSync('png'), async: (c) => c.encode('png') },
  { name: 'jpeg 92', sync: (c) => c.encodeSync('jpeg', 92), async: (c) => c.encode('jpeg', 92) },
  { name: 'jpeg 75', sync: (c) => c.encodeSync('jpeg', 75), async: (c) => c.encode('jpeg', 75) },
  { name: 'qoi', sync: (c) => c.encodeSync('qoi'), async: (c) => c.encode('qoi') },
]

// A title card: gradient background, flat shapes, text. What most motion
// graphics frames look like.
function graphics() {
  const canvas = createCanvas(WIDTH, HEIGHT)
  const ctx = canvas.getContext('2d')
  const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT)
  background.addColorStop(0, '#1d2b64')
  background.addColorStop(1, '#f8cdda')
  ctx.fillStyle = background
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
  for (let i = 0; i < 12; i++) {
    ctx.beginPath()
    ctx.arc(160 * i, 300 + 200 * Math.sin(i), 120 + 20 * (i % 4), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = '#ffb000'
  ctx.fillRect(120, 640, 720, 12)
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 120px sans-serif'
  ctx.fillText('Quarterly results', 120, 600)
  ctx.font = '48px sans-serif'
  ctx.fillText('Revenue up 24% on last year, across every region', 120, 740)
  return canvas
}

// Vector art: the tiger (example/tiger.json, drawn on 1024×768), filling the
// frame's height.
function illustration() {
  const canvas = createCanvas(WIDTH, HEIGHT)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  const scale = HEIGHT / 768
  ctx.translate((WIDTH - 1024 * scale) / 2, 0)
  ctx.scale(scale, scale)
  const tiger = JSON.parse(readFileSync(join(root, 'example', 'tiger.json'), 'utf8'))
  for (const { d, fillStyle, strokeStyle, lineWidth } of tiger) {
    const path = new Path2D(d)
    ctx.fillStyle = fillStyle
    ctx.strokeStyle = strokeStyle
    if (lineWidth) ctx.lineWidth = parseInt(lineWidth, 10)
    ctx.stroke(path)
    ctx.fill(path)
  }
  return canvas
}

// A photo, tiled at its own resolution so that it keeps its grain.
async function photo() {
  const canvas = createCanvas(WIDTH, HEIGHT)
  const ctx = canvas.getContext('2d')
  const image = await loadImage(readFileSync(join(root, '__test__', 'fixtures', 'with-exif.jpg')))
  for (let y = 0; y < HEIGHT; y += image.height) {
    for (let x = 0; x < WIDTH; x += image.width) {
      ctx.drawImage(image, x, y)
    }
  }
  return canvas
}

// Random pixels: no format compresses them, the worst case for every encoder.
function noise() {
  const canvas = createCanvas(WIDTH, HEIGHT)
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(WIDTH, HEIGHT)
  let seed = 1
  for (let i = 0; i < image.data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    image.data[i] = i % 4 === 3 ? 255 : (seed >> 16) & 255
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function time(fn: () => void) {
  const start = process.hrtime.bigint()
  fn()
  return Number(process.hrtime.bigint() - start) / 1e6
}

async function timeAsync(fn: () => Promise<unknown>) {
  const start = process.hrtime.bigint()
  await fn()
  return Number(process.hrtime.bigint() - start) / 1e6
}

async function bench(scene: string, canvas: Canvas) {
  const raw = WIDTH * HEIGHT * 4
  const rows = []
  for (const format of formats) {
    const size = format.sync(canvas).length
    for (let i = 0; i < 3; i++) format.sync(canvas)
    const sync = median(Array.from({ length: SYNC_RUNS }, () => time(() => format.sync(canvas))))

    const frames = Array.from({ length: POOL_FRAMES }, () => canvas)
    await Promise.all(frames.map(format.async))
    const pooled: number[] = []
    for (let i = 0; i < POOL_RUNS; i++) {
      pooled.push(await timeAsync(() => Promise.all(frames.map(format.async))))
    }
    const pool = median(pooled)

    rows.push({
      format: format.name,
      'encodeSync (ms)': +sync.toFixed(2),
      'pool (frames/s)': Math.round((POOL_FRAMES / pool) * 1000),
      'size (KiB)': Math.round(size / 1024),
      'of raw RGBA': `${((size / raw) * 100).toFixed(1)}%`,
    })
  }
  console.info(cyan(`${scene}, ${WIDTH}×${HEIGHT}`))
  console.table(rows)
}

async function run() {
  console.info(
    `${availableParallelism()} cores, ${getEncodeThreads()} encode threads, ${SYNC_RUNS} sync runs (median), ` +
      `${POOL_FRAMES} frames × ${POOL_RUNS} pool runs (median)\n`,
  )
  await bench('Graphics', graphics())
  await bench('Illustration', illustration())
  await bench('Photo', await photo())
  await bench('Noise', noise())
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
