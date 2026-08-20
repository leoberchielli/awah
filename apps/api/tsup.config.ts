import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/migrate.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The workspace package ships as TypeScript, so it goes into the bundle.
  noExternal: ['@awah/db'],
  // Native binary: it has to stay external so the .node resolves at runtime.
  external: ['@node-rs/argon2'],
})
