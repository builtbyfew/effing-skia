import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts } from '../index'
import { Paragraph, type ParagraphContent } from '../extensions'

const __dirname = dirname(fileURLToPath(import.meta.url))

// A copy of a TrueType font with its hhea lineGap set to `lineGap`.
// FreeType doesn't check table checksums, so nothing else needs to change.
function withLineGap(font: Buffer, lineGap: number): Buffer {
  const copy = Buffer.from(font)
  const tables = copy.readUInt16BE(4)
  for (let i = 0; i < tables; i++) {
    const record = 12 + 16 * i
    if (copy.toString('latin1', record, record + 4) === 'hhea') {
      copy.writeInt16BE(lineGap, copy.readUInt32BE(record + 8) + 8)
      return copy
    }
  }
  throw new Error('no hhea table')
}

test.before((t) => {
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf')))
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Virgil.woff2'), 'LG Virgil'))
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), 'LG Lato'))
  const lato = readFileSync(join(__dirname, 'fonts', 'Lato-Regular.ttf'))
  t.truthy(GlobalFonts.register(withLineGap(lato, 200), 'LG Lato Gap 200'))
  t.truthy(GlobalFonts.register(withLineGap(lato, -200), 'LG Lato Gap -200'))
})

function near(t: import('ava').ExecutionContext, actual: number, expected: number, epsilon = 1e-4) {
  t.true(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`)
}

function lineGap(fontFamily: string, fontSize: number, text: ParagraphContent = 'abc') {
  return new Paragraph(text, { fontFamily, fontSize }).layout(100).lineGap
}

test('lineGap is the hhea line gap at the font size', (t) => {
  // hhea lineGap / unitsPerEm * fontSize.
  near(t, lineGap('Iosevka Slab', 20), (68 / 1000) * 20)
  near(t, lineGap('Iosevka Slab', 50), (68 / 1000) * 50)
  near(t, lineGap('LG Virgil', 100), (5 / 1000) * 100)
  near(t, lineGap('LG Lato Gap 200', 20), (200 / 2000) * 20)
})

test('lineGap is the hhea one even when USE_TYPO_METRICS is set', (t) => {
  // Iosevka Slab sets USE_TYPO_METRICS with an OS/2 sTypoLineGap of 0, which
  // FreeType reports as SkFontMetrics::fLeading. Chrome on macOS takes the
  // hhea gap: measured in Chrome 154 (headless, macOS), a 50px
  // `line-height: normal` line is 62px with its baseline at 50 (hhea:
  // round(48.85) + round(10.25) + round(3.4) = 62, 49 + floor(3 / 2) = 50),
  // where the typo metrics would give 49 + round(13.65) + 0 = 63.
  const layout = new Paragraph('abc', { fontFamily: 'Iosevka Slab', fontSize: 50 }).layout(100)
  t.is(Math.round(layout.ascent) + Math.round(layout.descent) + Math.round(layout.lineGap), 62)
  // Virgil at 300px in Chrome: 380px lines, baseline at 267.
  const virgil = new Paragraph('abc', { fontFamily: 'LG Virgil', fontSize: 300 }).layout(100)
  t.is(Math.round(virgil.ascent) + Math.round(virgil.descent) + Math.round(virgil.lineGap), 380)
  t.is(Math.round(virgil.ascent) + Math.floor(Math.round(virgil.lineGap) / 2), 267)
})

test('a font without a line gap reports 0', (t) => {
  t.is(lineGap('LG Lato', 20), 0)
})

test('a negative line gap is 0, as in Chrome', (t) => {
  // Measured in Chrome 154 (headless, macOS) with Lato's hhea lineGap set to
  // -200 (and -2400): a 20px `line-height: normal` line is 24px with its
  // baseline at 20, as with a gap of 0; with +200 it is 26px, baseline 21.
  t.is(lineGap('LG Lato Gap -200', 20), 0)
  const layout = new Paragraph('abc', { fontFamily: 'LG Lato Gap -200', fontSize: 20 }).layout(100)
  near(t, layout.ascent, (1974 / 2000) * 20)
  near(t, layout.descent, (426 / 2000) * 20)
})

test('lineGap does not change normal line boxes', (t) => {
  // `lineHeight` normal stays ascent + descent; the caller adds the gap.
  const layout = new Paragraph('abc', { fontFamily: 'LG Lato Gap 200', fontSize: 20 }).layout(100)
  near(t, layout.lineHeight, layout.ascent + layout.descent)
})

test('an empty paragraph and one of placeholders only report the primary font gap', (t) => {
  near(t, lineGap('Iosevka Slab', 20, ''), (68 / 1000) * 20)
  near(t, lineGap('Iosevka Slab', 20, [{ width: 10, height: 10 }]), (68 / 1000) * 20)
  near(
    t,
    lineGap('Iosevka Slab', 20, [
      { width: 10, height: 10 },
      { width: 5, height: 5 },
    ]),
    (68 / 1000) * 20,
  )
  // The first family that is there is the primary font, whatever the text.
  near(t, lineGap('No Such Font, Iosevka Slab', 20, ''), (68 / 1000) * 20)
})
