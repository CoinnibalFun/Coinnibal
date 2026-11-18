import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadImage } from '@napi-rs/canvas';
import { NFT_SUPPLY } from '@elymum/shared';
import { describe, expect, it } from 'vitest';
import { NftCollection } from '../src/site/nft/collection';
import { artIndex, drawGenome, generateCollection, provenanceHash, rarityStats, revealOffset, sha256Hex, stream, tierQuotas } from '../src/site/nft/generate';
import { pixelGrid, pixelSvg } from '../src/site/nft/pixel';
import { renderEmblem } from '../src/site/nft/render';
import { EXCLUSIONS, LAYERS, MYTHICS, TIERS, TIER_SHARE, brokenRule, choicesFor, dna, type Genome } from '../src/site/nft/traits';
import { unrevealedSvg } from '../src/site/nft/unrevealed';
import { vectorSvg } from '../src/site/nft/vector';

const SEED = 'test-seed';
/** The collection at the owner's fixed supply (3,333, the NFT contract's max supply). */
const full = generateCollection(SEED, NFT_SUPPLY);

describe('emblem generator', () => {
  it('is deterministic for a seed and size, and differs between seeds', () => {
    const again = generateCollection(SEED, NFT_SUPPLY);
    expect(again.map(dna)).toEqual(full.map(dna));
    expect(provenanceHash(again)).toBe(provenanceHash(full));
    expect(provenanceHash(generateCollection('other', NFT_SUPPLY))).not.toBe(provenanceHash(full));
    expect(vectorSvg(full[7], 8)).toBe(vectorSvg(full[7], 8));
  });

  it('hands out the exact tier quotas (3,333: 2,000 / 833 / 366 / 127 / 7) and each 1/1 at most once', () => {
    expect(NFT_SUPPLY).toBe(3333);
    const st = rarityStats(full);
    expect(st.tiers).toEqual({ Common: 2000, Rare: 833, Epic: 366, Legendary: 127, Mythic: 7 });
    const names = full.filter((g) => g.tier === 'Mythic').map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(MYTHICS.map((g) => g.name)).toContain(n);
    // the generator itself: a collection large enough for every authored 1/1 (not the supply) has each exactly once
    const roomy = Math.round(MYTHICS.length / TIER_SHARE.Mythic);
    const big = generateCollection(SEED, roomy);
    expect(tierQuotas(roomy).Mythic).toBe(MYTHICS.length);
    expect(big.filter((g) => g.tier === 'Mythic').map((g) => g.name).sort()).toEqual(MYTHICS.map((g) => g.name).sort());
    for (const n of [1, 7, 333, 1000, 3333, 10_000]) {
      const q = tierQuotas(n);
      expect(TIERS.reduce((s, t) => s + q[t], 0)).toBe(n);
      expect(q.Mythic).toBeLessThanOrEqual(MYTHICS.length);
    }
  });

  it('has no duplicate DNA and breaks no exclusion rule (also small and odd sizes)', () => {
    for (const g of [full, generateCollection('s2', 777), generateCollection('s3', 1)]) {
      expect(new Set(g.map(dna)).size).toBe(g.length);
      expect(g.filter((x) => brokenRule(x)).length).toBe(0);
    }
    expect(MYTHICS.filter((g) => brokenRule(g))).toEqual([]);
  });

  it('keeps signature layers inside the token tier (the tier reads at a glance)', () => {
    for (const g of full) {
      if (g.tier === 'Mythic') continue;
      for (const key of ['background', 'material', 'effect'] as const) expect(choicesFor(key, g.tier).map(([v]) => v), `${dna(g)} ${key}`).toContain(g[key]);
    }
    // Commons never carry an effect, Legendaries always do and never wear a common hat
    expect(full.filter((g) => g.tier === 'Common' && g.effect !== 'None').length).toBe(0);
    expect(full.filter((g) => g.tier === 'Legendary' && (g.effect === 'None' || ['None', 'Cap', 'Beanie'].includes(g.headwear))).length).toBe(0);
  });

  it('matches the intended odds within tolerance (exact draws vs a large simulation)', () => {
    const SIM = 60_000;
    for (const tier of ['Common', 'Rare'] as const) {
      const r = stream('odds', tier);
      const sim = new Map<string, number>();
      for (let i = 0; i < SIM; i++) {
        const g = drawGenome(r, tier);
        for (const [, key] of LAYERS) sim.set(`${key}|${g[key]}`, (sim.get(`${key}|${g[key]}`) ?? 0) + 1 / SIM);
      }
      const inTier = full.filter((g) => g.tier === tier);
      for (const [k, p] of sim) {
        const [key, v] = k.split('|') as [keyof Genome, string];
        const n = inTier.filter((g) => g[key] === v).length;
        const sd = Math.sqrt(inTier.length * p * (1 - p));
        expect(Math.abs(n - inTier.length * p), `${tier} ${k}`).toBeLessThanOrEqual(5 * sd + 3);
      }
    }
  });

  it('never draws an excluded pair even before the reroll', () => {
    const r = stream('rules', 'x');
    for (let i = 0; i < 20_000; i++) {
      const tier = (['Common', 'Rare', 'Epic', 'Legendary'] as const)[i % 4];
      const g = drawGenome(r, tier);
      for (const rule of EXCLUSIONS) expect(g[rule.a[0]] === rule.a[1] && g[rule.b[0]] === rule.b[1]).toBe(false);
    }
  });

  it('maps tokens through the reveal offset as a permutation', () => {
    const offset = revealOffset('0x' + 'ab'.repeat(32), provenanceHash(full), NFT_SUPPLY);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(NFT_SUPPLY);
    const seen = new Set<number>();
    for (let id = 1; id <= NFT_SUPPLY; id++) seen.add(artIndex(id, offset, NFT_SUPPLY));
    expect(seen.size).toBe(NFT_SUPPLY);
  });
});

describe('emblem art', () => {
  const picks = [...TIERS.map((t) => full.find((g) => g.tier === t)!), ...MYTHICS];

  it('renders valid SVG in both styles for every tier and every 1/1', async () => {
    for (const g of picks) {
      for (const svg of [vectorSvg(g, 12), pixelSvg(g, 12)]) {
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
        expect(svg).not.toMatch(/undefined|NaN/);
        const img = await loadImage(Buffer.from(svg));
        expect(img.width).toBe(512);
      }
    }
  });

  it('draws every trait value without a hole (each value changes the picture)', () => {
    const base: Genome = { tier: 'Common', background: 'Seigaiha', material: 'Cyan', eyes: 'Round', mouth: 'Smile', headwear: 'None', accessory: 'None', effect: 'None' };
    for (const [, key, table] of LAYERS) {
      const seen = new Set<string>();
      for (const v of Object.keys(table)) {
        const g = { ...base, [key]: v } as Genome;
        const svgs = [vectorSvg(g, null), pixelSvg(g, null)];
        for (const svg of svgs) expect(svg).not.toMatch(/undefined|NaN/);
        seen.add(svgs.join(''));
      }
      expect(seen.size, key).toBe(Object.keys(table).length);
    }
  });

  it('keeps the house line: 3 px ink in the vector, a 64 x 64 grid with ink outlines in the pixel style', () => {
    const svg = vectorSvg(full[0], 1);
    expect(svg).toContain('stroke="#04181C" stroke-width="3"');
    expect(svg).not.toMatch(/Gradient|filter=|blur/);
    const grid = pixelGrid(full[0], 1);
    expect(grid.length).toBe(64 * 64);
    expect(grid.filter((c) => c === '#04181C').length).toBeGreaterThan(200);
    expect(renderEmblem(full[0], 1, 'pixel')).toBe(pixelSvg(full[0], 1));
  });

  it('frames tiers apart: tier tag on Rare and up, the 1/1 name on Mythics', () => {
    expect(vectorSvg(full.find((g) => g.tier === 'Common')!, 1)).not.toMatch(/>COMMON</);
    expect(vectorSvg(full.find((g) => g.tier === 'Legendary')!, 1)).toContain('>LEGENDARY<');
    expect(vectorSvg(MYTHICS[0], 9)).toContain('THE SUN EATER · 9');
  });
});

describe('NftCollection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elymum-nft-'));

  it('commits a random seed once, keeps it across restarts, and stores it privately', () => {
    const file = join(dir, 'a.json');
    const logs: string[] = [];
    const a = new NftCollection({ file, size: 500, seed: null, style: 'vector', log: (m) => logs.push(m) });
    const p = a.provenance();
    expect(p.seedHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(p.seed).toBeNull();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    expect(sha256Hex(stored.seed)).toBe(p.seedHash);
    expect(provenanceHash(generateCollection(stored.seed, 500))).toBe(p.provenance);
    // a later boot with another seed or size keeps the committed collection
    const b = new NftCollection({ file, size: 900, seed: 'something else', style: 'vector', log: (m) => logs.push(m) });
    expect(b.provenance()).toEqual(p);
    expect(logs.some((m) => m.includes('committed seed'))).toBe(true);
  });

  it('shows only the sealed emblem until the reveal, then the art of (id - 1 + offset)', async () => {
    const c = new NftCollection({ file: join(dir, 'b.json'), size: 300, seed: 'reveal-me', style: 'pixel' });
    expect(c.genomeOf(1)).toBeNull();
    expect(c.svg(5)).toBe(unrevealedSvg(5, 'pixel'));
    expect(c.metadata(5, 'https://x.example')).toEqual({
      name: 'Coinnibal No. 5',
      description: expect.stringContaining('not revealed yet'),
      image: 'https://x.example/api/nft/5.svg',
      external_url: 'https://x.example',
      attributes: [{ trait_type: 'Status', value: 'Sealed' }],
    });
    // the stats are public and say nothing about the mapping
    expect(c.stats()).toMatchObject({ size: 300, duplicates: 0 });

    expect(() => c.schedule({ block: null, current: 100n, mintOpen: true, soldOut: false, maxSupply: 300 })).toThrow(/Close the mint/);
    expect(() => c.schedule({ block: null, current: 100n, mintOpen: false, soldOut: false, maxSupply: 301 })).toThrow(/max supply/);
    expect(() => c.schedule({ block: 105n, current: 100n, mintOpen: false, soldOut: false, maxSupply: 300 })).toThrow(/ahead/);
    await expect(c.reveal(async () => '0x1')).rejects.toThrow(/Schedule/);
    // a sold-out mint may be revealed while the phase is still open
    expect(c.schedule({ block: 200n, current: 100n, mintOpen: true, soldOut: true, maxSupply: 300 }).revealBlock).toBe('200');
    // never moved once fixed (moving it after seeing the hash would pick the offset)
    expect(() => c.schedule({ block: 300n, current: 201n, mintOpen: false, soldOut: true, maxSupply: 300 })).toThrow(/cannot be moved/);
    await expect(c.reveal(async () => null)).rejects.toThrow(/not mined/);
    const hash = '0x' + '42'.repeat(32);
    const p = await c.reveal(async (n) => (n === 200n ? hash : null));
    const order = generateCollection('reveal-me', 300);
    expect(p).toMatchObject({ revealed: true, seed: 'reveal-me', blockHash: hash, offset: revealOffset(hash, provenanceHash(order), 300) });
    const g = order[(5 - 1 + p.offset!) % 300];
    expect(c.genomeOf(5)).toEqual(g);
    expect(c.svg(5)).toBe(pixelSvg(g, 5));
    expect(c.svg(5, 'vector')).toBe(vectorSvg(g, 5));

    // OpenSea metadata: Tier first, every layer, a numeric rank, the reveal block in the image URL
    const meta = c.metadata(5, 'https://x.example') as { attributes: { trait_type: string; value: unknown; display_type?: string }[]; image: string; background_color: string; name: string };
    expect(meta.attributes.map((a) => a.trait_type)).toEqual(['Tier', 'Background', 'Material', 'Eyes', 'Mouth', 'Headwear', 'Accessory', 'Effect', ...(g.name ? ['One of One'] : []), 'Rarity Rank']);
    expect(meta.attributes[0].value).toBe(g.tier);
    const rank = meta.attributes.at(-1)!;
    expect(rank).toMatchObject({ display_type: 'number', trait_type: 'Rarity Rank', max_value: 300 });
    expect(rank.value).toBeGreaterThanOrEqual(1);
    expect(meta.image).toBe('https://x.example/api/nft/5.svg?v=200');
    expect(meta.background_color).toMatch(/^[0-9A-F]{6}$/);
    expect(c.genomeOf(301)).toBeNull();

    // the reveal is persisted
    const again = new NftCollection({ file: join(dir, 'b.json'), size: 300, seed: null, style: 'pixel' });
    expect(again.genomeOf(5)).toEqual(g);
    await expect(again.reveal(async () => hash)).rejects.toThrow(/already revealed/);
  });

  it('refuses a tampered state file', () => {
    const file = join(dir, 'c.json');
    new NftCollection({ file, size: 10, seed: 'x', style: 'vector' });
    const s = JSON.parse(readFileSync(file, 'utf8'));
    s.seed = 'y';
    writeFileSync(file, JSON.stringify(s));
    expect(() => new NftCollection({ file, size: 10, seed: null, style: 'vector' })).toThrow(/does not match/);
  });
});
