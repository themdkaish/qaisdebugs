import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * The MCP server, as one Node module. Its dependencies (source-map-js) are bundled in, so the
 * published package keeps no runtime dependencies.
 */
export default defineConfig({
  root: here,
  build: {
    outDir: '../dist/mcp',
    emptyOutDir: true,
    ssr: 'server.ts',
    target: 'node20',
    minify: false,
    sourcemap: true,
    rollupOptions: { output: { entryFileNames: 'server.js', format: 'es' } },
  },
  ssr: { noExternal: true },
});
