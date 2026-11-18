import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageKey } from '../src/storageKey';

const WALLET = '0x00000000000000000000000000000000000000Aa';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.resetModules());

describe('storageKey: the keys of before the rename (elymum.*) move to coinnibal.*', () => {
  it('reads the new key; a value kept under the old key moves there once, and the old key is deleted', () => {
    localStorage.setItem('elymum.settings.v1', '{"theme":"dark"}');
    expect(storageKey('settings.v1')).toBe('coinnibal.settings.v1');
    expect(localStorage.getItem('coinnibal.settings.v1')).toBe('{"theme":"dark"}');
    expect(localStorage.getItem('elymum.settings.v1')).toBeNull();
    // again: nothing more to move
    expect(storageKey('settings.v1')).toBe('coinnibal.settings.v1');
    expect(localStorage.getItem('coinnibal.settings.v1')).toBe('{"theme":"dark"}');
  });

  it('the new key wins when both exist; nothing kept, nothing written', () => {
    localStorage.setItem('coinnibal.locale.v1', 'en');
    localStorage.setItem('elymum.locale.v1', 'tr');
    storageKey('locale.v1');
    expect(localStorage.getItem('coinnibal.locale.v1')).toBe('en');
    storageKey('brief');
    expect(localStorage.getItem('coinnibal.brief')).toBeNull();
    expect(localStorage.length).toBe(2);
  });

  it('sessionStorage keys move in sessionStorage', () => {
    sessionStorage.setItem('elymum.chunk-reload.v1', '123');
    expect(storageKey('chunk-reload.v1', 'session')).toBe('coinnibal.chunk-reload.v1');
    expect(sessionStorage.getItem('coinnibal.chunk-reload.v1')).toBe('123');
    expect(sessionStorage.getItem('elymum.chunk-reload.v1')).toBeNull();
    expect(localStorage.getItem('coinnibal.chunk-reload.v1')).toBeNull();
  });

  it('a storage that refuses the write keeps the old value where it is', () => {
    localStorage.setItem('elymum.wallet.v1', 'io.metamask');
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(storageKey('wallet.v1')).toBe('coinnibal.wallet.v1');
    } finally {
      set.mockRestore();
    }
    expect(localStorage.getItem('elymum.wallet.v1')).toBe('io.metamask');
  });

  it('the kept payments and the session of a browser from before the rename are read by the new build', async () => {
    const now = Date.now();
    const room = { hash: `0x${'ab'.repeat(32)}`, wallet: WALLET, request: 'abcdefghijk23456', raw: '1500000000000000000000', at: now };
    const claim = { owner: WALLET, kind: 'magnet', txHash: `0x${'cd'.repeat(32)}`, at: now };
    localStorage.setItem('elymum.room-payment.v2', JSON.stringify(room));
    localStorage.setItem('elymum.shop.claim.v1', JSON.stringify(claim));
    localStorage.setItem('elymum.auth.v1', JSON.stringify({ address: WALLET, token: 'tok.en', exp: now + 3600_000 }));
    localStorage.setItem('elymum.site.admin.v1', WALLET);
    vi.resetModules();
    const rooms = await import('../src/rooms/api');
    const shop = await import('../src/wallet/shop');
    const session = await import('../src/site/storedSession');
    expect(rooms.loadPendingPayment(WALLET)).toEqual(room);
    expect(shop.loadPendingClaim(WALLET)).toEqual(claim);
    expect(session.readStoredSession()).toEqual({ address: WALLET, token: 'tok.en', admin: true });
    for (const k of ['room-payment.v2', 'shop.claim.v1', 'auth.v1', 'site.admin.v1']) {
      expect(localStorage.getItem(`elymum.${k}`)).toBeNull();
      expect(localStorage.getItem(`coinnibal.${k}`)).not.toBeNull();
    }
  });
});
