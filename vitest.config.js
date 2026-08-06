import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/tests/**/*.test.js'],
    // os arquivos de teste compartilham a database nfse_emissor_test — não podem rodar em paralelo
    fileParallelism: false,
    testTimeout: 15000,
  },
});
