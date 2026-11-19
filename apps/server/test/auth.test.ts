import { SIWE_STATEMENT, siweMessage } from '@coinnibal/shared';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Auth,
  CODE_CHECKS,
  MAX_NONCES,
  MAX_NONCES_PER_ADDRESS,
  MAX_NONCES_PER_CLIENT,
  MAX_NONCE_FAILURES,
  NONCE_TTL_MS,
  NonceLimitError,
  SMART_WALLET_CHECKS,
  SignInBusyError,
  checksumAddress,
  loginMessage,
  type SiweOrigin,
} from '../src/auth';
import { assertPublicUrl, loadConfig } from '../src/config';
import { siweOrigin } from '../src/http';
import { testSigner } from './signers';

const origin: SiweOrigin = { domain: 'coinnibal.fun', uri: 'https://coinnibal.fun', chainId: 46630 };

describe('SIWE login message (EIP-4361)', () => {
  it('names the domain, URI and chain, and the client can rebuild it from the fields', async () => {
    const auth = new Auth(Buffer.alloc(32, 1));
    const { address, sign } = testSigner();
    const n = auth.issueNonce(address.toLowerCase(), origin, 1_760_000_000_000);
    expect(n.address).toBe(address); // checksummed
    expect(n.message.split('\n')).toEqual([
      'coinnibal.fun wants you to sign in with your Ethereum account:',
      address,
      '',
      SIWE_STATEMENT,
      '',
      'URI: https://coinnibal.fun',
      'Version: 1',
      'Chain ID: 46630',
      `Nonce: ${n.nonce}`,
      `Issued At: ${n.issuedAt}`,
    ]);
    expect(siweMessage({ domain: n.domain, address, uri: n.uri, chainId: n.chainId, nonce: n.nonce, issuedAt: n.issuedAt })).toBe(n.message);
    expect(await auth.verifySignature(address.toLowerCase(), n.message, await sign(n.message), 1_760_000_000_001)).toBe(address);
  });

  it('a nonce is single use and expires after 10 minutes', async () => {
    const auth = new Auth(Buffer.alloc(32, 1));
    const { address, sign } = testSigner();
    const n = auth.issueNonce(address, origin, 1_000);
    const sig = await sign(n.message);
    expect(await auth.verifySignature(address, n.message, sig, 2_000)).toBe(address);
    expect(await auth.verifySignature(address, n.message, sig, 2_001)).toBeNull();
    const late = auth.issueNonce(address, origin, 10_000);
    expect(await auth.verifySignature(address, late.message, await sign(late.message), 10_000 + NONCE_TTL_MS + 1)).toBeNull();
  });

  it('refuses another signer, a forged message, or a domain / URI / chain other than the issued one', async () => {
    const auth = new Auth(Buffer.alloc(32, 1));
    const me = testSigner();
    const other = testSigner();
    const n = auth.issueNonce(me.address, origin, 1_000);
    // someone else's signature over my message
    expect(await auth.verifySignature(me.address, n.message, await other.sign(n.message), 1_001)).toBeNull();
    // the nonce survives a failed attempt
    for (const forged of [
      loginMessage(me.address, n.nonce, n.issuedAt, { ...origin, domain: 'evil.example' }),
      loginMessage(me.address, n.nonce, n.issuedAt, { ...origin, uri: 'https://evil.example' }),
      loginMessage(me.address, n.nonce, n.issuedAt, { ...origin, chainId: 1 }),
      n.message.replace('URI: ', 'URL: '),
    ]) {
      expect(await auth.verifySignature(me.address, forged, await me.sign(forged), 1_001)).toBeNull();
    }
    // another wallet cannot use my nonce
    expect(await auth.verifySignature(other.address, n.message, await other.sign(n.message), 1_001)).toBeNull();
    expect(await auth.verifySignature(me.address, n.message, 'nothex', 1_001)).toBeNull();
    expect(await auth.verifySignature(me.address, n.message, await me.sign(n.message), 1_001)).toBe(me.address);
  });

  it('falls back to the on-chain check for smart wallets (ERC-1271 / ERC-6492)', async () => {
    const calls: string[] = [];
    const contractWallet = '0x00000000000000000000000000000000000c0de1';
    const auth = new Auth(Buffer.alloc(32, 1), {
      onChain: async (address, _message, signature) => {
        calls.push(address);
        return signature === '0x1271';
      },
    });
    const n = auth.issueNonce(contractWallet, origin, 1_000);
    expect(await auth.verifySignature(contractWallet, n.message, '0xdead', 1_001)).toBeNull();
    expect(await auth.verifySignature(contractWallet, n.message, '0x1271', 1_002)).toBe(checksumAddress(contractWallet));
    expect(calls).toEqual([checksumAddress(contractWallet), checksumAddress(contractWallet)]);
    // an EOA never needs the chain
    const eoa = testSigner();
    const m = auth.issueNonce(eoa.address, origin, 1_000);
    expect(await auth.verifySignature(eoa.address, m.message, await eoa.sign(m.message), 1_001)).toBe(eoa.address);
    expect(calls).toHaveLength(2);
  });

  it('a nonce survives only a few wrong signatures (each may cost an on-chain check)', async () => {
    let calls = 0;
    const auth = new Auth(Buffer.alloc(32, 1), {
      onChain: async () => {
        calls++;
        return false;
      },
    });
    const me = testSigner();
    const n = auth.issueNonce(me.address, origin, 1_000);
    for (let i = 0; i < 10; i++) expect(await auth.verifySignature(me.address, n.message, '0xdeadbeef', 1_001)).toBeNull();
    expect(calls).toBe(MAX_NONCE_FAILURES);
    // the nonce is gone: even the right signature needs a new one now
    expect(await auth.verifySignature(me.address, n.message, await me.sign(n.message), 1_002)).toBeNull();
    const again = auth.issueNonce(me.address, origin, 1_003);
    expect(await auth.verifySignature(me.address, again.message, await me.sign(again.message), 1_004)).toBe(me.address);
  });

  it('tokens carry the checksummed address and are tamper-proof', () => {
    const auth = new Auth(Buffer.alloc(32, 1));
    const { address } = testSigner();
    const token = auth.issueToken(address.toLowerCase(), 1_000);
    expect(auth.verifyToken(token, 2_000)).toBe(address);
    expect(auth.verifyToken(token.replace(address, address.toLowerCase()), 2_000)).toBeNull();
    expect(new Auth(Buffer.alloc(32, 2)).verifyToken(token, 2_000)).toBeNull();
    expect(auth.verifyToken(token, 1_000 + 25 * 3600_000)).toBeNull();
  });

  it('checksumAddress refuses a mixed-case address with a wrong checksum', () => {
    expect(checksumAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(checksumAddress('0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBeNull();
    expect(checksumAddress('not-an-evm-address')).toBeNull();
  });

  it('takes the domain from PUBLIC_URL (the request host only in development); the chain id is the server\'s', () => {
    const req = { headers: { host: 'game.local:8787' } } as never;
    expect(siweOrigin(loadConfig({ PUBLIC_URL: 'https://coinnibal.fun/' } as NodeJS.ProcessEnv), req, false, 46630)).toEqual({
      domain: 'coinnibal.fun',
      uri: 'https://coinnibal.fun',
      chainId: 46630,
    });
    const dev = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    // chain off: the configured CHAIN_ID (default Robinhood Chain Testnet)
    expect(siweOrigin(dev, req, false, null)).toEqual({ domain: 'game.local:8787', uri: 'http://game.local:8787', chainId: 46630 });
    expect(siweOrigin(loadConfig({ NODE_ENV: 'development', CHAIN_ID: '4663' } as NodeJS.ProcessEnv), req, false, null).chainId).toBe(4663);
    expect(siweOrigin(dev, req, false, 31337).chainId).toBe(31337);
  });

  it('names the brand site (coinnibal.fun) for a sign-in from it, and only from that fixed list', () => {
    const cfg = loadConfig({ PUBLIC_URL: 'https://old-site.example' } as NodeJS.ProcessEnv);
    const from = (origin: string) => siweOrigin(cfg, { headers: { host: 'game.old-site.example', origin } } as never, false, 46630);
    expect(from('https://coinnibal.fun')).toEqual({ domain: 'coinnibal.fun', uri: 'https://coinnibal.fun', chainId: 46630 });
    expect(from('https://www.coinnibal.fun/').domain).toBe('www.coinnibal.fun');
    for (const other of ['https://evil.example', 'http://coinnibal.fun', 'https://coinnibal.fun.evil.example']) expect(from(other).domain).toBe('old-site.example');
    // the site moved (PUBLIC_URL coinnibal.fun): a sign-in from a page of elymum.io, the domain of before the rename
    // (a kept brand origin while the live config redirects it), still names elymum.io
    const moved = loadConfig({ PUBLIC_URL: 'https://coinnibal.fun' } as NodeJS.ProcessEnv);
    expect(siweOrigin(moved, { headers: { host: 'coinnibal.fun', origin: 'https://elymum.io' } } as never, false, 46630).domain).toBe('elymum.io');
    expect(siweOrigin(moved, { headers: { host: 'coinnibal.fun', origin: 'https://evil.example' } } as never, false, 46630).domain).toBe('coinnibal.fun');
    // the open-play copy of the site (OPEN_PLAY_ORIGINS) signs in under its own name
    expect(siweOrigin(moved, { headers: { host: 'coinnibal.fun', origin: 'https://coinnibal.vercel.app' } } as never, false, 46630)).toEqual({ domain: 'coinnibal.vercel.app', uri: 'https://coinnibal.vercel.app', chainId: 46630 });
  });

  it('never lets a request choose the SIWE domain outside development (Host / X-Forwarded-Host spoofing)', async () => {
    const auth = new Auth(Buffer.alloc(32, 1));
    const victim = testSigner();
    const spoofs = [{ host: 'evil.example' }, { host: 'game.example', 'x-forwarded-host': 'evil.example, game.example' }];
    for (const headers of spoofs) {
      const req = { headers } as never;
      // PUBLIC_URL set: always its host
      expect(siweOrigin(loadConfig({ PUBLIC_URL: 'https://game.example' } as NodeJS.ProcessEnv), req, false, 46630).domain).toBe('game.example');
      // unset outside development (startup refuses this; the fallback is localhost, never the request)
      for (const env of [{}, { NODE_ENV: 'production' }, { NODE_ENV: 'test' }]) {
        const o = siweOrigin(loadConfig({ PORT: '8787', ...env } as NodeJS.ProcessEnv), req, false, 46630);
        expect(o.domain).toBe('localhost:8787');
        const n = auth.issueNonce(victim.address, o);
        expect(n.message).not.toContain('evil.example');
      }
      // development: Host only, X-Forwarded-Host is ignored
      expect(siweOrigin(loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), req, false, 46630).domain).toBe(headers.host);
    }
  });

  it('refuses to start without PUBLIC_URL unless NODE_ENV=development', () => {
    expect(() => assertPublicUrl(loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv))).toThrow(/PUBLIC_URL is required \(NODE_ENV is production\)/);
    expect(() => assertPublicUrl(loadConfig({} as NodeJS.ProcessEnv))).toThrow(/PUBLIC_URL is required \(NODE_ENV is unset\)/);
    expect(() => assertPublicUrl(loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv))).not.toThrow();
    expect(() => assertPublicUrl(loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://coinnibal.fun/' } as NodeJS.ProcessEnv))).not.toThrow();
    for (const bad of ['coinnibal.fun', 'ftp://coinnibal.fun', 'https://coinnibal.fun/app', 'https://u:p@coinnibal.fun'])
      expect(() => assertPublicUrl(loadConfig({ NODE_ENV: 'production', PUBLIC_URL: bad } as NodeJS.ProcessEnv)), bad).toThrow(/PUBLIC_URL must be/);
  });
});

describe('nonce map', () => {
  it('is capped: the oldest nonces are evicted', async () => {
    const auth = new Auth(Buffer.alloc(32, 1));
    const { address, sign } = testSigner();
    const first = auth.issueNonce(address, origin, 0);
    for (let i = 0; i < MAX_NONCES + 50; i++) auth.issueNonce(address, origin, 1);
    expect(auth.nonceCount).toBeLessThanOrEqual(MAX_NONCES);
    // the very first nonce was evicted; a recent one still works
    expect(await auth.verifySignature(address, first.message, await sign(first.message), 2)).toBeNull();
    const last = auth.issueNonce(address, origin, 3);
    expect(await auth.verifySignature(address, last.message, await sign(last.message), 4)).toBe(address);
  });
});

describe('nonce pool under a flood', () => {
  it('a flooding client fills only its own share; an honest sign-in started meanwhile still works', async () => {
    const auth = new Auth(Buffer.alloc(32, 2));
    const honest = testSigner();
    const mine = auth.issueNonce(honest.address, origin, 1_000, '198.51.100.7');
    // one client: refused past its cap, whatever addresses it names
    let refused = 0;
    for (let i = 0; i < 200; i++) {
      try {
        auth.issueNonce(testSigner().address, origin, 1_001, '203.0.113.9');
      } catch (err) {
        expect(err).toBeInstanceOf(NonceLimitError);
        refused++;
      }
    }
    expect(refused).toBe(200 - MAX_NONCES_PER_CLIENT);
    // many clients (a botnet) fill the pool: the biggest holders lose their own nonces first
    const someone = (i: number) => `0x${'1'.repeat(32)}${i.toString(16).padStart(8, '0')}`;
    for (let i = 0; i < MAX_NONCES + 500; i++) auth.issueNonce(someone(i), origin, 1_002, `10.0.${(i >> 2) & 255}.${i & 3}`);
    expect(auth.nonceCount).toBeLessThanOrEqual(MAX_NONCES);
    expect(await auth.verifySignature(honest.address, mine.message, await honest.sign(mine.message), 2_000)).toBe(honest.address);
  });
});

describe('nobody can lock a wallet out of sign-in (S4)', () => {
  it('another client asking for nonces for an address never evicts the nonce its owner is signing', async () => {
    const auth = new Auth(Buffer.alloc(32, 3));
    const owner = testSigner();
    const mine = auth.issueNonce(owner.address, origin, 1_000, '198.51.100.7');
    // the reviewer's attack: anyone polls nonces for the (public) address, from one or many clients
    for (let i = 0; i < 10; i++) auth.issueNonce(owner.address, origin, 1_001, '203.0.113.9');
    for (let i = 0; i < 40; i++) auth.issueNonce(owner.address, origin, 1_001, `2001:db8:${i.toString(16)}::/64`);
    expect(await auth.verifySignature(owner.address, mine.message, await owner.sign(mine.message), 2_000)).toBe(owner.address);
    // one client still keeps at most MAX_NONCES_PER_ADDRESS for one address (its own oldest goes)
    const first = auth.issueNonce(owner.address, origin, 3_000, '198.51.100.7');
    for (let i = 0; i < MAX_NONCES_PER_ADDRESS; i++) auth.issueNonce(owner.address, origin, 3_001, '198.51.100.7');
    expect(await auth.verifySignature(owner.address, first.message, await owner.sign(first.message), 3_002)).toBeNull();
  });

  it('a client\'s expired nonces never count against its cap, on a quiet server too (R2-NET-5)', async () => {
    const auth = new Auth(Buffer.alloc(32, 5));
    // one home /64: six wallets, four prompts each, none signed (cancelled, closed pages); the pool stays small
    const t0 = 1_800_000_000_000;
    for (let w = 0; w < 6; w++) for (let i = 0; i < 4; i++) auth.issueNonce(`0x${(0x100 + w).toString(16).padStart(40, '0')}`, origin, t0, '2001:db8:1:2::/64');
    expect(auth.nonceCount).toBe(MAX_NONCES_PER_CLIENT);
    expect(() => auth.issueNonce(testSigner().address, origin, t0 + 1, '2001:db8:1:2::/64')).toThrow(NonceLimitError);
    // once they expired, another device of that /64 signs in
    const owner = testSigner();
    const n = auth.issueNonce(owner.address, origin, t0 + NONCE_TTL_MS + 1, '2001:db8:1:2::/64');
    expect(await auth.verifySignature(owner.address, n.message, await owner.sign(n.message), t0 + NONCE_TTL_MS + 2)).toBe(owner.address);
    expect(auth.nonceCount).toBe(0);
    // the cap itself still holds for live nonces
    for (let i = 1; i < MAX_NONCES_PER_CLIENT; i++) auth.issueNonce(testSigner().address, origin, t0 + NONCE_TTL_MS + 3, '2001:db8:1:2::/64');
    auth.issueNonce(testSigner().address, origin, t0 + NONCE_TTL_MS + 3, '2001:db8:1:2::/64');
    expect(() => auth.issueNonce(testSigner().address, origin, t0 + NONCE_TTL_MS + 4, '2001:db8:1:2::/64')).toThrow(NonceLimitError);
  });

  it('a full pool evicts the biggest network first: thousands of /64s of one /48 never flush an honest nonce', { timeout: 30_000 }, async () => {
    const auth = new Auth(Buffer.alloc(32, 4));
    const honest = testSigner();
    const mine = auth.issueNonce(honest.address, origin, 1_000, '198.51.100.7');
    const someone = (i: number) => `0x${'2'.repeat(32)}${i.toString(16).padStart(8, '0')}`;
    // one nonce per /64 (no client holds many), all in one /48
    for (let i = 0; i < MAX_NONCES + 500; i++) auth.issueNonce(someone(i), origin, 1_001, `2001:db8:7:${(i & 0xffff).toString(16)}::/64`);
    expect(auth.nonceCount).toBeLessThanOrEqual(MAX_NONCES);
    expect(await auth.verifySignature(honest.address, mine.message, await honest.sign(mine.message), 2_000)).toBe(honest.address);
  });
});

/** A sign-in's outcome: the address, null (a wrong signature) or `busy` (`SignInBusyError`: the check cannot run now). */
const outcome = (p: Promise<string | null>) =>
  p.catch((err) => {
    if (err instanceof SignInBusyError) return 'busy' as const;
    throw err;
  });

describe('garbage signatures do not spend the shared RPC budget (S5)', () => {
  const contract = '0x00000000000000000000000000000000000c0de1';

  it('the smart-wallet fallback runs within a small budget of its own; an EOA never reaches it', async () => {
    // the clock stands still: the server-wide bucket does not refill during the test
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    let calls = 0;
    const auth = new Auth(Buffer.alloc(32, 5), {
      onChain: async (_a, _m, sig) => {
        calls++;
        return sig === '0x1271';
      },
    });
    // many clients, each with a garbage signature on every nonce it may have: refused, or busy past the budget
    const seen = new Set<string | null>();
    for (let c = 0; c < 20; c++) {
      for (let n = 0; n < 3; n++) {
        const issued = auth.issueNonce(contract, origin, Date.now(), `203.0.${c}.${n}`);
        for (let f = 0; f < MAX_NONCE_FAILURES; f++) seen.add(await outcome(auth.verifySignature(contract, issued.message, '0xdeadbeef')));
      }
    }
    expect(calls).toBe(SMART_WALLET_CHECKS.burst);
    expect([...seen].sort()).toEqual(['busy', null]);
    // an EOA's own signature is checked locally, whatever the budget
    const eoa = testSigner();
    const m = auth.issueNonce(eoa.address, origin, Date.now(), '198.51.100.1');
    expect(await auth.verifySignature(eoa.address, m.message, await eoa.sign(m.message))).toBe(eoa.address);
    expect(calls).toBe(SMART_WALLET_CHECKS.burst);
  });

  it('per client and per IPv6 /48 in a window; at most inFlight at once; a check unanswered in timeoutMs gives its place back', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let hang = false;
      const auth = new Auth(Buffer.alloc(32, 6), {
        onChain: (_a, _m, sig) => {
          calls++;
          return hang ? new Promise<boolean>(() => {}) : Promise.resolve(sig === '0x1271');
        },
      });
      const attempt = (client: string, sig: string) => outcome(auth.verifySignature(contract, auth.issueNonce(contract, origin, Date.now(), client).message, sig));
      const got: (string | null)[] = [];
      for (let i = 0; i < 10; i++) got.push(await attempt('203.0.113.9', '0xdeadbeef'));
      expect(calls).toBe(SMART_WALLET_CHECKS.perClient);
      expect(got.filter((g) => g === 'busy')).toHaveLength(10 - SMART_WALLET_CHECKS.perClient);
      // a new /64 of one /48 for every try, slow enough for the server-wide bucket: the /48 gets perGroup
      await vi.advanceTimersByTimeAsync(60_000);
      calls = 0;
      for (let i = 0; i < 20; i++) {
        await attempt(`2001:db8:5:${(i + 1).toString(16)}::/64`, '0xdeadbeef');
        await vi.advanceTimersByTimeAsync(2_000);
      }
      expect(calls).toBe(SMART_WALLET_CHECKS.perGroup);
      // a real smart-wallet sign-in from another client passes
      expect(await attempt('198.51.100.2', '0x1271')).toBe(checksumAddress(contract));
      // checks the RPC never answers hold their places for timeoutMs at most; meanwhile the next is busy
      hang = true;
      calls = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      const held = [attempt('198.51.100.3', '0x1271'), attempt('198.51.100.4', '0x1271'), attempt('198.51.100.5', '0x1271')];
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(SMART_WALLET_CHECKS.inFlight);
      expect(await held[2]).toBe('busy');
      await vi.advanceTimersByTimeAsync(SMART_WALLET_CHECKS.timeoutMs);
      expect(await Promise.all(held.slice(0, 2))).toEqual(['busy', 'busy']);
      // the calls are still stuck in the RPC queue, yet their places are free again: the next check runs
      hang = false;
      expect(await attempt('198.51.100.6', '0x1271')).toBe(checksumAddress(contract));
      expect(calls).toBe(SMART_WALLET_CHECKS.inFlight + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('nobody can lock a smart wallet out of sign-in (NET-R1-2)', () => {
  const SMART = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe';
  const GOOD = `0x${'ab'.repeat(65)}`;
  const GARBAGE = `0x${'00'.repeat(65)}`;
  const someone = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}`;

  /** Garbage from many /64s of one /48 and from many IPv4 addresses, for addresses of anyone: the general budget is spent. */
  async function flood(auth: Auth): Promise<void> {
    const clients = [...Array.from({ length: 80 }, (_, i) => `2001:db8:66:${(i + 1).toString(16)}::/64`), ...Array.from({ length: 80 }, (_, i) => `203.0.113.${i + 1}`)];
    for (const [i, client] of clients.entries()) {
      const n = auth.issueNonce(someone(i), origin, Date.now(), client);
      for (let f = 0; f < MAX_NONCE_FAILURES; f++) await outcome(auth.verifySignature(someone(i), n.message, GARBAGE));
    }
  }

  it('garbage from many /64s of one /48 (and many IPv4 clients) does not stop a known smart wallet from signing in', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const auth = new Auth(Buffer.alloc(32, 7), {
        onChain: async (a, _m, sig) => {
          calls++;
          return a.toLowerCase() === SMART && sig === GOOD;
        },
      });
      const owner = '198.51.100.1';
      const first = auth.issueNonce(SMART, origin, Date.now(), owner);
      expect(await auth.verifySignature(SMART, first.message, GOOD)).toBe(checksumAddress(SMART));
      await flood(auth);
      // the clock stood still: the server-wide budget is empty, and one /48 took no more than its share
      expect(calls).toBeLessThanOrEqual(SMART_WALLET_CHECKS.burst + 1);
      // the owner signs in again from its network: the reserve of known smart wallets
      const again = auth.issueNonce(SMART, origin, Date.now(), owner);
      expect(await auth.verifySignature(SMART, again.message, GOOD)).toBe(checksumAddress(SMART));
      // a smart wallet the server has not seen yet hears busy, not "wrong signature": its nonce is kept, and the
      // same signature passes a moment later
      const fresh = '0x5afe00000000000000000000000000000000beef';
      const auth2 = new Auth(Buffer.alloc(32, 8), { onChain: async (a, _m, sig) => a.toLowerCase() === fresh && sig === GOOD });
      await flood(auth2);
      const n = auth2.issueNonce(fresh, origin, Date.now(), '198.51.100.9');
      for (let i = 0; i < MAX_NONCE_FAILURES + 2; i++) expect(await outcome(auth2.verifySignature(fresh, n.message, GOOD))).toBe('busy');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await auth2.verifySignature(fresh, n.message, GOOD)).toBe(checksumAddress(fresh));
    } finally {
      vi.useRealTimers();
    }
  });

  it('garbage aimed at a plain account (no code) never reaches the smart-wallet check', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let codeReads = 0;
      const auth = new Auth(Buffer.alloc(32, 9), {
        onChain: async (a, _m, sig) => {
          calls++;
          return a.toLowerCase() === SMART && sig === GOOD;
        },
        hasCode: async (a) => {
          codeReads++;
          return a.toLowerCase() === SMART;
        },
      });
      const tries = CODE_CHECKS.burst;
      for (let i = 0; i < tries; i++) {
        const n = auth.issueNonce(someone(i), origin, Date.now(), `203.0.113.${i + 1}`);
        // a wrong signature of an EOA: refused (the nonce's failures count), and the chain is asked for its code once
        for (let f = 0; f < MAX_NONCE_FAILURES; f++) expect(await auth.verifySignature(someone(i), n.message, GARBAGE)).toBeNull();
      }
      expect(calls).toBe(0);
      expect(codeReads).toBe(tries);
      // a counterfactual wallet signs with the ERC-6492 suffix: that one is checked on chain
      const n = auth.issueNonce(someone(0), origin, Date.now(), '203.0.113.1');
      expect(await auth.verifySignature(someone(0), n.message, `${GARBAGE}${'6492'.repeat(16)}`)).toBeNull();
      expect(calls).toBe(1);
      // the smart wallet (it holds code) is checked as before
      const s = auth.issueNonce(SMART, origin, Date.now(), '198.51.100.1');
      expect(await auth.verifySignature(SMART, s.message, GOOD)).toBe(checksumAddress(SMART));
      expect(calls).toBe(2);
      // with the code check's budget spent, an unknown address is taken as possibly a contract (no lock-out)
      const u = auth.issueNonce(someone(99), origin, Date.now(), '198.51.100.7');
      expect(await auth.verifySignature(someone(99), u.message, GARBAGE)).toBeNull();
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an ERC-8010 signature (an EIP-7702 account not delegated yet: no code) reaches the on-chain check (R2-NET-6)', async () => {
    vi.useFakeTimers();
    try {
      // a Porto-style account: no code until its first transaction; viem's verifyMessage checks the delegation
      const porto = '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';
      const signed = `0x${'cd'.repeat(200)}${'8010'.repeat(16)}`;
      let calls = 0;
      let codeReads = 0;
      const auth = new Auth(Buffer.alloc(32, 10), {
        onChain: async (a, _m, sig) => (calls++, a.toLowerCase() === porto && sig === signed),
        hasCode: async () => (codeReads++, false),
      });
      const n = auth.issueNonce(porto, origin, Date.now(), '198.51.100.9');
      expect(await auth.verifySignature(porto, n.message, signed)).toBe(checksumAddress(porto));
      expect(calls).toBe(1);
      expect(codeReads).toBe(0);
      // another account without code and without the suffix: a wrong signature never reaches the chain
      const m = auth.issueNonce(someone(50), origin, Date.now(), '198.51.100.9');
      expect(await auth.verifySignature(someone(50), m.message, GARBAGE)).toBeNull();
      expect(calls).toBe(1);
      expect(codeReads).toBe(1);
      // an ERC-8010-suffixed check still runs within the smart-wallet budget (per client here)
      const tries: (string | null)[] = [];
      for (let i = 0; i < SMART_WALLET_CHECKS.perClient + 1; i++) {
        const k = auth.issueNonce(someone(i), origin, Date.now(), '203.0.113.200');
        tries.push(await outcome(auth.verifySignature(someone(i), k.message, `${GARBAGE}${'8010'.repeat(16)}`)));
      }
      expect(tries.at(-1)).toBe('busy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('two checks stuck in the RPC queue do not stop a known smart wallet, nor anyone after timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      let hang = 0;
      const other = '0x5afe00000000000000000000000000000000beef';
      const auth = new Auth(Buffer.alloc(32, 10), {
        onChain: async (a, _m, sig) => {
          if (hang-- > 0) await new Promise((r) => setTimeout(r, 120_000));
          return (a.toLowerCase() === SMART || a.toLowerCase() === other) && sig === GOOD;
        },
      });
      const owner = '198.51.100.1';
      expect(await auth.verifySignature(SMART, auth.issueNonce(SMART, origin, Date.now(), owner).message, GOOD)).toBe(checksumAddress(SMART));
      await vi.advanceTimersByTimeAsync(10_000);
      hang = SMART_WALLET_CHECKS.inFlight;
      const stuck = Array.from({ length: hang }, (_, i) => outcome(auth.verifySignature(someone(i), auth.issueNonce(someone(i), origin, Date.now(), `203.0.113.${i + 1}`).message, GARBAGE)));
      await vi.advanceTimersByTimeAsync(2_100);
      // the known owner has its reserve; a smart wallet not seen yet is busy until the stuck checks give up
      expect(await auth.verifySignature(SMART, auth.issueNonce(SMART, origin, Date.now(), owner).message, GOOD)).toBe(checksumAddress(SMART));
      const n = auth.issueNonce(other, origin, Date.now(), '198.51.100.2');
      expect(await outcome(auth.verifySignature(other, n.message, GOOD))).toBe('busy');
      await vi.advanceTimersByTimeAsync(SMART_WALLET_CHECKS.timeoutMs);
      expect(await Promise.all(stuck)).toEqual(['busy', 'busy']);
      expect(await auth.verifySignature(other, n.message, GOOD)).toBe(checksumAddress(other));
    } finally {
      vi.useRealTimers();
    }
  });

  it('known smart wallets are kept on disk: a restart does not take the reserve away', async () => {
    vi.useFakeTimers();
    try {
      const file = join(mkdtempSync(join(tmpdir(), 'coinnibal-smart-')), 'auth-smart-wallets.json');
      const onChain = async (a: string, _m: string, sig: string) => a.toLowerCase() === SMART && sig === GOOD;
      const before = new Auth(Buffer.alloc(32, 11), { onChain, smartWalletsFile: file });
      expect(await before.verifySignature(SMART, before.issueNonce(SMART, origin, Date.now(), '2001:db8:aa:1::/64').message, GOOD)).toBe(checksumAddress(SMART));
      const after = new Auth(Buffer.alloc(32, 11), { onChain, smartWalletsFile: file });
      await flood(after);
      // another /64 of the same /48 (the owner's phone got a new prefix): still the owner's network
      expect(await after.verifySignature(SMART, after.issueNonce(SMART, origin, Date.now(), '2001:db8:aa:2::/64').message, GOOD)).toBe(checksumAddress(SMART));
      // from a network it never signed in from, it waits like everyone
      expect(await outcome(after.verifySignature(SMART, after.issueNonce(SMART, origin, Date.now(), '198.51.100.50').message, GOOD))).toBe('busy');
    } finally {
      vi.useRealTimers();
    }
  });
});
