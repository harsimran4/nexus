import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'

// SPA mode: the Worker never renders React (free-plan 10ms CPU budget);
// the prerendered shell loads, then the client router takes over. Server
// functions + server routes still run in the Worker.
export default defineConfig({
  plugins: process.env.VITEST
    ? [] // pure-helper tests don't need the framework pipeline
    : [cloudflare({ viteEnvironment: { name: 'ssr' } }), tanstackStart({ spa: { enabled: true } }), viteReact()],
  define: {
    __APP_VERSION__: JSON.stringify('0.2.0+' + new Date().toISOString().slice(0, 10)),
  },
})
