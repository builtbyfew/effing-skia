import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test, { type ExecutionContext } from 'ava'

import { GlobalFonts, createCanvas } from '../index'
import { Paragraph, fillParagraph, type ParagraphContent, type ParagraphStyle } from '../extensions'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Every expected value below comes from Chrome 154 (headless, macOS): the
// text in a `white-space: normal` div of the given width, with
// `text-align: justify`, a 30px line height and the same font file loaded
// with @font-face, a placeholder an inline-block span of its size. The ink
// is Chrome's screenshot of the div, read as below; a placeholder's x is its
// span's, in the 1/64px Chrome lays out in, so it is compared to 0.02px.
const LIBERATION: ParagraphStyle = { fontFamily: 'JU Liberation', fontSize: 20, lineHeight: 30, textAlign: 'justify' }
const HAN: ParagraphStyle = {
  fontFamily: 'JU Source Han',
  fontSize: 20,
  fontWeight: 700,
  lineHeight: 30,
  textAlign: 'justify',
}
const ARABIC: ParagraphStyle = {
  fontFamily: 'JU Harmattan',
  fontSize: 24,
  lineHeight: 30,
  textAlign: 'justify',
  direction: 'rtl',
}
const BOX = { width: 10, height: 10 }

test.before((t) => {
  const fonts = join(__dirname, 'fonts')
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'LiberationSans-Regular.woff'), 'JU Liberation'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'SourceHanSerifCN-Bold.ttf'), 'JU Source Han'))
  t.truthy(GlobalFonts.registerFromPath(join(fonts, 'Harmattan-Regular.ttf'), 'JU Harmattan'))
})

// Where each word of each line starts inking, painted at (0, 0): the first
// column of each run of columns with a pixel in the line's box more than
// ~40% opaque, runs less than 3 columns apart being one word. Columns, not
// pixels, so that antialiasing on another platform moves an edge by a pixel
// at most.
function wordStarts(content: ParagraphContent, style: ParagraphStyle, width: number) {
  const paragraph = new Paragraph(content, style)
  const layout = paragraph.layout(width)
  const columns = 300
  const height = layout.lines.length * 30
  const ctx = createCanvas(columns, height).getContext('2d')
  fillParagraph(ctx, paragraph, 0, 0)
  const { data } = ctx.getImageData(0, 0, columns, height)
  const starts = layout.lines.map((_, k) => {
    const words: number[] = []
    let end = -Infinity
    for (let x = 0; x < columns; x++) {
      for (let y = k * 30; y < (k + 1) * 30; y++) {
        if (data[(y * columns + x) * 4 + 3] > 96) {
          if (x - end >= 3) words.push(x)
          end = x + 1
          break
        }
      }
    }
    return words
  })
  return { layout, starts }
}

function expectWords(
  t: ExecutionContext,
  content: ParagraphContent,
  style: ParagraphStyle,
  width: number,
  expected: number[][],
) {
  const { layout, starts } = wordStarts(content, style, width)
  for (const [k, line] of expected.entries()) {
    t.is(starts[k].length, line.length, `line ${k}: ${starts[k]} for ${line}`)
    for (const [i, x] of line.entries()) {
      t.true(Math.abs(starts[k][i] - x) <= 1, `line ${k}: ${starts[k]} for ${line}`)
    }
  }
  return layout
}

// The x of the paragraph's only placeholder.
function boxX(content: ParagraphContent, style: ParagraphStyle, width: number) {
  return new Paragraph(content, style).layout(width).placeholders[0]!.x
}

function near(t: ExecutionContext, actual: number, expected: number, epsilon = 0.02) {
  t.true(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`)
}

test('a no-break space is a justification opportunity, as a space is', (t) => {
  // "aaa bb c dddd" spread to 200px, each gap 29.98px: the same with no-break
  // spaces, which SkParagraph left start-aligned.
  const nbsp = expectWords(t, 'aaa bb c dddd eeeeeee', LIBERATION, 200, [[1, 64, 116, 156], [1]])
  expectWords(t, 'aaa bb c dddd eeeeeee', LIBERATION, 200, [[1, 64, 116, 156]])
  near(t, nbsp.lines[0].width, 200)
  near(t, nbsp.lines[0].left, 0)
  // Spaces and no-break spaces mixed each take the same share, where
  // SkParagraph spread a line at its spaces alone.
  expectWords(t, 'aa bb cc dd ee ff gg hh ii jj kk', LIBERATION, 200, [[1, 39, 77, 113, 152, 189]])
  near(t, boxX(['aaa ', BOX, ' bbb ccc dd eeeeeeeeeeeeeeeeee'], LIBERATION, 200), 51.125)
  // Kept spaces are each an opportunity, as under white-space: pre-wrap.
  near(
    t,
    boxX(['aa  bb cc   ', BOX, ' dd ee ff gg hh ii'], { ...LIBERATION, keepTrailingWhitespace: true }, 150),
    110.141,
  )
})

test('a no-break space at the start of a line is an opportunity, one at its end none', (t) => {
  expectWords(t, ' aaa bbb ccc ddd eee fff ggg hhh', LIBERATION, 200, [[8, 49, 89, 127, 167]])
  // The last character of a line has none after it: the no-break space
  // before the space the line breaks at stays as it is, and the one before
  // "bbbbbb" takes all.
  expectWords(t, 'aaa bbbbbb  cccccccccccccccccc', LIBERATION, 200, [[1, 129]])
  expectWords(t, 'aaaa bbbb cccccccccc', LIBERATION, 200, [[1, 157]])
})

test('other space separators and a ZWSP are no opportunities', (t) => {
  // En spaces keep their width; the space after "c" takes all.
  expectWords(t, 'aaa bb c dddd eeeeeee', LIBERATION, 200, [[1, 44, 76, 156]])
  near(t, boxX(['aaa bb ', BOX, ' c dddd eeeeeeeeeeeeeee'], LIBERATION, 200), 75.625)
  // A line with none is start-aligned.
  const layout = expectWords(t, 'aaa bb c dddd eeeeeee', LIBERATION, 200, [[1, 44, 76, 96]])
  t.true(layout.lines[0].width < 150)
  // An en space that ends a line, which SkParagraph lets hang, counts in its
  // width: the two spaces share 200px less the line and the en space.
  expectWords(t, 'aaa bbb ccc  dddddddddddddddd', LIBERATION, 200, [[1, 81, 161]])
  // A ZWSP is default-ignorable: no opportunity, and between two ideographs
  // it leaves the one after the first.
  near(t, boxX(['日本​', BOX, '語文字漢字仮名混在文章試験です'], HAN, 175), 41.25)
})

test('CJK text is spread between its characters', (t) => {
  // Eight ideographs to a 175px line, 15px over seven gaps.
  expectWords(t, '一二三十口日目田一二三十口日目田一二三十口日目田一二', HAN, 175, [
    [1, 23, 45, 67, 91, 114, 136, 157],
    [1, 23, 45, 67, 91, 114, 136, 157],
    [1, 23, 45, 67, 91, 114, 136, 157],
  ])
  // Kana, punctuation and fullwidth forms too, which SkParagraph doesn't
  // spread at.
  near(t, boxX(['ひらがなと', BOX, 'カタカナだけのぶんしょうをりょうたんそろえにします'], HAN, 175), 103.125)
  near(t, boxX(['日本語、漢字。か', BOX, 'な「引用」です、句読点。テスト'], HAN, 175), 165)
  near(t, boxX(['ＡＢＣ１２', BOX, '３ＤＥＦＧＨＩＪＫＬ'], HAN, 175), 103.125)
  // An ideographic space is spread at as an ideograph is, and hangs at the
  // end of a line, which ends at the ideograph before it.
  near(t, boxX(['日本　語', BOX, '文字漢字仮名混在文章試験です'], HAN, 175), 82.5)
  expectWords(t, '日本語文字漢字　仮名混在文章試験です', HAN, 170, [[3, 26, 51, 76, 101, 126, 151]])
})

test('CJK next to Latin is spread on both sides of each ideograph', (t) => {
  expectWords(t, 'abc漢字def漢字ghi漢字jkl漢字mno', HAN, 200, [[1, 40, 63, 86, 145, 168]])
  near(t, boxX(['abc漢字def', BOX, '漢字ghi漢字jkl漢字mno'], HAN, 200), 113.234)
})

test('justification comes on top of letter spacing', (t) => {
  expectWords(t, 'aa bb cc dd ee ff gg hh ii jj kk', { ...LIBERATION, letterSpacing: 3 }, 200, [
    [1, 15, 38, 52, 75, 88, 110, 124, 147, 161, 183, 192],
  ])
  near(t, boxX(['aa bb ', BOX, ' cc dd ee ff gg hh ii jj kk'], { ...LIBERATION, letterSpacing: 3 }, 200), 76.906)
  expectWords(t, '一二三十口日目田一二三十口日目田一二三十', { ...HAN, letterSpacing: 2 }, 175, [
    [1, 26, 52, 77, 105, 131, 156],
    [2, 26, 52, 77, 103, 130, 156],
  ])
  // The ideograph before a placeholder moves by its share instead of the
  // placeholder, which SkParagraph places by its advance alone.
  near(t, boxX(['一二三', BOX, '十口日目田一二三十口日目田'], { ...HAN, letterSpacing: 2 }, 175), 70.719)
})

test('RTL text is spread at its no-break spaces', (t) => {
  const layout = expectWords(t, 'مرحبا بالعالم مرحبا بكم في هذا النص العربي الطويل', ARABIC, 260, [
    [1, 37, 70, 115, 164, 221],
  ])
  near(t, layout.lines[0].left, 0)
  near(t, layout.lines[0].width, 260)
  near(t, boxX(['مرحبا ', BOX, ' بالعالم مرحبا بكم في هذا النص العربي الطويل'], ARABIC, 220), 165.031)
})

test('the last line is not justified', (t) => {
  const layout = expectWords(t, 'aa bb cc dd ee ff gg hh ii jj kk', LIBERATION, 200, [
    [1, 39, 77, 113, 152, 189],
    [1, 29, 57, 69, 86],
  ])
  t.true(layout.lines[1].width < 110)
})
