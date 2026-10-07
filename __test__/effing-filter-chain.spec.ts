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
