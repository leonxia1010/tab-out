import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['server/**', 'extension/**', 'dashboard/src/**'],
      exclude: ['**/*.test.js', 'tests/**', 'dashboard/dist/**'],
    },
  },
});
