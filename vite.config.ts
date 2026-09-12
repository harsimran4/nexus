import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    target: 'es2022',
    // Keep the artifact one self-contained index.html — the distribution channel
    // is "share one file / host one file". Dynamic chunks must be inlined.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000_000,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
