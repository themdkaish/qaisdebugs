import react from '@vitejs/plugin-react';
import autoprefixer from 'autoprefixer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';

const collector = 'http://127.0.0.1:4983';
const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  css: {
    // Explicit paths: `vite build --config ui/vite.config.ts` runs from the project root, where
    // Tailwind and PostCSS would otherwise look for their config files and find nothing.
    postcss: {
      plugins: [tailwindcss({ config: path.join(here, 'tailwind.config.js') }), autoprefixer()],
    },
  },
  build: { outDir: '../dist/ui', emptyOutDir: true, sourcemap: false },
  server: {
    port: 4984,
    strictPort: true,
    // The UI imports the agent's event types (type-only) from outside its root.
    fs: { allow: ['..'] },
    proxy: {
      '/ingest': collector,
      '/events': collector,
      '/snippet': collector,
      '/clear': collector,
      '/health': collector,
    },
  },
});
