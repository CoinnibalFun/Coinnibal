import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { loadConfig } from '../src/config';
import { Limiter } from '../src/net/limiter';
import { backupFileName } from '../src/site/backup';
import { ArenaChain, arena } from './helpers';
import { testSigner } from './signers';

describe('GET /api/admin/backup', () => {
  let app: App;
  let port: number;
  let dir: string;
  const signer = testSigner();
  const admin = signer.address;
  const logs: string[] = [];
  let cfgSecret: Buffer = Buffer.alloc(0);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'coinnibal-backup-'));
    writeFileSync(join(dir, 'marker.txt'), 'known contents 42\n');
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_WALLETS: admin, TRUST_PROXY: '0', CORS_ORIGIN: 'https://coinnibal.fun' } as NodeJS.ProcessEnv);
    cfgSecret = cfg.authSecret;
    app = await createApp(cfg, {
      chain: new ArenaChain([arena(1, 1000)]),
      log: (m) => logs.push(m),
      persist: true,
      siteLimits: { writeIp: new Limiter(10_000, 60_000), writeWallet: new Limiter(10_000, 60_000), login: new Limiter(10_000, 60_000) },
      apiLimiter: new Limiter(10_000, 60_000),
    });
    port = await app.listen();
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (token?: string, proof?: string) =>
    fetch(`http://127.0.0.1:${port}/api/admin/backup`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(proof ? { 'X-Coinnibal-Proof': proof } : {}) } });
  /** A fresh, purpose-bound signature of the admin wallet (what the admin panel asks the wallet for). */
  const proofFor = async (token: string, purpose = 'backup', by = signer) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/admin/secret-proof`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose }) });
    expect(r.status).toBe(200);
    const { message } = (await r.json()) as { message: string };
    return Buffer.from(JSON.stringify({ message, signature: await by.sign(message) })).toString('base64url');
  };

  it('needs a fresh signature of the admin wallet, once, for that purpose; every try is in the audit log', async () => {
    const token = app.auth.issueToken(admin);
    // the session token alone (what sits in the browser) is not enough
    const bare = await get(token);
    expect(bare.status).toBe(401);
    expect(((await bare.json()) as { error: string }).error).toBe('proof_required');
    // a signature by another wallet is refused
    expect((await get(token, await proofFor(token, 'backup', testSigner()))).status).toBe(401);
    // a good proof opens it once
    const proof = await proofFor(token);
    const ok = await get(token, proof);
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
    expect((await get(token, proof)).status).toBe(401);
    // a player-length (24 h) token of the admin wallet is not an admin session
    const long = `${admin}.${Date.now() + 23 * 3600_000}`;
    const legacy = `${long}.${createHmac('sha256', cfgSecret).update(long).digest('base64url')}`;
    expect(app.auth.verifyToken(legacy)).toBe(admin);
    expect((await get(legacy)).status).toBe(401);
    const entries = app.site.audit.recent(100).filter((e) => e.path === '/api/admin/backup');
    expect(entries.map((e) => e.status)).toEqual(expect.arrayContaining([401, 200]));
    expect(entries.every((e) => e.method === 'GET' && e.wallet === admin)).toBe(true);
  });

  it('refuses without a session (401) and for a non-admin wallet (403)', async () => {
    expect((await get()).status).toBe(401);
    expect((await get(app.auth.issueToken(testSigner().address))).status).toBe(403);
    expect((await get('not-a-token')).status).toBe(401);
  });

  it('streams a valid tar.gz of DATA_DIR to the admin, logs the wallet but not the contents', async () => {
    // an unsaved profile change is flushed into the snapshot
    app.profiles.recordGame(admin, { score: 10, kills: 1, xp: 5 });
    const token = app.auth.issueToken(admin);
    const res = await get(token, await proofFor(token));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="coinnibal-data-31337-\d{8}-\d{6}\.tar\.gz"$/);
    const gz = Buffer.from(await res.arrayBuffer());
    const tarBytes = gunzipSync(gz); // throws on a corrupt or truncated gzip
    expect(tarBytes.length).toBeGreaterThan(512);
    const out = mkdtempSync(join(tmpdir(), 'coinnibal-backup-out-'));
    const file = join(out, 'b.tar.gz');
    writeFileSync(file, gz);
    const list = spawnSync('tar', ['tzf', file], { encoding: 'utf8' });
    expect(list.status).toBe(0);
    const names = list.stdout.split('\n');
    expect(names).toContain('./marker.txt');
    expect(names.some((n) => n.startsWith('./profiles'))).toBe(true);
    const cat = spawnSync('tar', ['xzOf', file, './marker.txt'], { encoding: 'utf8' });
    expect(cat.stdout).toBe('known contents 42\n');
    const lines = logs.filter((l) => l.startsWith('backup:'));
    expect(lines.some((l) => l.includes(admin) && l.includes('sent to'))).toBe(true);
    expect(lines.join('\n')).not.toContain('known contents');
  });

  it('answers the CORS preflight of the web origin with the Authorization header allowed', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/backup`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://coinnibal.fun', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://coinnibal.fun');
    expect(res.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
  });

  it('is rate-limited per admin wallet', async () => {
    const token = app.auth.issueToken(admin);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await get(token, await proofFor(token));
      await r.arrayBuffer();
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
  });

  it('names the file after the chain and the UTC time', () => {
    expect(backupFileName(46630, Date.UTC(2026, 10, 4, 3, 5, 9))).toBe('coinnibal-data-46630-20261104-030509.tar.gz');
    expect(backupFileName(null, Date.UTC(2026, 0, 1))).toBe('coinnibal-data-nochain-20260101-000000.tar.gz');
  });
});

describe('secret exports on the mainnet', () => {
  it('are off unless ADMIN_SECRET_EXPORT=1', async () => {
    const signer = testSigner();
    const base = { PORT: '0', HOST: '127.0.0.1', ADMIN_WALLETS: signer.address, TRUST_PROXY: '0', CHAIN_ID: '4663', AUTH_SECRET: 'x'.repeat(64) };
    for (const [flag, want] of [[undefined, 403], ['1', 200]] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'coinnibal-backup-main-'));
      const cfg = loadConfig({ ...base, DATA_DIR: dir, ...(flag ? { ADMIN_SECRET_EXPORT: flag } : {}) } as NodeJS.ProcessEnv);
      const app = await createApp(cfg, { chain: new ArenaChain([arena(1, 1000)]), chainId: 4663, log: () => {}, persist: true, apiLimiter: new Limiter(10_000, 60_000) });
      const port = await app.listen();
      try {
        const token = app.auth.issueToken(signer.address);
        const r = await fetch(`http://127.0.0.1:${port}/api/admin/secret-proof`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'migration' }) });
        expect(r.status).toBe(want);
        if (want === 200) {
          const { message } = (await r.json()) as { message: string };
          expect(message).toMatch(/Purpose: migration/);
          const proof = Buffer.from(JSON.stringify({ message, signature: await signer.sign(message) })).toString('base64url');
          const headers = { Authorization: `Bearer ${token}`, 'X-Coinnibal-Proof': proof };
          // one proof of purpose "migration": the settings once and the backup once
          expect((await fetch(`http://127.0.0.1:${port}/api/admin/migration-env`, { headers })).status).toBe(200);
          expect((await fetch(`http://127.0.0.1:${port}/api/admin/migration-env`, { headers })).status).toBe(401);
          const b = await fetch(`http://127.0.0.1:${port}/api/admin/backup`, { headers });
          expect(b.status).toBe(200);
          await b.arrayBuffer();
        } else {
          expect((await fetch(`http://127.0.0.1:${port}/api/admin/backup`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
        }
      } finally {
        await app.close();
      }
    }
  });
});

describe('the proof header of before the rename', () => {
  it('reads the proof from X-Elymum-Proof when X-Coinnibal-Proof is absent (a script copied before the rename), same rules', async () => {
    const signer = testSigner();
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-backup-old-'));
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_WALLETS: signer.address, TRUST_PROXY: '0', CORS_ORIGIN: 'https://coinnibal.fun' } as NodeJS.ProcessEnv);
    const app = await createApp(cfg, { chain: new ArenaChain([arena(1, 1000)]), log: () => {}, persist: true, apiLimiter: new Limiter(10_000, 60_000) });
    try {
      const port = await app.listen();
      const token = app.auth.issueToken(signer.address);
      const r = await fetch(`http://127.0.0.1:${port}/api/admin/secret-proof`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'backup' }) });
      const { message } = (await r.json()) as { message: string };
      const proof = Buffer.from(JSON.stringify({ message, signature: await signer.sign(message) })).toString('base64url');
      const viaOld = () => fetch(`http://127.0.0.1:${port}/api/admin/backup`, { headers: { Authorization: `Bearer ${token}`, 'X-Elymum-Proof': proof } });
      const ok = await viaOld();
      expect(ok.status).toBe(200);
      await ok.arrayBuffer();
      // used once, like a proof in the new header
      expect((await viaOld()).status).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('admin sessions', () => {
  it('are short, not extended by a refresh, and revocable', async () => {
    const { Auth, ADMIN_TOKEN_TTL_MS, TOKEN_TTL_MS } = await import('../src/auth');
    const admin = testSigner().address;
    const player = testSigner().address;
    const auth = new Auth(Buffer.alloc(32, 7), { isAdmin: (w) => w === admin });
    const t0 = 1_800_000_000_000;
    const a = auth.issueToken(admin, t0);
    expect(auth.verifyAdminToken(a, t0 + ADMIN_TOKEN_TTL_MS - 1)).toBe(admin);
    expect(auth.verifyAdminToken(a, t0 + ADMIN_TOKEN_TTL_MS + 1)).toBeNull();
    // the WebSocket refresh hands an admin the same token (no sliding session); a player gets a new 24 h one
    expect(auth.refreshToken(a, t0 + 1000)).toBe(a);
    const p = auth.issueToken(player, t0);
    expect(auth.verifyToken(p, t0 + TOKEN_TTL_MS - 1)).toBe(player);
    expect(auth.verifyAdminToken(p, t0)).toBeNull();
    expect(auth.refreshToken(p, t0 + 1000)).not.toBe(p);
    // revoking every admin session ends this one; a new sign-in works; players are untouched
    auth.revoke(null, t0 + 10);
    expect(auth.verifyAdminToken(a, t0 + 20)).toBeNull();
    expect(auth.verifyToken(a, t0 + 20)).toBeNull();
    expect(auth.verifyAdminToken(auth.issueToken(admin, t0 + 30), t0 + 40)).toBe(admin);
    expect(auth.verifyToken(p, t0 + 20)).toBe(player);
    auth.revoke(player, t0 + 50);
    expect(auth.verifyToken(p, t0 + 60)).toBeNull();
  });
});

describe('migrationEnv', () => {
  it('keeps the settings a moved server needs and drops the host-specific ones', async () => {
    const { migrationEnv } = await import('../src/site/backup');
    const out = migrationEnv({
      ADMIN_WALLETS: '0xabc',
      AUTH_SECRET: 's3cret',
      SERVER_PRIVATE_KEY: 'auto',
      EVM_RPC_URL: 'https://rpc.example',
      PORT: '10000',
      DATA_DIR: '/data',
      TRUST_PROXY_HOPS: '1',
      CORS_ORIGIN: '*',
      PATH: '/usr/bin',
      RENDER_SERVICE_ID: 'srv-x',
      PUBLIC_URL: 'https://coinnibal.fun',
      EXPLORER_URL: 'bad\nINJECT=1',
      CHAIN_NAME: 'Retired',
      GAME_ACCESS: 'admins',
      STAKE_ENABLED: 'false',
      // the VPS app reads the whole .env (env_file), the site's contract pins included: they never leave the server
      COINNIBAL_PIN_ARENA: '0x1111111111111111111111111111111111111111',
      VITE_ARENA_ADDRESS: '0x1111111111111111111111111111111111111111',
      // Caddy's config, from the same .env: a server behind Cloudflare comes up behind it on the new host too (OPS-R3-2)
      CADDY_CONFIG: 'Caddyfile.cloudflare',
    });
    expect(out).toEqual({
      ADMIN_WALLETS: '0xabc',
      AUTH_SECRET: 's3cret',
      SERVER_PRIVATE_KEY: 'auto',
      EVM_RPC_URL: 'https://rpc.example',
      PUBLIC_URL: 'https://coinnibal.fun',
      CADDY_CONFIG: 'Caddyfile.cloudflare',
    });
  });

  it('install.sh --from never writes a contract pin, whatever the old server answers', () => {
    // a broken-into old server could answer with its own pins: the new build must trust only what the owner sets in the
    // VPS shell (deploy/vps/install.sh, the import loop of --from, run here with env_set printing what it would write)
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const lines = readFileSync(join(repoRoot, 'deploy/vps/install.sh'), 'utf8').split('\n');
    const start = lines.findIndex((l) => /^\s*while IFS=\$'\\t' read -r k v; do\s*$/.test(l));
    const end = lines.findIndex((l, i) => i > start && /^\s*done < <\(/.test(l));
    expect(start, 'the import loop of install.sh --from').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const script = ['env_set() { printf \'%s=%s\\n\' "$1" "$2"; }', 'old_single_rpc=""', 'have_rpc_list=0', ...lines.slice(start, end), 'done'].join('\n');
    const pin = '0x2222222222222222222222222222222222222222';
    const answer = [
      ['ADMIN_WALLETS', '0xabc'],
      ['CHAIN_ID', '46630'],
      ['COINNIBAL_PIN_ARENA', pin],
      ['COINNIBAL_PIN_NFT', pin],
      ['COINNIBAL_PIN_TOKEN', pin],
      ['ELYMUM_PIN_ARENA', pin],
      ['VITE_ARENA_ADDRESS', pin],
      ['VITE_CHAIN_ID', '31337'],
      ['EVM_RPC_URLS', 'https://rpc.example'],
    ];
    const r = spawnSync('bash', ['-c', script], { input: answer.map(([k, v]) => `${k}\t${v}\n`).join(''), encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['ADMIN_WALLETS=0xabc', 'COINNIBAL_CHAIN_ID=46630', 'COINNIBAL_RPC_URLS=https://rpc.example']);
  });

  // OPS-R3-2: the settings step of install.sh as it runs (step 8: env.example, --set, the --from import with curl
  // answering the old server's /api/admin/migration-env), in a scratch .env. Prints the .env it leaves.
  function settingsStep(answer: Record<string, string>, sets: string[]): { env: Map<string, string>; out: string; err: string; status: number | null } {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const lines = readFileSync(join(repoRoot, 'deploy/vps/install.sh'), 'utf8').split('\n');
    const start = lines.findIndex((l) => l.startsWith('say "8/10 Settings'));
    const end = lines.findIndex((l, i) => i > start && /^edit_env\(\) \{/.test(l));
    expect(start, 'the settings step of install.sh').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const tmp = mkdtempSync(join(tmpdir(), 'coinnibal-install-env-'));
    const answerFile = join(tmp, 'answer.json');
    writeFileSync(answerFile, JSON.stringify({ env: answer, directUrl: null }));
    const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    const script = [
      'set -euo pipefail',
      `cd ${q(repoRoot)}`,
      `export COINNIBAL_ENV=${q(join(tmp, '.env'))}`,
      '. deploy/vps/lib.sh',
      'say() { :; }',
      "note() { printf 'note: %s\\n' \"$*\"; }",
      // the old server's answer, wherever curl is told to write it
      `curl() { local o=""; while (($#)); do [[ "$1" == -o ]] && { o="$2"; shift; }; shift; done; cat ${q(answerFile)} >"$o"; }`,
      'domain=game.example.org from_url=https://old.example restore_url=https://old.example restore_token=t restore_proof=p',
      `sets=(${sets.map(q).join(' ')})`,
      ...lines.slice(start, end),
      'echo "---"',
      'cat "$COINNIBAL_ENV"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    const [out, envText = ''] = r.stdout.split('\n---\n');
    const env = new Map<string, string>();
    for (const l of envText.split('\n')) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l);
      if (m) env.set(m[1]!, m[2]!);
    }
    return { env, out: out ?? '', err: r.stderr, status: r.status };
  }

  it('install.sh --from keeps Cloudflare mode, and a --set wins over what the old server sends (OPS-R3-2)', () => {
    const pin = '0x2222222222222222222222222222222222222222';
    const r = settingsStep(
      { ADMIN_WALLETS: '0xabc', CHAIN_ID: '46630', CADDY_CONFIG: 'Caddyfile.cloudflare', X_HANDLE: 'old_handle', COINNIBAL_PIN_ARENA: pin },
      ['X_HANDLE=new_handle', 'TELEGRAM_CHAT_ID=42'],
    );
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.env.get('CADDY_CONFIG')).toBe('Caddyfile.cloudflare');
    expect(r.env.get('X_HANDLE')).toBe('new_handle');
    expect(r.env.get('TELEGRAM_CHAT_ID')).toBe('42');
    expect(r.env.get('ADMIN_WALLETS')).toBe('0xabc');
    expect(r.env.get('COINNIBAL_CHAIN_ID')).toBe('46630');
    expect(r.env.get('GAME_DOMAIN')).toBe('game.example.org');
    expect(r.env.has('COINNIBAL_PIN_ARENA')).toBe(false);
    // the owner's --set CADDY_CONFIG wins over the old server's own value
    const own = settingsStep({ ADMIN_WALLETS: '0xabc', CADDY_CONFIG: 'Caddyfile' }, ['CADDY_CONFIG=Caddyfile.cloudflare']);
    expect(own.status).toBe(0);
    expect(own.env.get('CADDY_CONFIG')).toBe('Caddyfile.cloudflare');
  });

  it('install.sh --from takes CADDY_CONFIG only as a config file of its own deploy/vps/caddy (OPS-R3-2)', () => {
    for (const bad of ['../../data/caddy/evil', '/etc/passwd', 'Caddyfile.missing', 'Caddyfile/../../x', 'caddy.json', 'Caddyfile.cloudflare;id']) {
      const r = settingsStep({ ADMIN_WALLETS: '0xabc', CADDY_CONFIG: bad }, []);
      expect(r.err, bad).toBe('');
      expect(r.status, bad).toBe(0);
      expect(r.env.has('CADDY_CONFIG'), bad).toBe(false);
      expect(r.env.get('ADMIN_WALLETS'), bad).toBe('0xabc');
      expect(r.out, bad).toContain('not copied');
      expect(r.out, bad).not.toContain(bad); // an untrusted value is never echoed to the terminal
    }
    expect(settingsStep({ CADDY_CONFIG: 'Caddyfile' }, []).env.get('CADDY_CONFIG')).toBe('Caddyfile');
  });
});
