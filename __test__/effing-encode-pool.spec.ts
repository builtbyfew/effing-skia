import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas } from '../index'
import { getEncodeThreads } from '../extensions'

// Async encodes run on the addon's own thread pool rather than libuv's
// (docs/effing.md). Each process has one pool, sized when first used, so the
// sizing and worker tests run in a child process.
const root = join(fileURLToPath(import.meta.url), '..', '..')

function node(script: string, env: Record<string, string> = {}) {
  return execFileSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', ...env },
  }).trim()
}

function drawn() {
  const canvas = createCanvas(200, 120)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#3a7'
  ctx.fillRect(10, 10, 120, 80)
  ctx.fillStyle = '#c33'
  ctx.beginPath()
  ctx.arc(140, 60, 40, 0, Math.PI * 2)
  ctx.fill()
  return canvas
}

test('async encodes match their sync counterparts', async (t) => {
  const canvas = drawn()
  for (const [format, quality] of [['png'], ['jpeg', 80], ['webp', 80], ['gif'], ['qoi']] as const) {
    // @ts-expect-error -- overloads don't take a union of formats
    const encoded = await canvas.encode(format, quality)
    // @ts-expect-error -- overloads don't take a union of formats
    t.true(encoded.equals(canvas.encodeSync(format, quality)), format)
  }
  t.is(await canvas.toDataURLAsync('image/png'), canvas.toDataURL('image/png'))
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  t.true(Buffer.from(await blob.arrayBuffer()).equals(canvas.encodeSync('png')))
})

test('many concurrent encodes all resolve, each with its own bytes', async (t) => {
  const canvases = Array.from({ length: 32 }, (_, i) => {
    const canvas = createCanvas(64, 64)
    canvas.getContext('2d').fillStyle = `rgb(${i * 8}, 0, 0)`
    canvas.getContext('2d').fillRect(0, 0, 64, 64)
    return canvas
  })
  const encoded = await Promise.all(canvases.map((canvas) => canvas.encode('png')))
  encoded.forEach((buffer, i) => t.true(buffer.equals(canvases[i].encodeSync('png')), `canvas ${i}`))
})

// WebP can't encode an image over 16383px wide, so encode() fails on the
// pool (an unknown format fails before the encode is queued, and throws).
// toBlob and convertToBlob crop it to 16383px instead, as Chrome does.
const tooWideForWebp = () => createCanvas(16400, 10)

test('a failed encode rejects with the encoder error', async (t) => {
  const error = await t.throwsAsync(tooWideForWebp().encode('webp'))
  t.is(error?.message, 'Get webp data from surface failed')
  t.is((error as Error & { code?: string })?.code, 'GenericFailure')
  // toDataURLAsync settles on the pool as toDataURL does: "data:," for a
  // failed encode, as in Chrome.
  const canvas = tooWideForWebp()
  t.is(await canvas.toDataURLAsync('image/webp'), canvas.toDataURL('image/webp'))
})

test('toBlob calls back with the bytes, or with null when there are none', async (t) => {
  const canvas = drawn()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  t.true(Buffer.from(await blob!.arrayBuffer()).equals(canvas.encodeSync('png')))
  const empty = await new Promise<Blob | null>((resolve) => createCanvas(0, 10).toBlob(resolve, 'image/png'))
  t.is(empty, null)
})

test('a toBlob callback that throws is an uncaught exception, not an unhandled rejection', (t) => {
  const script = `
    process.on('uncaughtException', (e) => console.log('uncaughtException:', e.message))
    process.on('unhandledRejection', (e) => console.log('unhandledRejection:', e.message))
    const { createCanvas } = require('@effing/skia')
    createCanvas(10, 10).toBlob(() => { throw new Error('callback threw') }, 'image/png')
  `
  t.is(node(script), 'uncaughtException: callback threw')
})

test('the pool has a thread per core unless EFFING_SKIA_THREADS sets it', (t) => {
  t.true(getEncodeThreads() >= 1)
  const script = `console.log(require('@effing/skia/extensions').getEncodeThreads())`
  t.is(node(script, { EFFING_SKIA_THREADS: '3' }), '3')
  t.is(node(script, { EFFING_SKIA_THREADS: '3', UV_THREADPOOL_SIZE: '1' }), '3')
  // Not a positive number: fall back to the default.
  t.not(node(script, { EFFING_SKIA_THREADS: '0' }), '0')
})

test('encodes settle on the worker thread that started them, and terminating it mid-encode is safe', (t) => {
  const script = `
    const { Worker } = require('node:worker_threads')
    const worker = (finish) => new Worker(\`
      const { parentPort, workerData } = require('node:worker_threads')
      const { createCanvas } = require('@effing/skia')
      const canvas = createCanvas(1080, 1920)
      canvas.getContext('2d').fillRect(0, 0, 500, 500)
      const pending = Array.from({ length: 8 }, () => canvas.encode('png'))
      parentPort.postMessage('started')
      if (workerData) Promise.all(pending).then((all) => parentPort.postMessage(all.length))
    \`, { eval: true, workerData: finish })
    ;(async () => {
      for (let i = 0; i < 5; i++) {
        const w = worker(false)
        await new Promise((r) => w.once('message', r))
        await w.terminate()
      }
      const w = worker(true)
      w.on('message', (m) => { if (m !== 'started') { console.log(m); w.terminate() } })
    })()
  `
  t.is(node(script), '8')
})
