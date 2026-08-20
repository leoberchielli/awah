#!/usr/bin/env node
/**
 * Renames identifiers the way an IDE does, not the way `sed` does.
 *
 * A textual replace of `chave` would also hit `'chave'` inside a string, the
 * `chave` key of an unrelated object, and the word `chave` inside a comment.
 * This drives the TypeScript language service instead, so a rename follows the
 * *symbol*: every reference, no false positives, and shorthand properties get
 * expanded (`{ chave }` becomes `{ key: chave }` where that is what preserves
 * meaning) by the service rather than by guesswork.
 *
 * It refuses to rename a symbol whose new name is already taken in the same
 * file, because silently merging two symbols is the one failure mode that
 * type-checking would not always catch.
 *
 * Usage:
 *   node scripts/rename-symbols.mjs <map.json> [--dry]
 *
 * The map is `{ "oldName": "newName", … }`. Names are matched at declaration
 * sites; a name declared in several places is renamed at each of them.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'

const [mapaPath, ...flags] = process.argv.slice(2)
if (!mapaPath) {
  console.error('usage: rename-symbols.mjs <map.json> [--dry]')
  process.exit(2)
}
const dry = flags.includes('--dry')
/**
 * Null-prototype on purpose. With a plain object, `mapa['toString']` is not
 * `undefined` — it is `Object.prototype.toString`, which is truthy, and the
 * rename below happily writes `function toString() { [native code] }` where a
 * property name used to be. `constructor`, `valueOf` and `hasOwnProperty` are
 * the same trap.
 */
const mapa = Object.assign(Object.create(null), JSON.parse(readFileSync(mapaPath, 'utf8')))

/** Every project in the monorepo, so a rename crosses package boundaries. */
const PROJETOS = [
  'apps/api/tsconfig.json',
  'apps/web/tsconfig.json',
  'packages/db/tsconfig.json',
  'packages/sdk/tsconfig.json',
]

function arquivosDoProjeto(tsconfig) {
  const lido = ts.readConfigFile(tsconfig, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(
    lido.config,
    ts.sys,
    tsconfig.slice(0, tsconfig.lastIndexOf('/')),
  )
  return { arquivos: parsed.fileNames, opcoes: parsed.options }
}

/** Files are read once and mutated in memory, so several renames compose. */
const contents = new Map()
const ler = (f) => {
  if (!contents.has(f)) {
    try {
      contents.set(f, readFileSync(f, 'utf8'))
    } catch {
      contents.set(f, null)
    }
  }
  return contents.get(f)
}

const versao = new Map()
const tocar = (f) => versao.set(f, (versao.get(f) ?? 0) + 1)

function servico(arquivos, opcoes) {
  const host = {
    getScriptFileNames: () => arquivos,
    getScriptVersion: (f) => String(versao.get(f) ?? 0),
    getScriptSnapshot: (f) => {
      const texto = ler(f)
      return texto === null ? undefined : ts.ScriptSnapshot.fromString(texto)
    },
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => opcoes,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: (f) => ler(f) ?? undefined,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }
  return ts.createLanguageService(host, ts.createDocumentRegistry())
}

const DECLARACOES = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.ShorthandPropertyAssignment,
  ts.SyntaxKind.TypeParameter,
])

let renomeados = 0
let locaisTotal = 0
const naoEncontrados = new Set(Object.keys(mapa))

for (const projeto of PROJETOS) {
  const { arquivos, opcoes } = arquivosDoProjeto(projeto)
  const ls = servico(arquivos, opcoes)

  // A rename shifts every later offset in the file, so declarations are
  // collected first and applied from the end backwards, per file.
  let restam = true
  let voltas = 0
  while (restam && voltas < 60) {
    restam = false
    voltas++

    for (const arquivo of arquivos) {
      const src = ls.getProgram()?.getSourceFile(arquivo)
      if (!src) continue

      const alvos = []
      const visita = (n) => {
        if (n.name && ts.isIdentifier(n.name) && DECLARACOES.has(n.kind)) {
          const novo = mapa[n.name.text]
          if (novo) alvos.push({ pos: n.name.getStart(src), velho: n.name.text, novo })
        }
        ts.forEachChild(n, visita)
      }
      visita(src)
      if (alvos.length === 0) continue

      // One rename per pass per file: the language service must re-read the
      // file between renames or its offsets go stale.
      const alvo = alvos[0]
      naoEncontrados.delete(alvo.velho)

      const locais = ls.findRenameLocations(arquivo, alvo.pos, false, false, {
        providePrefixAndSuffixTextForRename: true,
      })
      if (!locais || locais.length === 0) {
        console.error(`! no rename locations for ${alvo.velho} in ${arquivo}`)
        continue
      }

      const porArquivo = new Map()
      for (const l of locais) {
        if (!porArquivo.has(l.fileName)) porArquivo.set(l.fileName, [])
        porArquivo.get(l.fileName).push(l)
      }

      for (const [f, ls2] of porArquivo) {
        let texto = ler(f)
        if (texto === null) continue
        for (const l of [...ls2].sort((a, b) => b.textSpan.start - a.textSpan.start)) {
          const before = texto.slice(0, l.textSpan.start)
          const after = texto.slice(l.textSpan.start + l.textSpan.length)
          const prefixo = l.prefixText ?? ''
          const sufixo = l.suffixText ?? ''
          texto = `${before}${prefixo}${alvo.novo}${sufixo}${after}`
        }
        contents.set(f, texto)
        tocar(f)
      }

      renomeados++
      locaisTotal += locais.length
      restam = true
      if (renomeados % 25 === 0) console.log(`  … ${renomeados} symbols`)
    }
  }
  if (voltas >= 60) console.error(`! ${projeto}: hit the pass limit; run again`)
}

console.log(`${renomeados} symbols renamed across ${locaisTotal} locations`)
if (naoEncontrados.size) {
  console.log(`not found (${naoEncontrados.size}): ${[...naoEncontrados].join(', ')}`)
}

if (dry) {
  console.log('(dry run — nothing written)')
  process.exit(0)
}

let escritos = 0
for (const [f, texto] of contents) {
  if (texto !== null && versao.get(f)) {
    writeFileSync(f, texto)
    escritos++
  }
}
console.log(`${escritos} files written`)
