import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, createCanvas } from '../index'
import { Paragraph } from '../extensions'

const { loadSystemFontsFromDir } = createRequire(import.meta.url)('../js-binding.js') as {
  loadSystemFontsFromDir: (dir: string) => number
}

const __dirname = dirname(fileURLToPath(import.meta.url))

// A font collection of three faces, made with fontTools from fonts in this
// directory, subset to ASCII and renamed: Lato Regular as "Effing
// Collection" 400, Oswald at 700 (an instance of its variable font) as
// "Effing Collection" 700, and Source Serif Pro Regular as "Effing
// Collection Serif" 400.
const COLLECTION = join(__dirname, 'fonts', 'effing-collection.ttc')
const LATO = join(__dirname, 'fonts', 'Lato-Regular.ttf')

const TEXT = 'Hello'
// The width of TEXT at 20px in each face, as Chrome 154 measures it with the
// three faces loaded as FontFaces of those families and weights.
const REGULAR = 46.96
const BOLD = 42.22
const SERIF = 48.28

function measure(font: string) {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = font
  return ctx.measureText(TEXT).width
}

function near(t: import('ava').ExecutionContext, actual: number, expected: number, message = '') {
  t.true(Math.abs(actual - expected) <= 0.005, `${message} ${actual} is not ${expected}`)
}

function styles(family: string) {
  const found = GlobalFonts.families.find((f) => f.family === family)
  return found ? found.styles.map((s) => `${s.weight} ${s.style}`).sort() : []
}

const tmpDirs: string[] = []
test.after.always(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

test.serial('register() registers every face of a font collection, under one key', (t) => {
  const key = GlobalFonts.register(readFileSync(COLLECTION))
  t.truthy(key)
  t.deepEqual(styles('Effing Collection'), ['400 normal', '700 normal'])
  t.deepEqual(styles('Effing Collection Serif'), ['400 normal'])
  near(t, measure('20px "Effing Collection"'), REGULAR)
  near(t, measure('bold 20px "Effing Collection"'), BOLD)
  near(t, measure('20px "Effing Collection Serif"'), SERIF)
  const bold = new Paragraph(TEXT, { fontFamily: 'Effing Collection', fontSize: 20, fontWeight: 700 })
  near(t, bold.layout(1000).lines[0].width, BOLD)
  // Removing the key removes every face.
  t.true(GlobalFonts.remove(key!))
  t.deepEqual(styles('Effing Collection'), [])
  t.deepEqual(styles('Effing Collection Serif'), [])
})

// A rebuild (GlobalFonts.remove of another font) registers the faces again in
// the order they were first registered, so the first of equal faces stays
// the one that draws.
test.serial("a rebuild keeps a collection's faces in order under an alias of a later face's family", (t) => {
  // A copy: a path registered before is registered again, not afresh.
  const dir = mkdtempSync(join(tmpdir(), 'effing-collection-'))
  tmpDirs.push(dir)
  const path = join(dir, 'collection.ttc')
  copyFileSync(COLLECTION, path)
  const key = GlobalFonts.registerFromPath(path, 'Effing Collection Serif')
  t.truthy(key)
  const paragraph = () =>
    new Paragraph(TEXT, { fontFamily: 'Effing Collection Serif', fontSize: 20 }).layout(1000).lines[0].width
  // The collection's first face comes before its Serif face. (Placed before
  // the tests that leave faces of the family registered.)
  const before = paragraph()
  near(t, before, REGULAR)
  const other = GlobalFonts.registerFromPath(LATO, 'Rebuild Trigger')
  t.true(GlobalFonts.remove(other!))
  near(t, paragraph(), before, 'after a rebuild')
  t.true(GlobalFonts.remove(key!))
})

// The weights Chrome's canvas takes in `ctx.font`, any number from 1 to
// 1000 (CSS Fonts 4), with the face it picks of a family of a 400 and a 700
// face, measured in Chrome 154: up to 500, the 400 face; from 550, the 700
// one. ctx.font keeps the number as Chrome uses it (550.5 is 550.5, which
// Chrome serializes as 550).
test.serial('ctx.font takes any font-weight from 1 to 1000, as Chrome does', (t) => {
  const key = GlobalFonts.registerFromPath(COLLECTION)
  t.truthy(key)
  for (const [weight, width] of [
    ['1', REGULAR],
    ['100', REGULAR],
    ['350', REGULAR],
    ['450', REGULAR],
    ['500', REGULAR],
    ['550', BOLD],
    ['550.5', BOLD],
    ['650', BOLD],
    ['725', BOLD],
    ['1000', BOLD],
    ['1e3', BOLD],
    ['+550', BOLD],
    ['.5e3', REGULAR],
  ] as const) {
    near(t, measure(`${weight} 20px "Effing Collection"`), width, weight)
    near(t, measure(`italic ${weight} 20px "Effing Collection"`), width, `italic ${weight}`)
  }
  t.true(GlobalFonts.remove(key!))
})

// Chrome ignores these, keeping the font it had; ctx.font throws on them, as
// on any value it can't parse, and keeps it too. "550 20px X" used to be a
// 550px font of the family "20px X".
test.serial('a font-weight outside 1 to 1000 leaves ctx.font as it was', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  for (const weight of ['0', '1001', '-1', '0.5', '550.']) {
    ctx.font = '13px serif'
    ctx.font = `${weight} 20px Arial`
    t.is(ctx.font, '13px serif', weight)
  }
})

test.serial('registerFromPath() registers every face of a font collection under an alias', (t) => {
  const key = GlobalFonts.registerFromPath(COLLECTION, 'Collection Alias')
  t.truthy(key)
  t.deepEqual(styles('Collection Alias'), ['400 normal', '400 normal', '700 normal'])
  near(t, measure('20px "Collection Alias"'), REGULAR)
  near(t, measure('bold 20px "Collection Alias"'), BOLD)
  // Each face joins its own family too.
  near(t, measure('bold 20px "Effing Collection"'), BOLD)
  near(t, measure('20px "Effing Collection Serif"'), SERIF)

  // GlobalFonts.remove of another font rebuilds the provider, which
  // registers the collection's faces again as they were.
  const lato = GlobalFonts.registerFromPath(LATO, 'Collection Other')
  t.truthy(lato)
  t.true(GlobalFonts.remove(lato!))
  t.deepEqual(styles('Collection Alias'), ['400 normal', '400 normal', '700 normal'])
  near(t, measure('bold 20px "Collection Alias"'), BOLD)
  near(t, measure('bold 20px "Effing Collection"'), BOLD)
  near(t, measure('20px "Effing Collection Serif"'), SERIF)

  // Registered again under the family of a face other than the first, the
  // collection is a registered font of that family, that face included.
  t.deepEqual(GlobalFonts.registerFromPath(COLLECTION, 'Effing Collection Serif'), key)
  t.deepEqual(styles('Effing Collection Serif'), ['400 normal', '400 normal', '700 normal'])
  t.true(GlobalFonts.remove(key!))
  t.deepEqual(styles('Collection Alias'), [])
  t.deepEqual(styles('Effing Collection Serif'), [])
  t.deepEqual(styles('Effing Collection'), [])
})

// A setAlias mapping to a face of a collection goes when the collection is
// removed, whichever face it maps to, as it does for a single font.
test.serial('remove() drops the setAlias mappings of every face of a font collection', (t) => {
  const key = GlobalFonts.registerFromPath(COLLECTION)
  t.truthy(key)
  t.true(GlobalFonts.setAlias('Effing Collection Serif', 'Collection Serif Alias'))
  near(t, measure('20px "Collection Serif Alias"'), SERIF)
  t.true(GlobalFonts.remove(key!))
  t.deepEqual(styles('Collection Serif Alias'), [])
  // A later rebuild, with a font of the removed family, doesn't bring the
  // removed face back under the alias.
  const lato = GlobalFonts.registerFromPath(LATO, 'Effing Collection Serif')
  const other = GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Oswald.ttf'), 'Collection Other')
  t.truthy(lato)
  t.truthy(other)
  t.true(GlobalFonts.remove(other!))
  t.deepEqual(styles('Collection Serif Alias'), [])
  t.true(Math.abs(measure('20px "Collection Serif Alias"') - SERIF) > 0.5)
  t.true(GlobalFonts.remove(lato!))
})

test.serial("a setAlias of a collection's later face keeps that face after a rebuild", (t) => {
  const key = GlobalFonts.registerFromPath(COLLECTION, 'Collection Later Faces')
  t.truthy(key)
  t.true(GlobalFonts.setAlias('Effing Collection Serif', 'Collection Later Alias'))
  near(t, measure('20px "Collection Later Alias"'), SERIF)
  // GlobalFonts.remove rebuilds the provider.
  const other = GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Oswald.ttf'), 'Collection Rebuild')
  t.true(GlobalFonts.remove(other!))
  near(t, measure('20px "Collection Later Alias"'), SERIF)
  t.true(GlobalFonts.remove(key!))
})

test.serial('a collection registered under an installed family lists every face there', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'effing-system-collection-alias-'))
  tmpDirs.push(dir)
  copyFileSync(join(__dirname, 'fonts', 'Harmattan-Regular.ttf'), join(dir, 'harmattan.ttf'))
  const path = join(dir, 'collection.ttc')
  copyFileSync(COLLECTION, path)
  t.is(GlobalFonts.loadFontsFromDir(dir), 2)
  t.true(measure('20px Harmattan') !== REGULAR)
  // The collection named as Harmattan, an installed family: the bold is the
  // collection's own bold face, not its regular emboldened.
  const key = GlobalFonts.registerFromPath(path, 'Harmattan')
  t.truthy(key)
  near(t, measure('20px Harmattan'), REGULAR)
  near(t, measure('bold 20px Harmattan'), BOLD)
  t.true(GlobalFonts.remove(key!))
})

// Last: system fonts can't be removed.
test.serial('loadSystemFontsFromDir loads every face of a font collection as a system font', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'effing-system-collection-'))
  tmpDirs.push(dir)
  const path = join(dir, 'collection.ttc')
  copyFileSync(COLLECTION, path)
  t.is(loadSystemFontsFromDir(dir), 1)
  t.deepEqual(styles('Effing Collection'), ['400 normal', '700 normal'])
  t.deepEqual(styles('Effing Collection Serif'), ['400 normal'])
  near(t, measure('bold 20px "Effing Collection"'), BOLD)
  near(t, measure('20px "Effing Collection Serif"'), SERIF)

  // A family registered under the name shadows every system face of it, the
  // collection's bold too: bold is the registered regular, emboldened.
  const lato = GlobalFonts.registerFromPath(LATO, 'Effing Collection')
  t.truthy(lato)
  t.deepEqual(styles('Effing Collection'), ['400 normal'])
  near(t, measure('bold 20px "Effing Collection"'), REGULAR)
  near(t, measure('20px "Effing Collection Serif"'), SERIF)

  // The collection registered from its path is a registered font from then
  // on, every face of it, in a Paragraph. Canvas text (and so the shaper
  // engine) keeps it an installed font, as upstream does from 1.2.0 for a
  // file loaded from a font folder and registered again with no alias, so
  // the family's FontFace (the Lato registered under its name) still draws
  // there.
  const collection = GlobalFonts.registerFromPath(path)
  t.truthy(collection)
  const bold = new Paragraph(TEXT, { fontFamily: 'Effing Collection', fontSize: 20, fontWeight: 700 })
  near(t, bold.layout(1000).lines[0].width, process.env.EFFING_PARAGRAPH_ENGINE === 'shaper' ? REGULAR : BOLD)
  near(t, measure('bold 20px "Effing Collection"'), REGULAR)
  t.true(GlobalFonts.remove(lato!))
  t.deepEqual(styles('Effing Collection'), ['400 normal', '700 normal'])
  near(t, measure('bold 20px "Effing Collection"'), BOLD)
  near(t, measure('20px "Effing Collection Serif"'), SERIF)
})

// A collection's faces are FontFaces as new as the call that registered
// them, the later faces too: the newest face of a weight draws it.
test.serial("a collection's later faces are as new as its first", (t) => {
  const harmattan = GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Harmattan-Regular.ttf'), 'Newest Brand', {
    weight: 'bold',
  })
  const key = GlobalFonts.registerFromPath(COLLECTION, 'Newest Brand')
  t.truthy(harmattan)
  t.truthy(key)
  near(t, measure('bold 20px "Newest Brand"'), BOLD)
  t.true(GlobalFonts.remove(key!))
  t.true(GlobalFonts.remove(harmattan!))
})

// A collection from a font folder registered again under an alias lists the
// web twin of its first face there (upstream's FontFace of a preloaded
// file), which keeps that face's file style like the collection's others.
test.serial('a font-folder collection registered under an alias keeps each face its style', (t) => {
  const buffer = readFileSync(COLLECTION)
  // Swap the first two faces in the TTC header: the 700 face comes first.
  const first = buffer.readUInt32BE(12)
  buffer.writeUInt32BE(buffer.readUInt32BE(16), 12)
  buffer.writeUInt32BE(first, 16)
  const dir = mkdtempSync(join(tmpdir(), 'effing-collection-'))
  tmpDirs.push(dir)
  const path = join(dir, 'bold-first.ttc')
  writeFileSync(path, buffer)
  t.is(GlobalFonts.loadFontsFromDir(dir), 1)
  const key = GlobalFonts.registerFromPath(path, 'Preloaded Collection')
  t.truthy(key)
  near(t, measure('20px "Preloaded Collection"'), REGULAR)
  near(t, measure('bold 20px "Preloaded Collection"'), BOLD)
  t.true(GlobalFonts.remove(key!))
})
