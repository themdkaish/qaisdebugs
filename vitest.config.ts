import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['agent/**/*.test.ts', 'browser/**/*.test.ts', 'mcp/**/*.test.ts', 'ui/src/**/*.test.ts', 'server/**/*.test.mjs'],
    environment: 'node',
  },
});
