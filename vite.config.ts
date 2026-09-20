import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  // Bumped every build so update.ts's stale-deploy banner can actually fire
  // (a hand-maintained version string never changed between deploys).
  define: {
    __APP_VERSION__: JSON.stringify(`0.1.0+${new Date().toISOString().slice(0, 16)}`),
  },
  build: {
    target: 'es2022',
    // Keep the artifact one self-contained index.html — the distribution channel
    // is "share one file / host one file". Dynamic chunks must be inlined.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000_000,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
