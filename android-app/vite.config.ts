import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [svelte()],
  server: {
    fs: {
      allow: [fileURLToPath(new URL('.', import.meta.url))],
    },
  },
})
