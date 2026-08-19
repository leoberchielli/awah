import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/migrate.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // O pacote do workspace é distribuído como TypeScript, então entra no bundle.
  noExternal: ['@awah/db'],
  // Binário nativo: precisa continuar externo para resolver o .node em runtime.
  external: ['@node-rs/argon2'],
})
