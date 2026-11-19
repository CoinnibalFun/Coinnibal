import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';

/**
 * The visitor pages' text guard (plan section 9): the keys of the landing, the NFT perks, the site shell, /play, the
 * WL, collab, the mint, the API messages and the wallet picker name no ticker, no test network and no old name, show
 * no mint price or invented round, and use the straight apostrophe (only the two X posts keep the curly one, as
 * posts on X). No key is exempted.
 */
const VISITOR = /^(ld|nf|site|pg|wp|cb|mn|api|sw)\./;
const BANNED = /testnet|Elymum|Elysium|Localnet|Round 418|Round 001|No profit, no fee|One dollar|\$NIBAL|\$TEST/i;
const CURLY_OK = new Set(['wp.post', 'wp.post.no']);

describe('visitor copy guard', () => {
  const visitor = Object.entries(en).filter(([k]) => VISITOR.test(k));

  it('checks the visitor keys', () => {
    expect(visitor.length).toBeGreaterThan(500);
  });

  it('names no ticker, test network, old name, mint price or invented round', () => {
    expect(visitor.filter(([, v]) => BANNED.test(v)).map(([k, v]) => `${k}: ${v}`)).toEqual([]);
  });

  it('uses the straight apostrophe (the two X posts keep theirs)', () => {
    expect(visitor.filter(([k, v]) => v.includes('’') && !CURLY_OK.has(k)).map(([k]) => k)).toEqual([]);
  });

  it('says the fee on profit as a sentence, everywhere it is said', () => {
    for (const k of ['ld.ar.feeN', 'tf.feeNote', 'gr.feeNote'] as const) expect(en[k]).toMatch(/If you don't make a profit, you pay no fee\./);
  });
});
