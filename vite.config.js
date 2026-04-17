import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const devPort = Number(process.env.PORT || process.env.VITE_PORT || 3012)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: 'localhost',
    port: devPort,
    strictPort: true,
    hmr: {
      host: 'localhost',
      port: devPort,
      clientPort: devPort,
      protocol: 'ws',
    },
  },
})
