import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['server/**', 'extension/**'],
      exclude: ['**/*.test.js', 'tests/**', 'extension/dashboard/dist/**'],
    },
  },
});
