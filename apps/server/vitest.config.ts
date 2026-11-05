import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // the money simulation keeps every core busy for a while: it runs on its own (`pnpm test:money`), never next
    // to the timing-sensitive WebSocket and room-worker suites
    exclude: [...configDefaults.exclude, process.env.ELYMUM_MONEY_SIM === '1' ? '' : 'test/money-conservation.test.ts'].filter(Boolean),
  },
});
