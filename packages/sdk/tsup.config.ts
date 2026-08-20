import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  // Runs in Node, in a worker and in the browser: the client uses only fetch and WebCrypto.
  platform: 'neutral',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
})
