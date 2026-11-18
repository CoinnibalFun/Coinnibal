import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The web on Vercel talks to the game server on its own origin (VITE_SERVER_URL=https://game.coinnibal.fun):
 * every REST call, the socket, the pictures and the admin backup command use that absolute origin.
 */
describe('VITE_SERVER_URL (web and game server on different origins)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const load = async (url: string) => {
    vi.stubEnv('VITE_SERVER_URL', url);
    vi.resetModules();
    return import('../src/config');
  };

  it('resolves the http base and the wss socket from the https origin', async () => {
    expect((await load('https://game.coinnibal.fun')).SERVER).toEqual({ http: 'https://game.coinnibal.fun', ws: 'wss://game.coinnibal.fun/ws' });
    expect((await load('https://game.coinnibal.fun/')).SERVER).toEqual({ http: 'https://game.coinnibal.fun', ws: 'wss://game.coinnibal.fun/ws' });
    expect((await load('wss://game.coinnibal.fun')).SERVER).toEqual({ http: 'https://game.coinnibal.fun', ws: 'wss://game.coinnibal.fun/ws' });
  });

  it('sends admin calls to the game server with the bearer token, and builds the backup command for it', async () => {
    vi.stubEnv('VITE_SERVER_URL', 'https://game.coinnibal.fun');
    vi.resetModules();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ address: '0xabc', admin: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { adminApi } = await import('../src/site/api');
    const api = adminApi('tok.en');
    await api.me();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://game.coinnibal.fun/api/admin/me');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok.en');
    expect(api.backupCommand('pr00f')).toBe(
      "curl -fsS -H 'Authorization: Bearer tok.en' -H 'X-Coinnibal-Proof: pr00f' 'https://game.coinnibal.fun/api/admin/backup' -o coinnibal-backup.tar.gz",
    );
    expect(api.installCommand('pr00f')).toMatch(/install\.sh --yes --from 'https:\/\/game\.coinnibal\.fun' --token 'tok\.en' --proof 'pr00f'$/);
  });

  it('loads profile pictures from the game server', async () => {
    vi.stubEnv('VITE_SERVER_URL', 'https://game.coinnibal.fun');
    vi.resetModules();
    const { AvatarCache } = await import('../src/render/avatars');
    const cache = new AvatarCache() as unknown as { urlOf: (id: string) => string };
    expect(cache.urlOf('abc')).toMatch(/^https:\/\/game\.coinnibal\.fun\/api\/avatar\//);
  });

  it('quotes a token safely in the shell command', async () => {
    const { backupCurlCommand } = await import('../src/site/api');
    expect(backupCurlCommand('https://game.coinnibal.fun/', "a'b", 'p')).toBe(
      "curl -fsS -H 'Authorization: Bearer a'\\''b' -H 'X-Coinnibal-Proof: p' 'https://game.coinnibal.fun/api/admin/backup' -o coinnibal-backup.tar.gz",
    );
  });
});
