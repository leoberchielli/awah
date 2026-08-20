#!/usr/bin/env node
/**
 * Proves every colour in the panel is legible on the surface it lands on.
 *
 * The dashboard paints text in four places that have nothing to do with each
 * other: ink on the light content surfaces, ink on the dark navigation bar,
 * white on the solid headline tiles, and series colours on chart backgrounds.
 * Each has its own pairing, and each is one careless token away from being
 * unreadable — a tile fill nudged two shades lighter to look friendlier takes
 * the white number down with it, and nothing else in the build would notice.
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

/*
 * 4.5 is WCAG AA for body text. Series and status colours are strokes and
 * fills — graphic objects rather than prose — so 3.0 is the bar that actually
 * applies to them. `on-fill` is a number read at a glance from across a room,
 * so it is held to the text bar even though it is large.
 */
const TEXTO = 4.5
const GRAFICO = 3

// -------------------------------------------------------------------- parsing

/**
 * Reads one declaration out of a block that starts at `inicio`.
 *
 * The file states each theme three times — bare `:root` for light, the
 * `prefers-color-scheme` query, and the `[data-theme]` stamp — because the
 * viewer has three states, not two. Light and the media query cover both
 * palettes; the third block repeats the second.
 */
function bloco(inicio) {
  const de = CSS.indexOf(inicio)
  if (de < 0) throw new Error(`block not found: ${inicio}`)
  const corpo = CSS.slice(de + inicio.length)
  const fecha = corpo.search(/\n\s*\}\n/)
  return corpo.slice(0, fecha)
}

function declaracao(corpo, nome) {
  const m = corpo.match(new RegExp(`--${nome}:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

const hex = (h) => {
  const m = h.match(/^#([0-9a-f]{6})$/i)
  if (!m) throw new Error(`not a six-digit hex colour: ${h}`)
  return [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16))
}

/** Every `--fill-*`, wherever in the file it is declared. */
function preenchimentos() {
  const saida = {}
  for (const m of CSS.matchAll(/--fill-([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)) {
    saida[`fill-${m[1]}`] = hex(m[2])
  }
  if (Object.keys(saida).length === 0) throw new Error('no --fill-* tokens found')
  return saida
}

function tema(inicio) {
  const corpo = bloco(inicio)
  const pega = (nome) => {
    const v = declaracao(corpo, nome)
    if (!v) throw new Error(`missing token --${nome} in ${inicio}`)
    return hex(v)
  }
  return {
    ground: pega('ground'),
    surface: pega('surface'),
    surface2: pega('surface-2'),
    nav: pega('nav'),
    nav2: pega('nav-2'),
    tintas: {
      ink: pega('ink'),
      muted: pega('muted'),
      accent: pega('accent'),
      ok: pega('ok'),
      warn: pega('warn'),
      crit: pega('crit'),
      hold: pega('hold'),
      'data-1': pega('data-1'),
      'data-2': pega('data-2'),
      'data-3': pega('data-3'),
      'data-4': pega('data-4'),
    },
    navTintas: {
      'nav-ink': pega('nav-ink'),
      'nav-ink-strong': pega('nav-ink-strong'),
    },
    onFill: pega('on-fill'),
  }
}

// --------------------------------------------------------------------- colour

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

// --------------------------------------------------------------------- report

const FILLS = preenchimentos()
const TEMAS = { light: tema(':root {'), dark: tema(':root:not([data-theme="light"]) {') }

/** Every pairing that actually happens on screen. */
function pares(t) {
  const saida = []

  // Ink on the content surfaces.
  for (const [nome, cor] of Object.entries(t.tintas)) {
    const alvo = nome === 'ink' || nome === 'muted' ? TEXTO : GRAFICO
    for (const [ondeNome, onde] of [
      ['surface', t.surface],
      ['ground', t.ground],
      ['surface-2', t.surface2],
    ]) {
      saida.push({ tinta: nome, sobre: ondeNome, cor, fundo: onde, alvo })
    }
  }

  // Ink on the navigation bar, which is dark in both themes.
  for (const [nome, cor] of Object.entries(t.navTintas)) {
    for (const [ondeNome, onde] of [
      ['nav', t.nav],
      ['nav-2', t.nav2],
    ]) {
      saida.push({ tinta: nome, sobre: ondeNome, cor, fundo: onde, alvo: TEXTO })
    }
  }

  // White on every solid fill: the headline tiles and the primary controls.
  for (const [nome, fundo] of Object.entries(FILLS)) {
    saida.push({ tinta: 'on-fill', sobre: nome, cor: t.onFill, fundo, alvo: TEXTO })
  }

  return saida
}

let reprovado = 0
for (const [nomeTema, t] of Object.entries(TEMAS)) {
  console.log(`\n${nomeTema}`)

  // One line per ink, reporting only the surface it does worst on.
  const pior = new Map()
  for (const p of pares(t)) {
    const r = razao(p.cor, p.fundo)
    const atual = pior.get(p.tinta)
    if (!atual || r < atual.r) pior.set(p.tinta, { r, sobre: p.sobre, alvo: p.alvo })
  }

  for (const [tinta, { r, sobre, alvo }] of pior) {
    const passa = r >= alvo
    if (!passa) reprovado++
    console.log(
      `  ${passa ? '✓' : '✗'} ${tinta.padEnd(14)} ${r.toFixed(2)}:1  (min ${alvo.toFixed(1)})  worst on ${sobre}`,
    )
  }
}

console.log(
  reprovado === 0
    ? '\nEvery colour is legible on every surface it lands on.'
    : `\n${reprovado} pairing(s) below the threshold. Darken the fill, or lighten the ink.`,
)
process.exit(reprovado === 0 ? 0 : 1)
