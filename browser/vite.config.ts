import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * The page script, as one classic script the dev server inlines into HTML. Its source map, served
 * by the collector, lists it in `x_google_ignoreList`, so Chrome DevTools keeps showing the app's
 * own line as the source of a console message or request instead of this wrapper.
 */
export default defineConfig({
  root: here,
  build: {
    outDir: '../dist/browser',
    emptyOutDir: true,
    sourcemap: true,
    minify: true,
    lib: { entry: 'client.ts', formats: ['iife'], name: 'qaisdebugsClient', fileName: () => 'client.js' },
    rollupOptions: { output: { sourcemapIgnoreList: () => true } },
  },
});
