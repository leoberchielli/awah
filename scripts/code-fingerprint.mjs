#!/usr/bin/env node
/**
 * Fingerprints the code of every source file, ignoring comments.
 *
 * Translating comments must not change behaviour, and "must not" is worth
 * proving rather than trusting. Run this before a comment sweep and again
 * after: any file whose fingerprint moved had its *code* edited, which a
 * comment sweep has no business doing.
 *
 * Comments are dropped by parsing, not by a regex or a bare scanner. A regex
 * cannot tell a comment from `'http://x'`; a context-free scanner is worse — it
 * reads the `}` that closes a `${…}` as the start of a new template and
 * swallows everything to the next backtick, comments included, so a
 * comment-only edit shows up as a code change.
 *
 * Usage:
 *   node scripts/code-fingerprint.mjs write <file>   snapshot to <file>
 *   node scripts/code-fingerprint.mjs check <file>   compare against it
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'

const ROOTS = [
  'apps/api/src',
  'apps/api/test',
  'apps/web/src',
  'packages/db/src',
  'packages/sdk/src',
  'scripts',
]

/** Catalogs are data, not code; their "comments" are translated strings. */
const SKIP = [join('i18n', 'locales')]

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(path, out)
    else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !SKIP.some((s) => path.includes(s)))
      out.push(path)
  }
  return out
}

/**
 * Every leaf token of the parsed file, joined by a single space.
 *
 * Comments are trivia: the parser attaches them to nodes rather than making
 * them children, so walking to the leaves drops them for free. Whitespace is
 * normalised away on purpose — a translated comment changes how the formatter
 * wraps the line beneath it, and that is not a code change.
 */
function fingerprint(file) {
  const source = readFileSync(file, 'utf8')
  const src = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const tokens = []
  const anda = (node) => {
    // `//` comments are trivia and never appear here, but `/** */` is parsed
    // into real JSDoc nodes that `getChildren` hands back. Skip that subtree or
    // the very thing being translated ends up inside the hash.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return
    }
    const filhos = node.getChildren(src)
    if (filhos.length === 0) tokens.push(node.getText(src))
    else for (const filho of filhos) anda(filho)
  }
  anda(src)

  return createHash('sha256').update(tokens.join(' ')).digest('hex').slice(0, 16)
}

const [modo, destino] = process.argv.slice(2)
if (!modo || !destino) {
  console.error('usage: code-fingerprint.mjs <write|check> <file>')
  process.exit(2)
}

const files = ROOTS.filter((r) => {
  try {
    return statSync(r).isDirectory()
  } catch {
    return false
  }
}).flatMap((r) => collect(r))

const atual = Object.fromEntries(
  files.map((f) => [relative('.', f).split(sep).join('/'), fingerprint(f)]),
)

if (modo === 'write') {
  writeFileSync(destino, `${JSON.stringify(atual, null, 2)}\n`)
  console.log(`${Object.keys(atual).length} files fingerprinted → ${destino}`)
  process.exit(0)
}

const anterior = JSON.parse(readFileSync(destino, 'utf8'))
const mudou = []
const sumiu = []
const novo = []

for (const [f, h] of Object.entries(anterior)) {
  if (!(f in atual)) sumiu.push(f)
  else if (atual[f] !== h) mudou.push(f)
}
for (const f of Object.keys(atual)) if (!(f in anterior)) novo.push(f)

if (mudou.length === 0 && sumiu.length === 0 && novo.length === 0) {
  console.log(`${Object.keys(atual).length} files: code unchanged.`)
  process.exit(0)
}

if (mudou.length) console.error(`code changed in ${mudou.length} file(s):\n  ${mudou.join('\n  ')}`)
if (sumiu.length) console.error(`missing:\n  ${sumiu.join('\n  ')}`)
if (novo.length) console.error(`new:\n  ${novo.join('\n  ')}`)
process.exit(1)
