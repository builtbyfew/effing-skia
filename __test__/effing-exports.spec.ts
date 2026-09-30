import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

// Resolved by a plain Node process through the package's own name: the test
// loader is more lenient than Node, which needs the `exports` map for a
// subpath without an extension.
const root = join(fileURLToPath(import.meta.url), '..', '..')

function node(...args: string[]) {
  return execFileSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  }).trim()
}

const EXTENSIONS = 'Paragraph beginGroup endGroup fillParagraph strokeParagraph'

test('the extensions entry resolves from ESM with named imports', (t) => {
  const names = EXTENSIONS.split(' ')
  const script = `
    import { ${names.join(', ')} } from '@effing/skia/extensions'
    console.log([${names.join(', ')}].map((value) => typeof value).join(' '))
  `
  t.is(node('--input-type=module', '-e', script), names.map(() => 'function').join(' '))
})

test('the extensions entry resolves from CommonJS', (t) => {
  const script = `console.log(Object.keys(require('@effing/skia/extensions')).sort().join(' '))`
  t.is(node('-e', script), EXTENSIONS)
})

test('the main entry and the paths upstream resolves still resolve', (t) => {
  const specifiers = ['', '/index.js', '/node-canvas', '/node-canvas.js', '/package.json']
  const script = `
    const resolved = ${JSON.stringify(specifiers)}.map((path) => require.resolve('@effing/skia' + path))
    console.log(resolved.map((file) => require('node:path').basename(file)).join(' '))
  `
  t.is(node('-e', script), 'index.js index.js node-canvas.js node-canvas.js package.json')
})
