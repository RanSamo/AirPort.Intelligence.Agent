import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['Tests/**/*.test.ts'],
    environment: 'node',
    // Explicit imports rather than globals, so a test file reads like any
    // other module in the project.
    globals: false,
  },
});
