import type { NftCollectionAdminView } from '@elymum/shared';
import { describe, expect, it } from 'vitest';
import { revealLine } from '../src/admin/EmblemsCard';

const view = (p: Partial<NftCollectionAdminView['provenance']>, mint: NftCollectionAdminView['mint'] = { phase: 'closed', totalSupply: 10, maxSupply: 5000, soldOut: false }): NftCollectionAdminView => ({
  provenance: { size: 5000, seedHash: '0x1', provenance: '0x2', committedAt: 1, revealBlock: null, revealed: false, seed: null, blockHash: null, offset: null, algorithm: '', ...p },
  stats: { size: 5000, quotas: {}, tiers: {}, layers: {}, duplicates: 0 },
  style: 'vector',
  currentBlock: '120',
  mint,
});

describe('admin emblems card', () => {
  it('says which reveal step the collection is at', () => {
    expect(revealLine(view({}, { phase: 'public', totalSupply: 10, maxSupply: 5000, soldOut: false }))).toMatch(/Close the mint/);
    expect(revealLine(view({}))).toMatch(/Schedule the reveal block/);
    expect(revealLine(view({ revealBlock: '170' }))).toBe('Reveal scheduled at block 170 (now 120). Reveal once it is mined.');
    expect(revealLine(view({ revealBlock: '170', revealed: true, offset: 42 }))).toMatch(/offset 42/);
  });
});
