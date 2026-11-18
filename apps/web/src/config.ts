/**
 * Where the game server lives. Same origin by default (Vite dev proxies /ws and /api; the Docker image serves the
 * client itself). On a separate static host the browser talks to the game server DIRECTLY, for the API as well as
 * the WebSocket (`VITE_SERVER_URL`, or the origin of `VITE_WS_URL`): requests through the host's proxy would all
 * arrive from the host's few addresses, so the server's per-IP limits could not tell players apart. Such a
 * host would proxy only what must live on the site's own domain (the NFT metadata, the share cards).
 */
export function resolveServer(env: { server?: string; ws?: string }, loc: { protocol: string; host: string }): { http: string; ws: string } {
  const direct = env.server || env.ws;
  if (direct) {
    const http = direct.replace(/\/+$/, '').replace(/\/ws$/, '').replace(/^ws/, 'http');
    return { http, ws: `${http.replace(/^http/, 'ws')}/ws` };
  }
  const http = `${loc.protocol}//${loc.host}`;
  return { http, ws: `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws` };
}

export const SERVER = resolveServer(
  { server: import.meta.env.VITE_SERVER_URL as string | undefined, ws: import.meta.env.VITE_WS_URL as string | undefined },
  window.location,
);

/** Optional client-side overrides for the chain settings the server advertises. */
export const CHAIN_OVERRIDES = {
  rpcUrl: (import.meta.env.VITE_RPC_URL as string | undefined) || null,
};

export const APP_VERSION = '0.1.0';
