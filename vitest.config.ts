import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/**/tests/**/*.test.ts',
      'workers/**/tests/**/*.test.ts',
      'src/**/tests/**/*.test.ts',
    ],
    globals: false,
  },
});
