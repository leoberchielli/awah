import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    // The integration tests share one Postgres and one Redis: running them in
    // parallel would have one file tear down another's connection.
    fileParallelism: false,
  },
})
