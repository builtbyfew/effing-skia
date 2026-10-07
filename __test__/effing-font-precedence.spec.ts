import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, createCanvas } from '../index'
import { Paragraph } from '../extensions'

// A font registered with GlobalFonts takes precedence over a system font of
// the same family name, as an @font-face font does over a local one in a
// browser (docs/effing.md). `loadSystemFontsFromDir` loads fixture fonts as
// system fonts, so the tests don't depend on the fonts the machine has.
// index.js loads the real system fonts with it. The fixture families can be
// installed on a developer's machine too, so the assertions allow for more
// system faces than the fixtures add.
const { loadSystemFontsFromDir } = createRequire(import.meta.url)('../js-binding.js') as {
  loadSystemFontsFromDir: (dir: string) => number
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fonts = join(__dirname, 'fonts')
const LATO = join(fonts, 'Lato-Regular.ttf')
const CURLY_DIR = join(__dirname, 'fonts-dir')
const IOSEVKA_SLAB = join(fonts, 'iosevka-slab-regular.ttf')

const tmpDirs: string[] = []
function systemDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'effing-system-fonts-'))
  tmpDirs.push(dir)
  for (const [name, source] of Object.entries(files)) {
    copyFileSync(source, join(dir, name))
  }
  return dir
}

test.after.always(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const TEXT = 'AVA Wo'
const STYLES = [
  { weight: 400, style: 'normal' },
  { weight: 400, style: 'italic' },
  { weight: 900, style: 'normal' },
] as const
type Style = (typeof STYLES)[number]

function measure(family: string, { weight, style }: Style) {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = `${style} ${weight} 20px ${family}`
  const paragraph = new Paragraph(TEXT, { fontFamily: family, fontSize: 20, fontWeight: weight, fontStyle: style })
  const layout = paragraph.layout(1000)
  return { measureText: ctx.measureText(TEXT).width, paragraph: layout.lines[0].width, ascent: layout.ascent }
}

function draw(family: string, { weight, style }: Style): Buffer {
  const canvas = createCanvas(120, 30)
  const ctx = canvas.getContext('2d')
  ctx.font = `${style} ${weight} 20px ${family}`
  ctx.fillText(TEXT, 4, 22)
  return canvas.data()
}

function styles(family: string) {
  return GlobalFonts.families.find((f) => f.family === family)?.styles
}

// Removing a font rebuilds the font provider from what was registered.
function rebuild(t: { truthy: (value: unknown) => void; true: (value: boolean) => void }) {
  const key = GlobalFonts.register(readFileSync(join(fonts, 'osrs-font-compact.otf')), 'FP Rebuild')
  t.truthy(key)
  t.true(GlobalFonts.remove(key!))
}

test.before((t) => {
  // Iosevka Curly: regular, italic and heavy (900).
  t.is(loadSystemFontsFromDir(CURLY_DIR), 3)
})

test.serial('a font registered under an alias joins its own family without shadowing it', (t) => {
  const regular = STYLES[0]
  const heavy = STYLES[2]
  const before = { regular: draw('"Iosevka Curly"', regular), heavy: draw('"Iosevka Curly"', heavy) }
  const styleCount = styles('Iosevka Curly')!.length
  t.true(styleCount >= 3)
  t.notDeepEqual(before.regular, before.heavy)

  t.truthy(GlobalFonts.register(readFileSync(join(CURLY_DIR, 'iosevka-curly_heavy.Woff2')), 'FP Heading'))
  for (const when of ['registered', 'rebuilt']) {
    // Iosevka Curly keeps its system faces, the heavy among them.
    t.is(styles('Iosevka Curly')!.length, styleCount + 1, when)
    t.true(draw('"Iosevka Curly"', regular).equals(before.regular), when)
    t.true(draw('"Iosevka Curly"', heavy).equals(before.heavy), when)
    // The alias is the heavy face, at any weight.
    t.deepEqual(styles('FP Heading'), [{ weight: 900, width: 'normal', style: 'normal' }], when)
    t.true(draw('"FP Heading"', regular).equals(before.heavy), when)
    rebuild(t)
  }
})

test.serial('a family named with setAlias keeps the face it took, also after a rebuild', (t) => {
  t.is(loadSystemFontsFromDir(systemDir({ 'harmattan.ttf': join(fonts, 'Harmattan-Regular.ttf') })), 1)
  const regular = STYLES[0]
  const harmattan = measure('"Harmattan"', regular)
  t.true(GlobalFonts.setAlias('Harmattan', 'FP Harmattan Alias'))
  t.deepEqual(measure('"FP Harmattan Alias"', regular), harmattan)
  // Registering Lato as Harmattan shadows the system's Harmattan, but not
  // the face the alias took from it.
  t.truthy(GlobalFonts.registerFromPath(LATO, 'Harmattan'))
  t.notDeepEqual(measure('"Harmattan"', regular), harmattan)
  t.deepEqual(measure('"FP Harmattan Alias"', regular), harmattan)
  rebuild(t)
  t.notDeepEqual(measure('"Harmattan"', regular), harmattan)
  t.deepEqual(measure('"FP Harmattan Alias"', regular), harmattan)
})

test.serial("setAlias to a font's own family makes it a registered face there", (t) => {
  // An aliased font joins its own family as a shadowable face; setAlias
  // naming that family after it makes the same face a registered one.
  const mongolian = join(fonts, 'NotoSansMongolian-Regular.ttf')
  t.is(loadSystemFontsFromDir(systemDir({ 'mongolian.ttf': mongolian })), 1)
  t.true(styles('Noto Sans Mongolian')!.length >= 1)
  t.truthy(GlobalFonts.register(readFileSync(mongolian), 'FP Mongolian'))
  t.true(styles('Noto Sans Mongolian')!.length >= 2)
  t.true(GlobalFonts.setAlias('FP Mongolian', 'Noto Sans Mongolian'))
  t.is(styles('Noto Sans Mongolian')!.length, 1)
  rebuild(t)
  t.is(styles('Noto Sans Mongolian')!.length, 1)
})

test.serial('a registered family shadows the system family of the same name, in every style', (t) => {
  const system = STYLES.map((style) => measure('"Iosevka Curly"', style))
  t.truthy(GlobalFonts.registerFromPath(LATO, 'FP Lato'))
  const lato = STYLES.map((style) => measure('"FP Lato"', style))
  for (let i = 0; i < STYLES.length; i++) {
    t.not(system[i].measureText, lato[i].measureText)
    t.not(system[i].paragraph, lato[i].paragraph)
  }

  // Lato registered in regular alone, as Iosevka Curly: the italic and the
  // heavy are synthesized from it, as a browser does for an @font-face
  // family, not taken from the system's Iosevka Curly.
  t.truthy(GlobalFonts.registerFromPath(LATO, 'Iosevka Curly'))
  t.deepEqual(styles('Iosevka Curly'), [{ weight: 400, width: 'normal', style: 'normal' }])
  STYLES.forEach((style, i) => {
    t.deepEqual(measure('"Iosevka Curly"', style), lato[i], `${style.weight} ${style.style}`)
    t.deepEqual(measure('"No Such Font", "Iosevka Curly"', style), lato[i], `${style.weight} ${style.style}`)
    t.true(draw('"Iosevka Curly"', style).equals(draw('"FP Lato"', style)), `${style.weight} ${style.style}`)
  })
})

test.serial('a registered family shadows a system family loaded after it', (t) => {
  t.truthy(GlobalFonts.registerFromPath(LATO, 'FP Lato'))
  t.truthy(GlobalFonts.registerFromPath(LATO, 'Cascadia Code'))
  t.is(loadSystemFontsFromDir(systemDir({ 'Cascadia.woff2': join(fonts, 'Cascadia.woff2') })), 1)
  const regular = STYLES[0]
  t.deepEqual(measure('"Cascadia Code"', regular), measure('"FP Lato"', regular))
  t.deepEqual(styles('Cascadia Code'), [{ weight: 400, width: 'normal', style: 'normal' }])
})

test.serial('a system font registered from its path is a registered font', (t) => {
  // Two system faces of Source Serif Pro, from two files.
  const dir = systemDir({
    'a.ttf': join(fonts, 'SourceSerifPro-Regular.ttf'),
    'b.ttf': join(fonts, 'SourceSerifPro-Regular.ttf'),
  })
  t.is(loadSystemFontsFromDir(dir), 2)
  t.true(styles('Source Serif Pro')!.length >= 2)
  // Registering one of them shadows the other.
  t.truthy(GlobalFonts.registerFromPath(join(dir, 'a.ttf')))
  t.is(styles('Source Serif Pro')?.length, 1)
})

test.serial('loadFontsFromDir registers fonts, which shadow system fonts', (t) => {
  const virgil = join(fonts, 'Virgil.woff2')
  t.is(loadSystemFontsFromDir(systemDir({ 'virgil.woff2': virgil })), 1)
  t.is(GlobalFonts.loadFontsFromDir(systemDir({ 'a.woff2': virgil, 'b.woff2': virgil })), 2)
  // The system's face is shadowed by the two registered copies.
  t.is(styles('Virgil 3 YOFF')?.length, 2)
})

test.serial('a registered family shadows a family the machine has installed', (t) => {
  // index.js loads the machine's fonts as system fonts; pick a family that
  // is there on the CI platforms.
  const family = ['Arial', 'Helvetica', 'DejaVu Sans', 'Liberation Sans', 'Times New Roman', 'Verdana'].find((name) =>
    GlobalFonts.has(name),
  )
  if (!family) {
    t.log('none of the families are installed; skipped')
    t.pass()
    return
  }
  t.log(`shadowing ${family}`)
  const regular = STYLES[0]
  const bold = { weight: 900, style: 'normal' } as const
  t.truthy(GlobalFonts.registerFromPath(IOSEVKA_SLAB, 'FP Iosevka Slab'))
  t.notDeepEqual(measure(`"${family}"`, regular), measure('"FP Iosevka Slab"', regular))
  t.truthy(GlobalFonts.registerFromPath(IOSEVKA_SLAB, family))
  t.deepEqual(measure(`"${family}"`, regular), measure('"FP Iosevka Slab"', regular))
  t.deepEqual(measure(`"${family}"`, bold), measure('"FP Iosevka Slab"', bold))
  t.true(draw(`"${family}"`, regular).equals(draw('"FP Iosevka Slab"', regular)))
})
