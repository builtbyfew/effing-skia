import test from 'ava'

import { createCanvas } from '../index'

// A step of a filter list that builds no filter used to take the whole list
// with it: `drop-shadow(0 0 transparent) grayscale(1)` drew in colour. Chrome
// (its canvas, which these follow) skips what is an identity and rejects the
// assignment of a negative amount or length, keeping the previous filter.

const SIZE = 60

function draw(filter: string) {
  const ctx = createCanvas(SIZE, SIZE).getContext('2d')
  ctx.filter = filter
  ctx.fillStyle = 'rgb(255, 0, 0)'
  ctx.beginPath()
  ctx.arc(30, 30, 20, 0, Math.PI * 2)
  ctx.fill()
  return ctx
}

function pixels(filter: string) {
  return Array.from(draw(filter).getImageData(0, 0, SIZE, SIZE).data)
}

function center(filter: string) {
  return Array.from(draw(filter).getImageData(30, 30, 1, 1).data)
}

const GRAY = [54, 54, 54, 255]

for (const shadow of ['drop-shadow(0 0 transparent)', 'drop-shadow(5px 5px 2px rgba(0, 0, 0, 0))']) {
  test(`a transparent ${shadow} is skipped, the rest of the list applies`, (t) => {
    t.deepEqual(pixels(`${shadow} grayscale(1)`), pixels('grayscale(1)'))
    t.deepEqual(pixels(`blur(4px) ${shadow} grayscale(1)`), pixels('blur(4px) grayscale(1)'))
    t.deepEqual(pixels(`blur(4px) grayscale(1) ${shadow}`), pixels('blur(4px) grayscale(1)'))
  })
}

test('drop-shadow(0 0 0 red) keeps the rest of the list', (t) => {
  t.deepEqual(center('drop-shadow(0 0 0 red) grayscale(1)'), GRAY)
  t.deepEqual(center('grayscale(1) drop-shadow(0 0 0 red)'), GRAY)
})

// It is not an identity: as in Chrome, the shadow lies under the content and
// shows where the content is translucent, here the blurred edge.
test('drop-shadow(0 0 0 red) shows under translucent content', (t) => {
  const ctx = draw('blur(4px) drop-shadow(0 0 0 red) grayscale(1)')
  const plain = draw('blur(4px) grayscale(1)')
  const edge = (c: typeof ctx) => c.getImageData(30, 8, 1, 1).data[3]
  t.true(edge(ctx) > edge(plain), `${edge(ctx)} vs ${edge(plain)}`)
})

for (const identity of [
  'blur(0)',
  'brightness(1)',
  'contrast(1)',
  'grayscale(0)',
  'hue-rotate(0deg)',
  'invert(0)',
  'opacity(1)',
  'saturate(1)',
  'sepia(0)',
]) {
  test(`${identity} at the start keeps the rest of the list`, (t) => {
    t.deepEqual(center(`${identity} grayscale(1)`), GRAY)
  })
}

for (const invalid of [
  'blur(-1px)',
  'drop-shadow(0 0 -2px red)',
  'brightness(-1)',
  'contrast(-50%)',
  'grayscale(-1)',
  'invert(-1)',
  'opacity(-1)',
  'saturate(-1)',
  'sepia(-1)',
  'opacity(NaN)',
  'opacity(inf)',
  'hue-rotate(infdeg)',
]) {
  test(`${invalid} is rejected and the previous filter kept`, (t) => {
    const ctx = createCanvas(SIZE, SIZE).getContext('2d')
    ctx.filter = 'sepia(1)'
    ctx.filter = `${invalid} grayscale(1)`
    t.is(ctx.filter, 'sepia(1)')
    ctx.filter = invalid
    t.is(ctx.filter, 'sepia(1)')
  })
}

// What Chrome's canvas accepts as a filter value, and what it rejects, keeping
// the previous filter. Each was checked against Chrome 154.

function accepted(filter: string) {
  const ctx = createCanvas(SIZE, SIZE).getContext('2d')
  ctx.filter = 'sepia(1)'
  ctx.filter = filter
  return ctx.filter !== 'sepia(1)'
}

for (const valid of [
  'hue-rotate(0)',
  'drop-shadow(red 4px 4px 2px)',
  'drop-shadow(red 4px 4px)',
  'drop-shadow(4px 4px 2px hsl(120, 100%, 25%))',
  'drop-shadow(hsla(120, 100%, 25%, 0.5) 4px 4px 2px)',
  'drop-shadow(4px 4px 2px hwb(120 0% 50%))',
  'drop-shadow(4px 4px 2px hsl(0 0% 0% / 0))',
  'BLUR(4px)',
  'blur(4PX)',
  'Drop-Shadow(4PX 4px RED)',
  'HUE-ROTATE(90DEG)',
  'Opacity(50%)',
]) {
  test(`${valid} is accepted`, (t) => {
    t.true(accepted(valid))
  })
}

for (const invalid of [
  'hue-rotate(90)',
  'drop-shadow(4px red 4px)',
  'drop-shadow(4px 4px 2px nosuchcolor)',
  'drop-shadow(4px 4px 2px 1px)',
  'drop-shadow(4px 4px 2px red 1px)',
  'drop-shadow(4px 4px 2px red blue)',
  'drop-shadow(4px)',
  'drop-shadow(red)',
  'drop-shadow(10% 4px)',
]) {
  test(`${invalid} is rejected`, (t) => {
    t.false(accepted(invalid))
  })
}

test('drop-shadow() takes its colour before or after the lengths', (t) => {
  t.deepEqual(pixels('drop-shadow(red 4px 4px 2px)'), pixels('drop-shadow(4px 4px 2px red)'))
  t.deepEqual(
    pixels('drop-shadow(rgba(0, 0, 255, 0.5) 4px 4px) grayscale(1)'),
    pixels('drop-shadow(4px 4px rgba(0, 0, 255, 0.5)) grayscale(1)'),
  )
})

test('drop-shadow() takes hsl() and hwb() colours', (t) => {
  // All three are rgb(0, 128, 0) at 8 bits.
  const rgb = pixels('drop-shadow(4px 4px 2px rgb(0, 128, 0))')
  t.deepEqual(pixels('drop-shadow(4px 4px 2px hsl(120, 100%, 25%))'), rgb)
  t.deepEqual(pixels('drop-shadow(hsl(120deg 100% 25%) 4px 4px 2px)'), rgb)
  t.deepEqual(pixels('drop-shadow(4px 4px 2px hwb(120 0% 50%))'), rgb)
})

for (const shadow of ['drop-shadow(4px 4px 2px hsla(0, 0%, 0%, 0))', 'drop-shadow(hsl(0 0% 0% / 0) 4px 4px)']) {
  test(`a transparent ${shadow} is skipped`, (t) => {
    t.deepEqual(pixels(`${shadow} grayscale(1)`), pixels('grayscale(1)'))
  })
}

test('function names and units are case-insensitive', (t) => {
  t.deepEqual(pixels('BLUR(4PX) Grayscale(1)'), pixels('blur(4px) grayscale(1)'))
  t.deepEqual(pixels('Drop-Shadow(4PX 4Px 2pX RED)'), pixels('drop-shadow(4px 4px 2px red)'))
  t.deepEqual(pixels('HUE-ROTATE(90DEG)'), pixels('hue-rotate(90deg)'))
})

for (const [valid, same] of [
  ['blur(4e1px)', 'blur(40px)'],
  ['blur(1E1px) grayscale(1)', 'blur(10px) grayscale(1)'],
  ['opacity(5e-1)', 'opacity(0.5)'],
  ['hue-rotate(9e1deg)', 'hue-rotate(90deg)'],
  ['drop-shadow(4e0px 4px red)', 'drop-shadow(4px 4px red)'],
  ['hue-rotate()', 'hue-rotate(0deg)'],
  ['blur(4px', 'blur(4px)'],
  ['grayscale(1) opacity(0.5', 'grayscale(1) opacity(0.5)'],
  ['drop-shadow(4px 4px rgb(0, 0, 255)', 'drop-shadow(4px 4px rgb(0, 0, 255))'],
  ['blur(1px)\tgrayscale(1)\n', 'blur(1px) grayscale(1)'],
  ['\fblur(1px)\r\ngrayscale(1)', 'blur(1px) grayscale(1)'],
]) {
  test(`${JSON.stringify(valid)} is read as ${same}`, (t) => {
    t.true(accepted(valid))
    t.deepEqual(pixels(valid), pixels(same))
  })
}

for (const invalid of [
  'blur(4.px)',
  'opacity(1.)',
  'blur(4px grayscale(1)',
  // Only CSS whitespace separates functions, not U+00A0 or U+2003.
  'drop-shadow(4px 4px red) blur(1px)',
  'blur(1px) grayscale(1)',
  'blur(1px) ',
  ' blur(1px)',
  'blur( 1px)',
]) {
  test(`${JSON.stringify(invalid)} is rejected`, (t) => {
    t.false(accepted(invalid))
  })
}

test('none padded with U+00A0 is rejected', (t) => {
  const ctx = createCanvas(SIZE, SIZE).getContext('2d')
  ctx.filter = 'sepia(1)'
  ctx.filter = ' none'
  t.is(ctx.filter, 'sepia(1)')
  ctx.filter = ' none\n'
  t.is(ctx.filter, ' none\n')
})
