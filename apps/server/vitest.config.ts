import { configDefaults, defineConfig } from 'vitest/config';

// Suites that run on their own (`pnpm check` runs each right after `pnpm test`), never next to the rest:
// - the money simulation keeps every core busy for a while (`pnpm test:money`);
// - the room-worker suite starts worker threads that compile TypeScript on boot and waits on them with timeouts
//   (`pnpm test:workers`, together with the WebSocket suite on two workers).
const alone = [
  ...(process.env.ELYMUM_MONEY_SIM === '1' ? [] : ['test/money-conservation.test.ts']),
  ...(process.env.TEST_GAME_WORKERS ? [] : ['test/workers.test.ts']),
];

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...alone],
  },
});
