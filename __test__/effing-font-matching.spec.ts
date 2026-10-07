import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, Image, createCanvas } from '../index'
import { Paragraph } from '../extensions'

// A family matches a style as CSS does (CSS Fonts 4 §5.2): font-stretch
// first, then font-style, then font-weight (docs/effing.md). The faces here
// are Lato with the style of each face in OS/2 and head and every glyph
// equally wide, a width unique in its family, so the width of a text tells
// which face drew it. The faces Chrome 154 picks are from the same faces,
// loaded with FontFace and weight, style and stretch descriptors, measured
// with measureText, a span and SVG text, which agree.
const { loadSystemFontsFromDir } = createRequire(import.meta.url)('../js-binding.js') as {
  loadSystemFontsFromDir: (dir: string) => number
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const LATO = readFileSync(join(__dirname, 'fonts', 'Lato-Regular.ttf'))

type Slant = 'normal' | 'italic' | 'oblique'
type Face = { weight: number; style: Slant; width: number }

// A face as `${weight}${n|i|o}`, and `@${width}` for a width (SkFontStyle's,
// 1 to 9) other than normal.
function faceOf(name: string): Face {
  const [, weight, slant, width] = /^(\d+)([nio])(?:@(\d))?$/.exec(name)!
  const style = ({ n: 'normal', i: 'italic', o: 'oblique' } as const)[slant as 'n' | 'i' | 'o']
  return { weight: Number(weight), style, width: width ? Number(width) : 5 }
}

const SLANTS = { normal: 0, italic: 1, oblique: 2 }
const advanceOf = ({ weight, style, width }: Face) => 600 + weight + 25 * SLANTS[style] + 7 * (width - 5)

// --- Faces made from Lato ---------------------------------------------------

const DROPPED_TABLES = new Set(['GPOS', 'GSUB', 'GDEF', 'kern', 'hdmx', 'LTSH', 'VDMX', 'DSIG'])

function tablesOf(font: Buffer): Map<string, Buffer> {
  const tables = new Map<string, Buffer>()
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const record = 12 + 16 * i
    const offset = font.readUInt32BE(record + 8)
    tables.set(
      font.toString('latin1', record, record + 4),
      Buffer.from(font.subarray(offset, offset + font.readUInt32BE(record + 12))),
    )
  }
  return tables
}

function nameTable(names: Record<number, string>): Buffer {
  const records = Object.entries(names).map(
    ([id, value]) => [Number(id), Buffer.from(value, 'utf16le').swap16()] as const,
  )
  const header = Buffer.alloc(6 + 12 * records.length)
  header.writeUInt16BE(records.length, 2)
  header.writeUInt16BE(header.length, 4)
  let offset = 0
  records.forEach(([id, value], i) => {
    const record = 6 + 12 * i
    header.writeUInt16BE(3, record) // Windows, Unicode BMP, en-US
    header.writeUInt16BE(1, record + 2)
    header.writeUInt16BE(0x409, record + 4)
    header.writeUInt16BE(id, record + 6)
    header.writeUInt16BE(value.length, record + 8)
    header.writeUInt16BE(offset, record + 10)
    offset += value.length
  })
  return Buffer.concat([header, ...records.map(([, value]) => value)])
}

const padded = (data: Buffer) => Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)])

function checksum(data: Buffer): number {
  const words = padded(data)
  let sum = 0
  for (let i = 0; i < words.length; i += 4) sum = (sum + words.readUInt32BE(i)) >>> 0
  return sum
}

function fontOf(tables: Map<string, Buffer>): Buffer {
  const tags = [...tables.keys()].sort()
  const header = Buffer.alloc(12 + 16 * tags.length)
  const log2 = Math.floor(Math.log2(tags.length))
  header.writeUInt32BE(0x00010000, 0)
  header.writeUInt16BE(tags.length, 4)
  header.writeUInt16BE(16 * 2 ** log2, 6)
  header.writeUInt16BE(log2, 8)
  header.writeUInt16BE(16 * (tags.length - 2 ** log2), 10)
  let offset = header.length
  const bodies = tags.map((tag, i) => {
    const data = tables.get(tag)!
    const record = 12 + 16 * i
    header.write(tag, record, 'latin1')
    header.writeUInt32BE(checksum(data), record + 4)
    header.writeUInt32BE(offset, record + 8)
    header.writeUInt32BE(data.length, record + 12)
    offset += padded(data).length
    return padded(data)
  })
  const font = Buffer.concat([header, ...bodies])
  const head = font.readUInt32BE(12 + 16 * tags.indexOf('head') + 8)
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, head + 8)
  return font
}

// Lato as the face `face` of `family`, every glyph advanceOf(face) wide.
function makeFace(family: string, face: Face): Buffer {
  const tables = tablesOf(LATO)
  for (const tag of DROPPED_TABLES) tables.delete(tag)
  const os2 = tables.get('OS/2')!
  os2.writeUInt16BE(face.weight, 4)
  os2.writeUInt16BE(face.width, 6)
  // fsSelection: italic, bold, regular, oblique.
  let selection = os2.readUInt16BE(62) & ~(1 | 32 | 64 | 512)
  if (face.style === 'italic') selection |= 1
  if (face.style === 'oblique') selection |= 512
  selection |= face.weight >= 700 ? 32 : face.style === 'normal' ? 64 : 0
  os2.writeUInt16BE(selection, 62)
  const head = tables.get('head')!
  // checkSumAdjustment, which fontOf works out anew.
  head.writeUInt32BE(0, 8)
  head.writeUInt16BE((face.weight >= 700 ? 1 : 0) | (face.style === 'normal' ? 0 : 2), 44)
  const hhea = tables.get('hhea')!
  const advance = advanceOf(face)
  hhea.writeUInt16BE(advance, 10)
  const hmtx = tables.get('hmtx')!
  for (let i = 0; i < hhea.readUInt16BE(34); i++) hmtx.writeUInt16BE(advance, 4 * i)
  const subfamily = `${face.weight} ${face.style} ${face.width}`
  tables.set(
    'name',
    nameTable({
      1: family,
      2: subfamily,
      4: `${family} ${subfamily}`,
      6: `${family}-${subfamily}`.replace(/[^A-Za-z0-9-]/g, ''),
    }),
  )
  return fontOf(tables)
}

// --- What Chrome picks -------------------------------------------------------

// Each family's faces, and the face Chrome picks for each style at each of
// WEIGHTS ('normal@3' is condensed, which only ctx.fontStretch asks for).
const WEIGHTS = [100, 200, 300, 350, 400, 450, 500, 550, 600, 700, 800, 900]
const CASES: Record<string, { faces: string; chrome: Record<string, string> }> = {
  // Regular, bold and italic, no bold italic (#37).
  RBI: {
    faces: '400n 700n 400i',
    chrome: {
      normal: '400n 400n 400n 400n 400n 400n 400n 700n 700n 700n 700n 700n',
      italic: '400i 400i 400i 400i 400i 400i 400i 400i 400i 400i 400i 400i',
      oblique: '400i 400i 400i 400i 400i 400i 400i 400i 400i 400i 400i 400i',
    },
  },
  RI: {
    faces: '400n 400i',
    chrome: {
      normal: '400n 400n 400n 400n 400n 400n 400n 400n 400n 400n 400n 400n',
      italic: '400i 400i 400i 400i 400i 400i 400i 400i 400i 400i 400i 400i',
    },
  },
  // Bold and italic, no regular: a normal style takes the bold.
  BI: {
    faces: '700n 400i',
    chrome: {
      normal: '700n 700n 700n 700n 700n 700n 700n 700n 700n 700n 700n 700n',
      italic: '400i 400i 400i 400i 400i 400i 400i 400i 400i 400i 400i 400i',
    },
  },
  W9: {
    faces: '100n 200n 300n 400n 500n 600n 700n 800n 900n',
    chrome: {
      normal: '100n 200n 300n 300n 400n 500n 500n 600n 600n 700n 800n 900n',
      italic: '100n 200n 300n 300n 400n 500n 500n 600n 600n 700n 800n 900n',
    },
  },
  W9I: {
    faces: '100n 200n 300n 400n 500n 600n 700n 800n 900n 100i 200i 300i 400i 500i 600i 700i 800i 900i',
    chrome: {
      normal: '100n 200n 300n 300n 400n 500n 500n 600n 600n 700n 800n 900n',
      italic: '100i 200i 300i 300i 400i 500i 500i 600i 600i 700i 800i 900i',
      oblique: '100i 200i 300i 300i 400i 500i 500i 600i 600i 700i 800i 900i',
    },
  },
  // Every weight upright, and one italic, which every italic takes.
  W9I3: {
    faces: '100n 200n 300n 400n 500n 600n 700n 800n 900n 300i',
    chrome: {
      normal: '100n 200n 300n 300n 400n 500n 500n 600n 600n 700n 800n 900n',
      italic: '300i 300i 300i 300i 300i 300i 300i 300i 300i 300i 300i 300i',
    },
  },
  // 400 and 500 look at the other first; below 400 lighter first, above 500
  // heavier first; from 400 to 500, heavier up to 500, then lighter, then
  // above 500.
  W300_600: {
    faces: '300n 600n',
    chrome: { normal: '300n 300n 300n 300n 300n 300n 300n 600n 600n 600n 600n 600n' },
  },
  W400_500: {
    faces: '400n 500n',
    chrome: { normal: '400n 400n 400n 400n 400n 500n 500n 500n 500n 500n 500n 500n' },
  },
  W300_500_600: {
    faces: '300n 500n 600n',
    chrome: { normal: '300n 300n 300n 300n 500n 500n 500n 600n 600n 600n 600n 600n' },
  },
  W500_600: {
    faces: '500n 600n',
    chrome: { normal: '500n 500n 500n 500n 500n 500n 500n 600n 600n 600n 600n 600n' },
  },
  W300_450_480_700: {
    faces: '300n 450n 480n 700n',
    chrome: { normal: '300n 300n 300n 300n 450n 450n 480n 700n 700n 700n 700n 700n' },
  },
  // An oblique face, which italic takes over a normal one.
  OBL: {
    faces: '400n 400o 700n',
    chrome: {
      normal: '400n 400n 400n 400n 400n 400n 400n 700n 700n 700n 700n 700n',
      italic: '400o 400o 400o 400o 400o 400o 400o 400o 400o 400o 400o 400o',
      oblique: '400o 400o 400o 400o 400o 400o 400o 400o 400o 400o 400o 400o',
    },
  },
  // font-stretch comes first: a condensed bold, and an italic of normal width.
  STR: {
    faces: '700n@3 400i',
    chrome: {
      'normal@3': '700n@3 700n@3 700n@3 700n@3 700n@3 700n@3 700n@3 700n@3 700n@3 700n@3 700n@3 700n@3',
      'normal@4': '700n@3 700n@3 700n@3 700n@3 700n@3 700n@3 700n@3 700n@3 700n@3 700n@3 700n@3 700n@3',
      normal: '400i 400i 400i 400i 400i 400i 400i 400i 400i 400i 400i 400i',
      'italic@7': '400i 400i 400i 400i 400i 400i 400i 400i 400i 400i 400i 400i',
    },
  },
  // Normal and narrower look at narrower widths first, wider ones at wider.
  STR3: {
    faces: '400n@4 400n@6 400n@8',
    chrome: {
      'normal@3': '400n@4 400n@4 400n@4 400n@4 400n@4 400n@4 400n@4 400n@4 400n@4 400n@4 400n@4 400n@4',
      normal: '400n@4 400n@4 400n@4 400n@4 400n@4 400n@4 400n@4 400n@4 400n@4 400n@4 400n@4 400n@4',
      'normal@6': '400n@6 400n@6 400n@6 400n@6 400n@6 400n@6 400n@6 400n@6 400n@6 400n@6 400n@6 400n@6',
      'normal@7': '400n@8 400n@8 400n@8 400n@8 400n@8 400n@8 400n@8 400n@8 400n@8 400n@8 400n@8 400n@8',
    },
  },
}

const STRETCHES: Record<number, string> = {
  3: 'condensed',
  4: 'semi-condensed',
  5: 'normal',
  6: 'semi-expanded',
  7: 'expanded',
}
const TEXT = 'xxxxxxxxxx'
const SIZE = 20

// The face of `family` whose glyphs are `width` wide all told.
function drawnBy(family: string, width: number): string {
  const faces = CASES[family].faces.split(' ')
  const face = faces.find((name) => Math.abs((TEXT.length * advanceOf(faceOf(name)) * SIZE) / 2000 - width) < 0.01)
  return face ?? `none (${width})`
}

function measureText(family: string, style: string, weight: number, width: number): number {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = `${style} ${weight} ${SIZE}px "${family}"`
  ctx.fontStretch = STRETCHES[width] as CanvasFontStretch
  return ctx.measureText(TEXT).width
}

function paragraphWidth(family: string, style: Slant, weight: number): number {
  const paragraph = new Paragraph(TEXT, { fontFamily: family, fontSize: SIZE, fontWeight: weight, fontStyle: style })
  return paragraph.layout(1000).lines[0].width
}

function drawText(family: string, style: string, weight: number): Buffer {
  const canvas = createCanvas(300, 30)
  const ctx = canvas.getContext('2d')
  ctx.font = `${style} ${weight} ${SIZE}px "${family}"`
  ctx.fillText(TEXT, 4, 22)
  return canvas.data()
}

function drawSvg(family: string, style: string, weight: number): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="30"><text x="4" y="22" font-family="${family}" font-size="${SIZE}" font-style="${style}" font-weight="${weight}">${TEXT}</text></svg>`
  const image = new Image()
  image.src = Buffer.from(svg)
  const canvas = createCanvas(300, 30)
  canvas.getContext('2d').drawImage(image, 0, 0)
  return canvas.data()
}

// Registered under `prefix` + the case's name, and loaded as system fonts
// under another.
const REGISTERED = 'FM '
const SYSTEM = 'FS '
const tmpDirs: string[] = []

test.before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'effing-font-matching-'))
  tmpDirs.push(dir)
  for (const [name, { faces }] of Object.entries(CASES)) {
    faces.split(' ').forEach((face, i) => {
      GlobalFonts.register(makeFace(REGISTERED + name, faceOf(face)))
      writeFileSync(join(dir, `${name}-${i}.ttf`), makeFace(SYSTEM + name, faceOf(face)))
    })
  }
  loadSystemFontsFromDir(dir)
})

test.after.always(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

for (const [prefix, kind] of [
  [REGISTERED, 'a registered family'],
  [SYSTEM, 'a system family'],
] as const) {
  test(`${kind} matches a style as Chrome does`, (t) => {
    for (const [name, { chrome }] of Object.entries(CASES)) {
      const family = prefix + name
      for (const [request, faces] of Object.entries(chrome)) {
        const [style, width] = request.split('@') as [Slant, string?]
        faces.split(' ').forEach((face, i) => {
          const weight = WEIGHTS[i]
          const what = `${family}: ${style} ${weight}${width ? ` @${width}` : ''}`
          // ctx.font takes weights in hundreds only.
          if (weight % 100 === 0) {
            t.is(drawnBy(name, measureText(family, style, weight, Number(width ?? 5))), face, `measureText, ${what}`)
          }
          if (!width) {
            t.is(drawnBy(name, paragraphWidth(family, style, weight)), face, `Paragraph, ${what}`)
          }
        })
      }
    }
  })
}

test('bold italic with no such face is the italic face emboldened, as in Chrome (#37)', (t) => {
  // The italic face alone, in a family of its own.
  GlobalFonts.register(makeFace('FM RBI italic', faceOf('400i')))
  const family = `${REGISTERED}RBI`
  t.is(drawnBy('RBI', measureText(family, 'italic', 700, 5)), '400i')
  t.is(drawnBy('RBI', paragraphWidth(family, 'italic', 700)), '400i')
  // fillText draws the italic face emboldened.
  const boldItalic = drawText(family, 'italic', 700)
  t.true(boldItalic.equals(drawText('FM RBI italic', 'italic', 700)))
  t.false(boldItalic.equals(drawText(family, 'italic', 400)))
  t.false(boldItalic.equals(drawText(family, 'normal', 700)))
  // SVG text takes the italic face too.
  const svg = drawSvg(family, 'italic', 700)
  t.true(svg.equals(drawSvg('FM RBI italic', 'italic', 700)))
  t.false(svg.equals(drawSvg(family, 'normal', 700)))
})

test('setAlias takes the face a normal style matches', (t) => {
  // The bold, as in Chrome, where Skia's scores took the italic.
  t.true(GlobalFonts.setAlias(`${REGISTERED}BI`, 'FM BI alias'))
  t.is(drawnBy('BI', paragraphWidth('FM BI alias', 'normal', 400)), '700n')
  t.is(drawnBy('BI', paragraphWidth('FM BI alias', 'italic', 400)), '700n')
})

test('italic takes an italic face over an oblique one, and normal an oblique one over an italic', (t) => {
  // CSS Fonts 4's order. Chrome takes italic and oblique (14deg) for the
  // same slope, so of an italic and an oblique face it takes the better
  // weight, then the last @font-face rule.
  const drawn = (family: string, faces: string[], style: Slant, weight: number) => {
    const width = paragraphWidth(family, style, weight)
    return faces.find((face) => Math.abs((TEXT.length * advanceOf(faceOf(face)) * SIZE) / 2000 - width) < 0.01)
  }
  const mixed = ['700i', '400o', '400n', '400i']
  for (const face of mixed) GlobalFonts.register(makeFace('FM IO', faceOf(face)))
  t.is(drawn('FM IO', mixed, 'italic', 400), '400i')
  t.is(drawn('FM IO', mixed, 'italic', 100), '400i')
  t.is(drawn('FM IO', mixed, 'oblique', 700), '400o')
  t.is(drawn('FM IO', mixed, 'normal', 700), '400n')
  const slanted = ['400i', '400o']
  for (const face of slanted) GlobalFonts.register(makeFace('FM IO slanted', faceOf(face)))
  t.is(drawn('FM IO slanted', slanted, 'normal', 400), '400o')
  t.is(drawn('FM IO slanted', slanted, 'italic', 400), '400i')
})
