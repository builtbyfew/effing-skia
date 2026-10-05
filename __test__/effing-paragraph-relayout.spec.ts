import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, createCanvas } from '../index'
import {
  Paragraph,
  fillParagraph,
  type ParagraphContent,
  type ParagraphLayout,
  type ParagraphStyle,
} from '../extensions'

const __dirname = dirname(fileURLToPath(import.meta.url))

test.before((t) => {
  const fonts = join(__dirname, 'fonts')
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'iosevka-slab-regular.ttf'), 'WB Iosevka'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'Lato-Regular.ttf'), 'WB Lato'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'SourceHanSerifCN-Bold.ttf'), 'WB Source Han'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'Harmattan-Regular.ttf'), 'WB Harmattan'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'NotoSansDevanagari-Regular.ttf'), 'WB Devanagari'))
})

type Case = { parts: ParagraphContent; style: ParagraphStyle; widths: number[] }

// Justified text that SkParagraph used to lay out again with the last
// layout's justification in its line widths (#12): the lines a fuzzer found,
// and two of only Source Han Serif, with no fallback fonts. Each is laid out
// at its widths in turn, and in the reverse order.
const CASES: Case[] = [
  // Fuzz seed regular 6890
  {
    parts: [
      'नमस्तेwordhere\r\n',
      'مرحبا ',
      '😀',
      'Overlong\r\nxyz',
      '  xyz',
      'مرحباनमस्ते👩‍👩‍👧\t',
      '😀\r\nwordhereb',
      'Overlong,',
      ',\t ',
      '日本',
      '語の\twordhere',
      ' wordhere',
    ],
    style: {
      fontFamily: 'WB Lato',
      fontSize: 20,
      lineHeight: 40,
      wordBreak: 'break-all',
      overflowWrap: 'normal',
      keepTrailingWhitespace: true,
      direction: 'rtl',
      textAlign: 'justify',
    },
    widths: [30, 60],
  },
  // Fuzz seed heavy 1966
  {
    parts: [
      'नमस्तेOverlongبالعالم中文',
      ' ,wordhere',
      { width: 5, height: 10 },
      { width: 5, height: 10 },
      '日本🇧🇪नमस्ते中文',
      'नमस्ते😀 😀',
      'é\n1.5',
      '😀1.5',
      'بالعالم1.5',
      'b🇧🇪 ',
      '👩‍👩‍👧',
      { width: 40, height: 10 },
    ],
    style: {
      fontFamily: 'WB Lato',
      fontSize: 20,
      lineHeight: 40,
      wordBreak: 'normal',
      overflowWrap: 'normal',
      textAlign: 'justify',
    },
    widths: [35, 22],
  },
  // Fuzz seed heavy 7126
  {
    parts: [
      'नमस्ते,',
      'éwordherewordhereبالعالم',
      { width: 15, height: 10 },
      '-b',
      '中文',
      '🇧🇪a',
      '👩‍👩‍👧é',
      'xyz',
      '語のa',
      '中文😀awordhere',
    ],
    style: {
      fontFamily: 'WB Devanagari, WB Iosevka',
      fontSize: 20,
      lineHeight: 40,
      wordBreak: 'break-all',
      overflowWrap: 'normal',
      textAlign: 'justify',
    },
    widths: [100, 30],
  },
  // Fuzz seed heavy 7896
  {
    parts: ['नमस्ते ', '😀🇧🇪語の', { width: 15, height: 10 }, '\r\n'],
    style: {
      fontFamily: 'WB Devanagari, WB Iosevka',
      fontSize: 20,
      lineHeight: 40,
      wordBreak: 'normal',
      overflowWrap: 'break-word',
      maxLines: 3,
      ellipsis: '…',
      direction: 'rtl',
      textAlign: 'justify',
    },
    widths: [40, 60],
  },
  // Fuzz seed heavy 8446
  {
    parts: [
      '\nOverlong­1.5',
      '🇧🇪',
      '\r\n中文😀日本',
      '-',
      { width: 5, height: 10 },
      '🇧🇪語の\r\n',
      ',😀',
      'xyz',
      '語の日本中文مرحبا',
    ],
    style: {
      fontFamily: 'WB Harmattan, WB Iosevka',
      fontSize: 20,
      lineHeight: 40,
      wordBreak: 'keep-all',
      overflowWrap: 'break-word',
      direction: 'rtl',
      textAlign: 'justify',
    },
    widths: [60, 25],
  },
  // Fuzz seed heavy 10119
  {
    parts: [
      'b­\t ',
      { width: 40, height: 10 },
      'wordhere',
      { width: 40, height: 10 },
      'Overlongمرحبا👩‍👩‍👧wordhere',
      '中文Overlong',
      { width: 5, height: 10 },
      ' ',
    ],
    style: {
      fontFamily: 'WB Iosevka',
      fontSize: 20,
      lineHeight: 40,
      wordBreak: 'keep-all',
      overflowWrap: 'break-word',
      textAlign: 'justify',
    },
    widths: [35, 15],
  },
  // Fuzz seed heavy 20652
  {
    parts: ['a', '­中文語の', '­-नमस्ते  ', 'wordhere1.5'],
    style: {
      fontFamily: 'WB Lato',
      fontSize: 20,
      lineHeight: 40,
      wordBreak: 'normal',
      overflowWrap: 'break-word',
      textAlign: 'justify',
      letterSpacing: 2,
    },
    widths: [40, 25],
  },
  // Fuzz seed heavy 21356
  {
    parts: [
      { width: 5, height: 10 },
      'مرحبا,xyz',
      'éwordhere\r\na',
      { width: 40, height: 10 },
      { width: 15, height: 10 },
      '\r\n中文',
      'مرحباwordhere中文日本',
      '1.5  ',
    ],
    style: {
      fontFamily: 'WB Harmattan, WB Iosevka',
      fontSize: 20,
      lineHeight: 40,
      wordBreak: 'keep-all',
      overflowWrap: 'break-word',
      keepTrailingWhitespace: true,
      textAlign: 'justify',
    },
    widths: [60, 20],
  },
  // Fuzz seed heavy 22077
  {
    parts: [
      'a\r\nनमस्तेمرحبا',
      { width: 5, height: 10 },
      'a',
      'wordhere語の1.5中文',
      'xyzwordhere😀',
      ' بالعالمxyz-',
      'नमस्ते',
      'éनमस्तेa1.5',
      '\t',
      { width: 5, height: 10 },
      '😀',
    ],
    style: {
      fontFamily: 'WB Harmattan, WB Iosevka',
      fontSize: 20,
      lineHeight: 40,
      wordBreak: 'break-all',
      overflowWrap: 'break-word',
      textAlign: 'justify',
    },
    widths: [40, 25],
  },
  // Fuzz seed heavy 22545
  {
    parts: ['é', 'Overlong1.5語の', '­🇧🇪', '日本', ',Overlong😀a'],
    style: {
      fontFamily: 'WB Devanagari, WB Iosevka',
      fontSize: 20,
      lineHeight: 40,
      wordBreak: 'break-all',
      overflowWrap: 'break-word',
      textAlign: 'justify',
    },
    widths: [100, 25],
  },
  // Fuzz seed heavy 29312
  {
    parts: ['🇧🇪بالعالم', ',', '\r\n', '日本 ', ' 😀b', '😀', '\n-xyz', { width: 40, height: 10 }, '語のxyz語の', '­­-'],
    style: {
      fontFamily: 'WB Harmattan, WB Iosevka',
      fontSize: 20,
      lineHeight: 40,
      wordBreak: 'keep-all',
      overflowWrap: 'break-word',
      letterSpacing: 2,
      textAlign: 'justify',
    },
    widths: [60, 28],
  },
  // Ideographic justification; a fresh layout's longestLine is wider.
  {
    parts: '中文 xy 中文',
    style: { fontFamily: 'WB Source Han', fontSize: 20, lineHeight: 40, letterSpacing: 2, textAlign: 'justify' },
    widths: [110, 119],
  },
  // An ideographic line the old shifts made 11px narrow, in RTL.
  {
    parts: '語の xy 中文',
    style: {
      fontFamily: 'WB Source Han',
      fontSize: 20,
      lineHeight: 40,
      letterSpacing: 2,
      textAlign: 'justify',
      direction: 'rtl',
    },
    widths: [119, 34],
  },

  // At 150px, then at 100px, where a word too wide for the line splits the
  // text into pieces that are laid out in its place, then at 150px again: the
  // whole text's lines, justified at 150px before, used to stay 150px wide
  // and paint unjustified.
  {
    parts: ['ab cd ', { width: 15, height: 10 }, ' ef gh ij kl mn Overlongword'],
    style: { fontFamily: 'WB Iosevka', fontSize: 20, lineHeight: 40, textAlign: 'justify' },
    widths: [150, 100, 150],
  },
  {
    parts: ['ab cd ', { width: 15, height: 10 }, ' ef gh ij kl mn Overlongword'],
    style: { fontFamily: 'WB Iosevka', fontSize: 20, lineHeight: 40, textAlign: 'justify', maxLines: 3, ellipsis: '…' },
    widths: [150, 100, 150],
  },
]

// The paragraph painted at its last layout, from 300px in, where lines
// overflowing to the left in RTL still show.
function paint(paragraph: Paragraph, layout: ParagraphLayout) {
  const canvas = createCanvas(1600, Math.max(1, Math.ceil(layout.height)))
  const ctx = canvas.getContext('2d')
  fillParagraph(ctx, paragraph, 300, 0)
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data
}

test('laying a justified paragraph out again at another width is laying out a fresh one', (t) => {
  for (const [i, { parts, style, widths }] of CASES.entries()) {
    for (const direction of ['ltr', 'rtl'] as const) {
      for (const order of [widths, [...widths].reverse()]) {
        const relaid = new Paragraph(parts, { ...style, direction })
        relaid.layout(order[0])
        for (const [k, width] of order.entries()) {
          if (k === 0) {
            continue
          }
          const layout = relaid.layout(width)
          const freshParagraph = new Paragraph(parts, { ...style, direction })
          const fresh = freshParagraph.layout(width)
          const name = `case ${i} ${direction} at ${order.slice(0, k + 1).join(', ')}`
          t.deepEqual(layout, fresh, name)
          // Justification moves the glyphs, which the metrics don't show.
          t.true(Buffer.from(paint(relaid, layout)).equals(Buffer.from(paint(freshParagraph, fresh))), name)
        }
      }
    }
  }
})
