#!/usr/bin/env node
/**
 * Reports how complete each translation is, and fails on the mistakes that
 * actually break a screen.
 *
 * A missing key is not an error: it falls back to English, and that is exactly
 * what lets someone open a pull request with twenty lines translated. What is
 * an error is a placeholder that got lost — `{n}` dropped from a translation
 * makes the number disappear at runtime with no warning anywhere, and no
 * type-checker catches it because the value is still a string.
 *
 * No dependencies and no TypeScript runtime: catalogs are plain literal objects
 * kept formatted by biome, so reading them with a regex is enough and keeps
 * this runnable from a bare checkout.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCALES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps',
  'web',
  'src',
  'i18n',
  'locales',
)

const PLACEHOLDER = /\{(\w+)\}/g

/** Key → the raw literal, so placeholders can be compared without evaluating. */
function readCatalog(file) {
  const source = readFileSync(join(LOCALES_DIR, file), 'utf8')
  const entries = new Map()

  for (const line of source.split('\n')) {
    const match = /^\s{2}'([^']+)':\s*(.*)$/.exec(line)
    if (match) entries.set(match[1], match[2])
  }

  // Values that biome wrapped onto their own line: the key line ends with `:`.
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s{2}'([^']+)':\s*$/.exec(lines[i])
    if (match) entries.set(match[1], lines[i + 1] ?? '')
  }

  return entries
}

function placeholders(literal) {
  return new Set(Array.from(literal.matchAll(PLACEHOLDER), (m) => m[1]))
}

const en = readCatalog('en.ts')
const others = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.ts') && f !== 'en.ts')
  .sort()

console.log(`source: en.ts — ${en.size} keys\n`)

let failures = 0

for (const file of others) {
  const catalog = readCatalog(file)
  const code = file.replace(/\.ts$/, '')

  const missing = [...en.keys()].filter((k) => !catalog.has(k))
  const unknown = [...catalog.keys()].filter((k) => !en.has(k))
  const broken = []

  for (const [key, literal] of catalog) {
    const expected = placeholders(en.get(key) ?? '')
    const got = placeholders(literal)
    const lost = [...expected].filter((p) => !got.has(p))
    if (lost.length > 0) broken.push(`${key} → lost ${lost.map((p) => `{${p}}`).join(', ')}`)
  }

  const done = en.size - missing.length
  const pct = Math.round((done / en.size) * 100)
  const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '·')

  console.log(`${code.padEnd(6)} ${bar} ${String(pct).padStart(3)}%  ${done}/${en.size}`)

  for (const problem of unknown) {
    console.log(`       ✗ unknown key: ${problem}`)
    failures++
  }
  for (const problem of broken) {
    console.log(`       ✗ ${problem}`)
    failures++
  }
}

console.log(
  '\nMissing keys are fine — they fall back to English. Unknown keys and lost\nplaceholders are not.',
)

if (failures > 0) {
  console.error(`\n${failures} problem(s) found.`)
  process.exit(1)
}
