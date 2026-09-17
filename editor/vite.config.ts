import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Everything the app imports at runtime, so the dev server pre-bundles each one
// into a single file instead of discovering them lazily (a late discovery forces
// a re-optimize and a full page reload).
const RUNTIME_DEPS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'radix-ui',
  'cmdk',
  'exceljs',
  'js-yaml',
  'lucide-react',
  'class-variance-authority',
  'clsx',
  'tailwind-merge',
  'vaul',
  '@tauri-apps/api/core',
]

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Remote/containerised dev environments reach the dev server through a
    // proxy hostname, which Vite blocks by default.
    allowedHosts: true,
    // Transform the entry graph while the server boots, so the first page load
    // is served from a warm module graph instead of paying a transform per
    // request.
    warmup: {
      clientFiles: ['./src/main.tsx'],
    },
  },
  optimizeDeps: {
    include: RUNTIME_DEPS,
    // The app only imports what it needs, but a new import in a rarely used
    // file should not trigger a mid-session re-bundle.
    holdUntilCrawlEnd: false,
  },
})
