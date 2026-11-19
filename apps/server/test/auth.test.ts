import { SIWE_STATEMENT, siweMessage } from '@coinnibal/shared';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { Auth, MAX_NONCES, MAX_NONCES_PER_ADDRESS, MAX_NONCES_PER_CLIENT, MAX_NONCE_FAILURES, NONCE_TTL_MS, NonceLimitError, SMART_WALLET_CHECKS, checksumAddress, loginMessage, type SiweOrigin } from '../src/auth';
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
    // many clients, each with a garbage signature on every nonce it may have
    for (let c = 0; c < 20; c++) {
      for (let n = 0; n < 3; n++) {
        const issued = auth.issueNonce(contract, origin, Date.now(), `203.0.${c}.${n}`);
        for (let f = 0; f < MAX_NONCE_FAILURES; f++) expect(await auth.verifySignature(contract, issued.message, '0xdeadbeef')).toBeNull();
      }
    }
    expect(calls).toBe(SMART_WALLET_CHECKS.burst);
    // an EOA's own signature is checked locally, whatever the budget
    const eoa = testSigner();
    const m = auth.issueNonce(eoa.address, origin, Date.now(), '198.51.100.1');
    expect(await auth.verifySignature(eoa.address, m.message, await eoa.sign(m.message))).toBe(eoa.address);
    expect(calls).toBe(SMART_WALLET_CHECKS.burst);
  });

  it('one client gets SMART_WALLET_CHECKS.perClient checks in its window; at most inFlight run at once, each for timeoutMs', async () => {
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
      const attempt = (client: string, sig: string) => auth.verifySignature(contract, auth.issueNonce(contract, origin, Date.now(), client).message, sig);
      for (let i = 0; i < 10; i++) await attempt('203.0.113.9', '0xdeadbeef');
      expect(calls).toBe(SMART_WALLET_CHECKS.perClient);
      // later, the budget refilled: a real smart-wallet sign-in from another client passes
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await attempt('198.51.100.2', '0x1271')).toBe(checksumAddress(contract));
      // a check the RPC never answers holds its slot until it is given up; meanwhile nothing more starts
      hang = true;
      calls = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      const held = [attempt('198.51.100.3', '0x1271'), attempt('198.51.100.4', '0x1271'), attempt('198.51.100.5', '0x1271')];
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(SMART_WALLET_CHECKS.inFlight);
      expect(await held[2]).toBeNull();
      await vi.advanceTimersByTimeAsync(SMART_WALLET_CHECKS.timeoutMs);
      expect(await Promise.all(held.slice(0, 2))).toEqual([null, null]);
    } finally {
      vi.useRealTimers();
    }
  });
});
