/*
 * Regenerates assets/og.png from assets/og.svg.
 *
 *   npm i sharp
 *   node site/make-og.mjs
 *
 * The PNG is what link unfurlers read — most of them reject SVG. The SVG is
 * the source: edit it, run this, and the PNG matches the page again.
 *
 * It needs the IBM Plex fonts installed on the system; without them the
 * rasteriser falls back to a default face and the image ships in the wrong
 * letter. With no dependency at all: open og.html in a browser, capture 1200×630.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))

await sharp(join(here, 'assets/og.svg'), { density: 96 })
  .resize(1200, 630)
  .png({ compressionLevel: 9 })
  .toFile(join(here, 'assets/og.png'))

console.log('assets/og.png regenerated (1200×630)')
