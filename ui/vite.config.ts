import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The app is served from the Tauri bundle, never from a web origin, so the
// build stays relative and ships no source maps.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  server: { port: 5178, strictPort: true },
  clearScreen: false,
})
