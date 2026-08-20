#!/usr/bin/env node
/**
 * Finds the renames in a map that would silently shadow something.
 *
 * Run this before `rename-symbols.mjs`, because the failure it catches is the
 * one nothing else catches. Rename `erro` to `error` in a scope that already
 * reads an outer `error` and TypeScript stays quiet: the inner binding is legal,
 * the references still resolve, and they now resolve to the wrong variable. The
 * tests only notice if that path happens to be covered.
 *
 * Duplicate declarations in the *same* scope are not the interesting case —
 * `tsc` reports those. Shadowing is.
 *
 * Two kinds of identifier are deliberately ignored, because neither takes part
 * in lexical scoping and counting them buries the real findings:
 *
 *   - property names — `x.value`, `{ value: 1 }`, `value?: string`
 *   - lowercase JSX tags — `<label>` is an intrinsic element, not a binding
 *
 * On this repo that distinction took the report from 46 candidates to 6 real
 * ones, including `janela` → `window`, which would have shadowed the DOM global
 * in the file whose sign-out button calls `window.location.assign`.
 *
 * Usage:
 *   node scripts/rename-conflicts.mjs <map.json>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import ts from 'typescript'

const mapaPath = process.argv[2]
if (!mapaPath) {
  console.error('usage: rename-conflicts.mjs <map.json>')
  process.exit(2)
}
/**
 * Null-prototype, for the same reason `rename-symbols.mjs` uses one: on a plain
 * object `mapa['toString']` resolves to `Object.prototype.toString` and reads
 * as a rename target that was never in the map.
 */
const mapa = Object.assign(Object.create(null), JSON.parse(readFileSync(mapaPath, 'utf8')))

const ROOTS = ['apps/api', 'apps/web', 'packages/db', 'packages/sdk']
const SKIP = ['i18n/locales', 'node_modules', '/dist/']

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) collect(path, out)
    else if (/\.tsx?$/.test(entry.name) && !SKIP.some((skip) => path.includes(skip))) out.push(path)
  }
  return out
}

function ehNomeDePropriedade(n) {
  const p = n.parent
  if (!p) return false
  if (ts.isPropertyAccessExpression(p) && p.name === n) return true
  if (ts.isQualifiedName(p) && p.right === n) return true
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isEnumMember(p)) &&
    p.name === n
  )
    return true
  if (ts.isJsxAttribute(p) && p.name === n) return true
  if (ts.isBindingElement(p) && p.propertyName === n) return true
  if (ts.isImportSpecifier(p) && p.propertyName === n) return true
  if (ts.isExportSpecifier(p) && p.propertyName === n) return true
  if (
    (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) &&
    p.tagName === n &&
    /^[a-z]/.test(n.text)
  )
    return true
  return false
}

/**
 * The nearest enclosing thing a binding is visible in.
 *
 * Function *type* nodes count, even though they declare nothing at runtime:
 * `onChange: (value: string) => void` sitting next to a `value: string`
 * property is ordinary TypeScript, and treating the whole component as one
 * scope reports it as a clash that cannot happen.
 */
function escopoDe(n) {
  for (let a = n.parent; a; a = a.parent) {
    if (
      ts.isFunctionTypeNode(a) ||
      ts.isConstructorTypeNode(a) ||
      ts.isCallSignatureDeclaration(a) ||
      ts.isMethodSignature(a) ||
      ts.isFunctionDeclaration(a) ||
      ts.isFunctionExpression(a) ||
      ts.isArrowFunction(a) ||
      ts.isMethodDeclaration(a) ||
      ts.isConstructorDeclaration(a) ||
      ts.isSourceFile(a) ||
      ts.isModuleBlock(a) ||
      ts.isClassDeclaration(a)
    )
      return a
  }
  return n.getSourceFile()
}

const arquivos = ROOTS.filter((r) => {
  try {
    return statSync(r).isDirectory()
  } catch {
    return false
  }
}).flatMap((r) => collect(r))

const conflitos = []
for (const arquivo of arquivos) {
  const src = ts.createSourceFile(
    arquivo,
    readFileSync(arquivo, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    arquivo.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const declaracoes = []
  const livres = []
  const visita = (n) => {
    if (ts.isIdentifier(n) && !ehNomeDePropriedade(n)) livres.push(n)
    if (n.name && ts.isIdentifier(n.name) && !ehNomeDePropriedade(n.name)) declaracoes.push(n.name)
    ts.forEachChild(n, visita)
  }
  visita(src)

  for (const d of declaracoes) {
    const novo = mapa[d.text]
    if (!novo || novo === d.text) continue
    const escopo = escopoDe(d)
    const choque = livres.find(
      (u) => u.text === novo && u.getStart() >= escopo.getStart() && u.getEnd() <= escopo.getEnd(),
    )
    if (!choque) continue
    conflitos.push({
      arquivo,
      velho: d.text,
      novo,
      linha: src.getLineAndCharacterOfPosition(d.getStart()).line + 1,
      choque: src.getLineAndCharacterOfPosition(choque.getStart()).line + 1,
    })
  }
}

if (conflitos.length === 0) {
  console.log(`${arquivos.length} files, ${Object.keys(mapa).length} renames: no shadowing.`)
  process.exit(0)
}

console.error(`${conflitos.length} rename(s) would shadow:`)
for (const c of conflitos) {
  console.error(
    `  ${c.velho} → ${c.novo}   ${c.arquivo}:${c.linha}  (clashes with line ${c.choque})`,
  )
}
process.exit(1)
