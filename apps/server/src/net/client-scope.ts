import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The client (its `rateKey`: an IPv4 address, an IPv6 /64) a request or a WebSocket message is handled for. Work it
 * triggers deep down (a holder check's `balanceOf`) counts against that client's own budget there, without every
 * layer in between passing the key on. Null for the server's own work (timers, the chain worker).
 */
const scope = new AsyncLocalStorage<string>();

/** Runs `fn` on behalf of client `key` (also its async continuations). */
export function asClient<T>(key: string, fn: () => T): T {
  return scope.run(key, fn);
}

/** The client the current request or message is handled for; null for the server's own work. */
export function currentClient(): string | null {
  return scope.getStore() ?? null;
}
