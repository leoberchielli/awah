#!/usr/bin/env node
/**
 * Proves the panel's text survives its own background.
 *
 * The dashboard paints slow-drifting fields of colour behind a layer of glass,
 * and the glass is translucent on purpose. That means every colour token is
 * read against a moving ground rather than a flat fill, and the worst spot is
 * not a single field — it is where two of them overlap, which is precisely the
 * place nobody thinks to check by eye.
 *
 * Raising a halo to make the panel less lifeless is a two-line change that can
 * quietly push body text under the legibility threshold. This is what stands
 * between that change and an operator who cannot read a risk score at 3 a.m.
 *
 * Everything is parsed out of `apps/web/src/styles.css`, never copied here: a
 * second list of the same tokens would go stale the first time someone edited
 * one side, and the check would then be proving something that is no longer on
 * screen.
 *
 *   node scripts/contrast-check.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CSS = readFileSync(resolve(RAIZ, 'apps/web/src/styles.css'), 'utf8')

/**
 * Minimum ratio per token.
 *
 * 4.5 is WCAG AA for body text. The series and status colours are strokes and
 * fills — graphic objects, not prose — so 3.0 is the bar that actually applies
 * to them.
 */
const MINIMO = { ink: 4.5, muted: 4.5 }
const MINIMO_PADRAO = 3

/** Tokens that are ink or paint, as opposed to structure. */
const TINTAS = [
  'ink',
  'muted',
  'accent',
  'ok',
  'warn',
  'crit',
  'hold',
  'data-1',
  'data-2',
  'data-3',
  'data-4',
]

// ------------------------------------------------------------------ parsing

/**
 * The declarations of one theme block.
 *
 * The file states each theme three times — bare `:root` for light, the
 * `prefers-color-scheme` media query, and the `[data-theme]` stamp — because
 * the viewer has three states, not two. Reading the media query and the bare
 * root covers both palettes; the `[data-theme]` copies repeat the same values.
 */
function bloco(inicio) {
  const de = CSS.indexOf(inicio)
  if (de < 0) throw new Error(`block not found: ${inicio}`)
  const corpo = CSS.slice(de + inicio.length)
  const ate = corpo.indexOf('\n  }\n') >= 0 ? corpo.indexOf('\n  }\n') : corpo.indexOf('\n}\n')
  return corpo.slice(0, ate)
}

const declaracao = (corpo, nome) => {
  const m = corpo.match(new RegExp(`--${nome}:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

const hex = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16))

/** `12 34 56 / 0.3` — the space-separated form the glass and halo tokens use. */
function rgba(valor) {
  const m = valor.match(/(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)/)
  if (!m) throw new Error(`not an rgb/alpha token: ${valor}`)
  return [[Number(m[1]), Number(m[2]), Number(m[3])], Number(m[4])]
}

function tema(inicio) {
  const corpo = bloco(inicio)
  const pega = (nome) => {
    const v = declaracao(corpo, nome)
    if (!v) throw new Error(`missing token --${nome} in ${inicio}`)
    return v
  }

  const halos = []
  for (let i = 1; ; i++) {
    const v = declaracao(corpo, `halo-${i}`)
    if (!v) break
    halos.push(rgba(v))
  }
  if (halos.length === 0) throw new Error(`no --halo-* in ${inicio}`)

  const tintas = {}
  for (const nome of TINTAS) tintas[nome] = hex(pega(nome))

  return {
    ground: hex(pega('ground')),
    glass: rgba(pega('glass')),
    glassStrong: rgba(pega('glass-strong')),
    halos,
    tintas,
  }
}

// ------------------------------------------------------------------- colour

/** `rgb` painted at `alpha` on top of `under`. */
const sobre = (under, rgb, alpha) => under.map((c, i) => c * (1 - alpha) + rgb[i] * alpha)

const luminancia = (c) => {
  const s = c.map((v) => {
    const n = v / 255
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]
}

const razao = (a, b) => {
  const [alto, baixo] = [luminancia(a), luminancia(b)].sort((x, y) => y - x)
  return (alto + 0.05) / (baixo + 0.05)
}

/**
 * Every ground the text can land on: bare ground, each field alone, and each
 * overlapping pair — all of it then seen through both weights of glass.
 */
function fundos(t) {
  const bases = [{ nome: 'ground', cor: t.ground }]
  t.halos.forEach(([rgb, a], i) => {
    bases.push({ nome: `halo-${i + 1}`, cor: sobre(t.ground, rgb, a) })
  })
  for (let i = 0; i < t.halos.length; i++) {
    for (let j = i + 1; j < t.halos.length; j++) {
      let c = sobre(t.ground, t.halos[i][0], t.halos[i][1])
      c = sobre(c, t.halos[j][0], t.halos[j][1])
      bases.push({ nome: `halo-${i + 1}+${j + 1}`, cor: c })
    }
  }

  return bases.flatMap((b) => [
    { nome: `${b.nome} · card`, cor: sobre(b.cor, ...t.glass) },
    { nome: `${b.nome} · chrome`, cor: sobre(b.cor, ...t.glassStrong) },
  ])
}

// -------------------------------------------------------------------- report

const TEMAS = {
  light: tema(':root {'),
  dark: tema(':root:not([data-theme="light"]) {'),
}

let reprovado = 0
for (const [nomeTema, t] of Object.entries(TEMAS)) {
  console.log(`\n${nomeTema}`)
  for (const [nome, cor] of Object.entries(t.tintas)) {
    const alvo = MINIMO[nome] ?? MINIMO_PADRAO
    let pior = Number.POSITIVE_INFINITY
    let onde = ''
    for (const f of fundos(t)) {
      const r = razao(cor, f.cor)
      if (r < pior) {
        pior = r
        onde = f.nome
      }
    }
    const passa = pior >= alvo
    if (!passa) reprovado++
    console.log(
      `  ${passa ? '✓' : '✗'} ${nome.padEnd(8)} ${pior.toFixed(2)}:1  (min ${alvo.toFixed(1)})  worst at ${onde}`,
    )
  }
}

console.log(
  reprovado === 0
    ? '\nEvery token survives the worst point of the ambient layer.'
    : `\n${reprovado} token(s) below the threshold. Lower the halo, or darken the ink.`,
)
process.exit(reprovado === 0 ? 0 : 1)
