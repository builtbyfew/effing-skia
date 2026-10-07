import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
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
// index.js loads the real system fonts with it.
const { loadSystemFontsFromDir } = createRequire(import.meta.url)('../js-binding.js') as {
  loadSystemFontsFromDir: (dir: string) => number
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fonts = join(__dirname, 'fonts')
const LATO = join(fonts, 'Lato-Regular.ttf')
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

test.serial('a registered family shadows the system family of the same name, in every style', (t) => {
  // Iosevka Curly: regular, italic and heavy (900).
  t.is(loadSystemFontsFromDir(join(__dirname, 'fonts-dir')), 3)
  t.is(styles('Iosevka Curly')?.length, 3)
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
  t.is(styles('Source Serif Pro')?.length, 2)
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
