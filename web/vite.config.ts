import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The browser only talks to this dev server; it forwards /studio to the Mastra server and adds the
// per-run token (run.sh sets XMS_TOKEN), so the token never reaches the page.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.XMS_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/studio': {
        target: `http://127.0.0.1:${process.env.XMS_SERVER_PORT ?? 4111}`,
        headers: { 'X-Studio-Token': process.env.XMS_TOKEN ?? '' },
      },
    },
  },
})
