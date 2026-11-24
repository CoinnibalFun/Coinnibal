import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChainGateway } from '../src/chain/types';
import { Limiter } from '../src/net/limiter';
import { AppetizerService } from '../src/site/appetizer';
import type { ContractsStore } from '../src/site/contracts';
import { FaucetInfo } from '../src/site/network';
import type { XPostRead } from '../src/xlink';
import { testSigner } from './signers';

/** Security audit (November 2026): one regression test per confirmed finding. */

describe('security audit: Appetizer image views', () => {
  let dir = '';
  afterEach(() => {
    vi.useRealTimers();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a flood of card image fetches does not rewrite the whole card file every second (it is ~25 MB at 100k cards)', () => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'coinnibal-sec-views-'));
    const file = join(dir, 'appetizers.json');
    const s = new AppetizerService({ path: file, baseUrl: () => 'https://coinnibal.fun' });
    const code = s.claim(testSigner().address, 'viewed_1').card.code;
    // a claim is written within a second
    vi.advanceTimersByTime(1_100);
    const written = statSync(file).mtimeMs;
    const res = { writeHead() {}, end() {} } as never;
    const req = { method: 'GET', headers: {} } as never;
    s.setRenderBroken('no canvas in this test');
    let writes = 0;
    let last = written;
    // ten seconds of one image fetch a second (no limit applies to a cached card)
    for (let i = 0; i < 10; i++) {
      s.handle(req, res, `/appetizer/${code}.png`, '9.9.9.9');
      vi.advanceTimersByTime(1_000);
      const m = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? last;
      if (m !== last) writes++;
      last = m;
    }
    expect(writes).toBeLessThanOrEqual(1);
    // the views are still kept: on flush (shutdown, backups) and on the slow timer
    s.flush();
    const again = new AppetizerService({ path: file, baseUrl: () => 'https://coinnibal.fun' });
    expect(again.list().items[0].views).toBe(10);
    // and a claim is still written within a second even while a slow views save waits
    s.handle(req, res, `/appetizer/${code}.png`, '9.9.9.9');
    s.claim(testSigner().address, 'second_2');
    vi.advanceTimersByTime(1_100);
    expect(new AppetizerService({ path: file, baseUrl: () => 'https://coinnibal.fun' }).total).toBe(2);
  });
});

describe('security audit: GET /api/site/faucet and the RPC budget', () => {
  const TOKEN = '0x00000000000000000000000000000000000000aa';
  const faucet = (read: () => Promise<unknown>, clock: { t: number }) => {
    const chain = {
      status: () => ({ chainId: 46630, faucetUrl: null }),
      evm: () => ({ testTokenFaucet: read }),
    } as unknown as ChainGateway;
    const contracts = { effective: () => ({ token: { address: TOKEN } }) } as unknown as ContractsStore;
    return new FaucetInfo({ chain, contracts, now: () => clock.t });
  };

  it('a failed read is not tried again by every visitor (5 public eth_calls each, at the joins priority)', async () => {
    const clock = { t: 1_000_000 };
    let calls = 0;
    const f = faucet(async () => {
      calls++;
      throw new Error('rpc busy');
    }, clock);
    for (let i = 0; i < 20; i++) expect((await f.get()).amount).toBeNull();
    expect(calls).toBe(1);
    // tried again after a short while
    clock.t += 60_000;
    await f.get();
    expect(calls).toBe(2);
  });

  it('visitors arriving together share one read', async () => {
    const clock = { t: 1_000_000 };
    let calls = 0;
    const f = faucet(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { amount: 10n, holderAmount: 20n, cooldownSecs: 60, holderNft: null };
    }, clock);
    const all = await Promise.all(Array.from({ length: 25 }, () => f.get()));
    expect(calls).toBe(1);
    expect(all.every((x) => x.amount === '10')).toBe(true);
  });
});

describe('security audit: the open-play copy (apps/web/vercel.json)', () => {
  it('is never framed and runs scripts of its own origin only, as the site the server serves (clickjacking of wallet and admin actions)', async () => {
    const { WEB_CSP } = await import('../src/http');
    const v = JSON.parse(readFileSync(join(__dirname, '../../web/vercel.json'), 'utf8')) as { headers?: { source: string; headers: { key: string; value: string }[] }[] };
    const all = (v.headers ?? []).find((h) => h.source === '/(.*)');
    const get = (k: string) => all?.headers.find((h) => h.key.toLowerCase() === k.toLowerCase())?.value;
    expect(get('Content-Security-Policy')).toBe(WEB_CSP);
    expect(get('X-Frame-Options')).toBe('DENY');
    expect(get('X-Content-Type-Options')).toBe('nosniff');
    expect(get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});

describe('security audit: Appetizer post links', () => {
  it('a verified post is never replaced by a link X cannot check (anyone may send a link for a public card code)', async () => {
    let xUp = true;
    const readPost = async (id: string): Promise<XPostRead> => {
      if (!xUp) return { ok: false, why: 'down' };
      return { ok: true, post: { id, text: `my card ${code}`, handle: 'victim_1', userId: null, name: 'V', avatarUrl: null, createdAt: null, urls: [] } };
    };
    const s = new AppetizerService({ path: null, baseUrl: () => 'https://coinnibal.fun', postIp: new Limiter(1000, 60_000), readPost });
    const code = s.claim(testSigner().address, 'victim_1').card.code;
    expect(await s.setPost(code, 'https://x.com/victim_1/status/111')).toEqual({ ok: true, verified: true });
    // an attacker (the card code is in the public share link) sends a made-up status of the same handle while X does
    // not answer (its budget spent, or X down): the verified post must stay
    xUp = false;
    await expect(s.setPost(code, 'https://x.com/victim_1/status/999')).rejects.toMatchObject({ status: 503, code: 'x_unreachable' });
    expect(s.list().items[0]).toMatchObject({ post: 'https://x.com/victim_1/status/111', postVerified: true });
    // a card without a verified post still keeps an unchecked link while X is down (the visitor is not blocked)
    const other = s.claim(testSigner().address, 'fresh_2').card.code;
    expect(await s.setPost(other, 'https://x.com/fresh_2/status/5')).toEqual({ ok: true, verified: false });
  });
});
