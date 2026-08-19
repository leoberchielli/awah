import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  // Roda em Node, em worker e no navegador: o cliente usa só fetch e WebCrypto.
  platform: 'neutral',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
})
