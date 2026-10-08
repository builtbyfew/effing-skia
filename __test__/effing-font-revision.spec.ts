import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test, { type ExecutionContext } from 'ava'

import { GlobalFonts, createCanvas } from '../index'
import { Paragraph, fontRevision } from '../extensions'

// `fontRevision()` grows with every call that changes the fonts GlobalFonts
// holds, and only with those (docs/effing.md).
const { loadSystemFontsFromDir } = createRequire(import.meta.url)('../js-binding.js') as {
  loadSystemFontsFromDir: (dir: string) => number
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fonts = join(__dirname, 'fonts')
const LATO = join(fonts, 'Lato-Regular.ttf')
const OSWALD = join(fonts, 'Oswald.ttf')
const SOURCE_SERIF = join(fonts, 'SourceSerifPro-Regular.ttf')
const IOSEVKA_SLAB = join(fonts, 'iosevka-slab-regular.ttf')
const LIBERATION = join(fonts, 'LiberationSans-Regular.woff')
const COLLECTION = join(fonts, 'effing-collection.ttc')

const tmpDirs: string[] = []
function fontDir(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'effing-font-revision-'))
  tmpDirs.push(dir)
  for (const file of files) {
    copyFileSync(file, join(dir, file.split(/[\\/]/).pop()!))
  }
  return dir
}

test.after.always(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function changes<T>(t: ExecutionContext, call: () => T, what: string): T {
  const before = fontRevision()
  const result = call()
  t.true(fontRevision() > before, `${what} leaves the revision at ${before}`)
  return result
}

function keeps<T>(t: ExecutionContext, call: () => T, what: string): T {
  const before = fontRevision()
  const result = call()
  t.is(fontRevision(), before, `${what} changes the revision`)
  return result
}

function reads(t: ExecutionContext, family: string) {
  keeps(t, () => GlobalFonts.families, 'families')
  keeps(t, () => GlobalFonts.has(family), 'has()')
  keeps(t, () => GlobalFonts.getVariationAxes(family, 400, 5, 0), 'getVariationAxes()')
  keeps(t, () => GlobalFonts.hasVariations(family, 400, 5, 0), 'hasVariations()')
  const ctx = createCanvas(100, 40).getContext('2d')
  keeps(
    t,
    () => {
      ctx.font = `20px "${family}"`
      ctx.fillText('Hello', 0, 30)
      return ctx.measureText('Hello').width
    },
    'measuring and drawing text',
  )
  keeps(
    t,
    () => new Paragraph('Hello world', { fontFamily: `"${family}"`, fontSize: 20 }).layout(50),
    'laying out a paragraph',
  )
}

test.serial('is a whole number', (t) => {
  t.is(typeof fontRevision(), 'number')
  t.true(Number.isSafeInteger(fontRevision()))
})

test.serial('reads leave it as it is', (t) => {
  reads(t, 'Lato')
  // index.js has loaded the system fonts already, so this loads nothing.
  keeps(t, () => GlobalFonts.loadSystemFonts(), 'loadSystemFonts() again')
})

test.serial('register() and registerFromPath() change it', (t) => {
  t.truthy(changes(t, () => GlobalFonts.register(readFileSync(LATO)), 'register()'))
  t.truthy(changes(t, () => GlobalFonts.register(readFileSync(SOURCE_SERIF), 'Revision Serif'), 'register() as'))
  t.truthy(changes(t, () => GlobalFonts.registerFromPath(OSWALD), 'registerFromPath()'))
  t.truthy(changes(t, () => GlobalFonts.registerFromPath(LIBERATION, 'Revision Sans'), 'registerFromPath() as'))
  t.truthy(changes(t, () => GlobalFonts.register(readFileSync(COLLECTION)), 'register() of a collection'))
  t.is(
    keeps(t, () => GlobalFonts.register(Buffer.from('not a font')), 'register() of no font'),
    null,
  )
  t.is(
    keeps(t, () => GlobalFonts.registerFromPath(join(fonts, 'missing.ttf')), 'registerFromPath() of no file'),
    null,
  )
  reads(t, 'Revision Serif')
})

test.serial('setAlias() changes it', (t) => {
  t.true(changes(t, () => GlobalFonts.setAlias('Lato', 'Revision Alias'), 'setAlias()'))
  t.false(keeps(t, () => GlobalFonts.setAlias('No Such Family', 'Revision None'), 'setAlias() of no family'))
  reads(t, 'Revision Alias')
})

test.serial('remove() and its rebuild change it', (t) => {
  const key = GlobalFonts.register(readFileSync(IOSEVKA_SLAB), 'Revision Slab')!
  t.truthy(key)
  t.true(changes(t, () => GlobalFonts.remove(key), 'remove()'))
  reads(t, 'Revision Slab')
  t.false(keeps(t, () => GlobalFonts.remove(key), 'remove() of a removed font'))
})

test.serial('removeBatch() changes it', (t) => {
  const keys = [
    GlobalFonts.register(readFileSync(IOSEVKA_SLAB), 'Revision Batch 1')!,
    GlobalFonts.registerFromPath(IOSEVKA_SLAB, 'Revision Batch 2')!,
  ]
  t.is(
    changes(t, () => GlobalFonts.removeBatch(keys), 'removeBatch()'),
    2,
  )
  t.is(
    keeps(t, () => GlobalFonts.removeBatch(keys), 'removeBatch() of removed fonts'),
    0,
  )
  t.is(
    keeps(t, () => GlobalFonts.removeBatch([]), 'removeBatch() of none'),
    0,
  )
})

test.serial('loadFontsFromDir() and loading system fonts change it', (t) => {
  t.is(
    changes(t, () => GlobalFonts.loadFontsFromDir(fontDir(IOSEVKA_SLAB)), 'loadFontsFromDir()'),
    1,
  )
  t.is(
    changes(t, () => loadSystemFontsFromDir(fontDir(LATO, OSWALD)), 'loadSystemFontsFromDir()'),
    2,
  )
  t.is(
    keeps(t, () => GlobalFonts.loadFontsFromDir(fontDir()), 'loadFontsFromDir() of an empty directory'),
    0,
  )
})

test.serial('removeAll() changes it', (t) => {
  t.true(changes(t, () => GlobalFonts.removeAll(), 'removeAll()') > 0)
  t.is(
    keeps(t, () => GlobalFonts.removeAll(), 'removeAll() of none'),
    0,
  )
  reads(t, 'Lato')
})
