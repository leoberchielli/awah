import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * O build sai em `dist`, que a API serve como estático a partir da onda 6.
 *
 * Em desenvolvimento o Vite roda sozinho e faz proxy do que for `/v1` ou
 * `/webhooks` para a API — assim o cookie de sessão continua sendo de mesma
 * origem e o navegador não entra em CORS nem em SameSite estrito.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 2891,
    proxy: {
      '/v1': 'http://localhost:2900',
      '/metrics': 'http://localhost:2900',
      '/docs': 'http://localhost:2900',
    },
  },
  build: {
    outDir: 'dist',
    // O dashboard é ferramenta interna: sourcemap ajuda mais que economiza.
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        /**
         * A biblioteca de gráficos é dois terços do bundle e muda em ritmo de
         * release dela, não do AWAH. Em pedaço próprio, ela sobrevive no cache do
         * navegador a cada versão nova do dashboard.
         */
        manualChunks: {
          graficos: ['recharts'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
})
