import { execFileSync } from 'node:child_process'
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
      worker.on('exit', () => resolve(JSON.parse(out)))
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

test('a process can exit while the system fonts load', (t) => {
  for (let i = 0; i < 10; i++) {
    node(`require('./index.js')`)
    node(`require('./index.js'); process.exit(0)`)
  }
  t.pass()
})
