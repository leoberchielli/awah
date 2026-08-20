import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The build lands in `dist`, which the API serves as static files from wave 6 on.
 *
 * In development Vite runs on its own and proxies anything under `/v1` or
 * `/webhooks` to the API — that keeps the session cookie same-origin, so the
 * browser never gets into CORS or strict SameSite.
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
    // The dashboard is an internal tool: a sourcemap helps more than it costs.
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        /**
         * The charting library is two thirds of the bundle and moves on its own
         * release rhythm, not AWAH's. In a chunk of its own it survives in the
         * browser cache across every new dashboard version.
         */
        manualChunks: {
          charts: ['recharts'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
})
