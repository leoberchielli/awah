import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    // Os testes de integração compartilham Postgres e Redis: rodar em paralelo
    // faria um arquivo derrubar a conexão do outro no teardown.
    fileParallelism: false,
  },
})
