import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

// `index.js` loads the system's fonts once per process, on a thread of its
// own, and everything that uses the font collection waits for them
// (docs/effing.md). Each process loads them once, so these tests run in child
// processes.
const root = join(fileURLToPath(import.meta.url), '..', '..')
const LATO = join(root, '__test__', 'fonts', 'Lato-Regular.ttf')

function node(script: string, env: Record<string, string> = {}) {
  return execFileSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', DISABLE_SYSTEM_FONTS_LOAD: '', ...env },
  }).trim()
}

// The fonts and the font revision, as a JSON line.
const report = `{
  const { GlobalFonts } = require('./index.js')
  const { fontRevision } = require('./extensions.js')
  console.log(JSON.stringify({ revision: fontRevision(), families: GlobalFonts.families }))
}`

// What index.js loaded synchronously before.
const synchronousLoad = `{
  const { platform, homedir } = require('os')
  const { join } = require('path')
  const { GlobalFonts } = require('./index.js')
  const { loadSystemFontsFromDir } = require('./js-binding.js')
  GlobalFonts.loadSystemFonts()
  switch (platform()) {
    case 'win32':
      loadSystemFontsFromDir(join(homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts'))
      break
    case 'darwin':
      loadSystemFontsFromDir(join(homedir(), 'Library', 'Fonts'))
      break
    case 'linux':
      loadSystemFontsFromDir(join('usr', 'local', 'share', 'fonts'))
      loadSystemFontsFromDir(join(homedir(), '.fonts'))
      break
  }
}`

test('the fonts index.js loads are the ones it loaded synchronously', (t) => {
  const loaded = JSON.parse(node(report))
  const synchronous = JSON.parse(node(synchronousLoad + report, { DISABLE_SYSTEM_FONTS_LOAD: '1' }))
  t.deepEqual(loaded.families, synchronous.families)
  t.is(loaded.revision, synchronous.revision)
})

test('DISABLE_SYSTEM_FONTS_LOAD still loads no fonts', (t) => {
  const loaded = JSON.parse(node(report, { DISABLE_SYSTEM_FONTS_LOAD: '1' }))
  t.deepEqual(loaded, { revision: 0, families: [] })
})

test('worker threads that load index.js at once share one load', (t) => {
  const out = node(`
    const { Worker } = require('node:worker_threads')
    const workers = Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const worker = new Worker(${JSON.stringify(report)}, { eval: true, stdout: true })
      let out = ''
      worker.stdout.on('data', (d) => (out += d))
      worker.on('error', reject)
      worker.stdout.on('end', () => resolve(JSON.parse(out)))
    }))
    Promise.all(workers).then((reports) => {
      ${report}
      console.log(JSON.stringify(reports))
    })
  `)
  const [main, workers] = out.split('\n').map((line) => JSON.parse(line))
  const synchronous = JSON.parse(node(synchronousLoad + report, { DISABLE_SYSTEM_FONTS_LOAD: '1' }))
  t.is(workers.length, 8)
  for (const worker of workers) {
    t.deepEqual(worker.families, synchronous.families)
    t.is(worker.revision, synchronous.revision)
  }
  // Loading index.js again in the main thread doesn't load them again either.
  t.deepEqual(main, synchronous)
})

test('a font registered while the system fonts load still shadows a system family', (t) => {
  const families: { family: string }[] = JSON.parse(node(report)).families
  const system = families.map(({ family }) => family).find((family) => family !== 'Lato')
  if (!system) {
    t.pass('no system fonts here')
    return
  }
  // Registered at once, while the system fonts are most likely still loading,
  // under the name of a system family, which it must shadow, as when it's
  // registered after they've loaded.
  const width = (wait: boolean) =>
    Number(
      node(`
        const { GlobalFonts, createCanvas } = require('./index.js')
        ${wait ? 'GlobalFonts.families' : ''}
        GlobalFonts.registerFromPath(${JSON.stringify(LATO)}, ${JSON.stringify(system)})
        const ctx = createCanvas(10, 10).getContext('2d')
        ctx.font = '40px ' + ${JSON.stringify(JSON.stringify(system))}
        console.log(ctx.measureText('Hamburgefonstiv').width)
      `),
    )
  const lato = Number(
    node(`
      const { GlobalFonts, createCanvas } = require('./index.js')
      GlobalFonts.registerFromPath(${JSON.stringify(LATO)}, 'Lato')
      const ctx = createCanvas(10, 10).getContext('2d')
      ctx.font = '40px Lato'
      console.log(ctx.measureText('Hamburgefonstiv').width)
    `),
  )
  t.is(width(false), lato)
  t.is(width(true), lato)
})

// Runs `script` in a child process, for its exit code and signal.
function exitOf(script: string) {
  return new Promise<{ script: string; code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, NODE_OPTIONS: '', DISABLE_SYSTEM_FONTS_LOAD: '' },
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ script, code, signal }))
  })
}

// The process mustn't exit while the system fonts load: `exit()` runs the
// static destructors while the loading thread is in Skia's font code, which
// then crashes. Exits at many points across the load, every way a process
// can exit, from the main thread and from a worker.
test('a process can exit at any point while the system fonts load', async (t) => {
  t.timeout(180_000)
  // How long the load takes after index.js is loaded (fontRevision() waits
  // for it). The sweep goes well past it, as the load takes longer when
  // children run side by side.
  const durations = Array.from({ length: 3 }, () =>
    Number(
      node(`
        const { performance } = require('node:perf_hooks')
        require('./index.js')
        const start = performance.now()
        require('./extensions.js').fontRevision()
        console.log(performance.now() - start)
      `),
    ),
  )
  const end = Math.ceil(Math.max(...durations) * 2.5) + 40
  const step = Math.max(1, Math.round(end / 40))
  const scripts: string[] = []
  for (let delay = 0; delay <= end; delay += step) {
    const worker = (script: string) =>
      `new (require('node:worker_threads').Worker)(${JSON.stringify(script)}, { eval: true })`
    scripts.push(
      // The event loop drains.
      `require('./index.js'); setTimeout(() => {}, ${delay})`,
      `require('./index.js'); setTimeout(() => process.exit(0), ${delay})`,
      `require('./index.js'); setTimeout(() => { throw new Error('uncaught') }, ${delay})`,
      // Only a worker loads index.js: it finishes at once, or exits, or the
      // main thread exits while it runs.
      `${worker(`require('./index.js')`)}.unref(); setTimeout(() => {}, ${delay})`,
      `${worker(`require('./index.js'); setTimeout(() => process.exit(0), ${delay})`)}`,
      `${worker(`require('./index.js'); setInterval(() => {}, 1000)`)}; setTimeout(() => process.exit(0), ${delay})`,
    )
  }
  const crashes: string[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < scripts.length) {
        const { script, code, signal } = await exitOf(scripts[next++])
        const expected = script.includes('uncaught') ? 1 : 0
        if (signal !== null || code !== expected) {
          crashes.push(`${signal ?? code}: ${script}`)
        }
      }
    }),
  )
  t.deepEqual(crashes, [], `${crashes.length} of ${scripts.length} exits crashed`)
})
