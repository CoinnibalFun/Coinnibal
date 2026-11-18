/**
 * The Elymum emblem collection, generated from a collection seed (docs/NFT-DESIGN.md):
 *
 *  1. exact tier quotas (largest remainder of `TIER_SHARE`), shuffled by the seed into the "art order";
 *  2. each slot rolls its layers from its tier's weighted pools (`choicesFor`), rerolling on a broken
 *     exclusion rule or a DNA already taken (zero duplicates);
 *  3. the provenance hash commits to the whole art order: `sha256(concat(sha256(dna_i)))`, published (with
 *     `sha256(seed)`) before the mint;
 *  4. after the mint a future block's hash fixes the reveal offset, and token `t` shows art `(t-1+offset) % N`.
 *
 * Same seed and size, same collection, on every machine.
 */
import { createHash } from 'node:crypto';
import { EXCLUSIONS, MYTHICS, TIERS, TIER_SHARE, LAYERS, brokenRule, choicesFor, dna, type Genome, type LayerKey, type Tier } from './traits';

const sha256 = (data: string | Buffer): Buffer => createHash('sha256').update(data).digest();
export const sha256Hex = (data: string | Buffer): string => `0x${sha256(data).toString('hex')}`;

/** A small fast PRNG (sfc32) seeded from sha256(seed ‖ label): independent streams per label. */
export function stream(seed: string, label: string): () => number {
  const h = sha256(`${seed}\u0000${label}`);
  let a = h.readUInt32LE(0);
  let b = h.readUInt32LE(4);
  let c = h.readUInt32LE(8);
  let d = h.readUInt32LE(12);
  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

function weighted(r: () => number, choices: [string, number][]): string {
  const total = choices.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of choices) {
    x -= w;
    if (x < 0) return v;
  }
  return choices[choices.length - 1][0];
}

/** Exact tier counts for `size` tokens (largest remainder; Mythics capped at the authored 1/1s). */
export function tierQuotas(size: number): Record<Tier, number> {
  const mythic = Math.min(MYTHICS.length, Math.round(size * TIER_SHARE.Mythic));
  const rolled = TIERS.filter((t) => t !== 'Mythic');
  const shareSum = rolled.reduce((s, t) => s + TIER_SHARE[t], 0);
  const rest = size - mythic;
  const raw = rolled.map((t) => (rest * TIER_SHARE[t]) / shareSum);
  const out = raw.map((x) => Math.floor(x));
  let left = rest - out.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((p, q) => q[0] - p[0] || p[1] - q[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return { Common: out[0], Rare: out[1], Epic: out[2], Legendary: out[3], Mythic: mythic };
}

/** Layers are drawn in this order: the tier's signature first. */
const DRAW_ORDER: readonly LayerKey[] = ['material', 'background', 'effect', 'eyes', 'mouth', 'headwear', 'accessory'];

/** Whether `layer = value` breaks a rule with a layer `g` already has. */
function clashes(g: Genome, layer: LayerKey, value: string): boolean {
  for (const r of EXCLUSIONS) {
    if (r.a[0] === layer && r.a[1] === value && g[r.b[0]] === r.b[1]) return true;
    if (r.b[0] === layer && r.b[1] === value && g[r.a[0]] === r.a[1]) return true;
  }
  return false;
}

/**
 * One draw of a rolled tier: layer by layer, each from the values that break no rule with the layers already
 * drawn (so the material's odds hold exactly and only the later layers bend around the rules).
 */
export function drawGenome(r: () => number, tier: Exclude<Tier, 'Mythic'>): Genome {
  const cand = { tier } as Genome;
  const set = cand as unknown as Record<LayerKey, string>;
  for (const key of DRAW_ORDER) set[key] = weighted(r, choicesFor(key, tier).filter(([v]) => !clashes(cand, key, v)));
  return cand;
}

/** Most rerolls a slot gets before its pools are taken as exhausted (never reached at the collection's 3,333). */
const MAX_REROLLS = 10_000;

/** The art order: `size` unique genomes. Throws when a tier's pools cannot hold its quota. */
export function generateCollection(seed: string, size: number): Genome[] {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError(`collection size must be a positive integer, got ${size}`);
  const q = tierQuotas(size);
  const tiers: Tier[] = [];
  for (const t of TIERS) for (let i = 0; i < q[t]; i++) tiers.push(t);
  const order = stream(seed, 'order');
  for (let i = tiers.length - 1; i > 0; i--) {
    const j = Math.floor(order() * (i + 1));
    [tiers[i], tiers[j]] = [tiers[j], tiers[i]];
  }
  const mythics = [...MYTHICS];
  const mo = stream(seed, 'mythics');
  for (let i = mythics.length - 1; i > 0; i--) {
    const j = Math.floor(mo() * (i + 1));
    [mythics[i], mythics[j]] = [mythics[j], mythics[i]];
  }
  const taken = new Set<string>();
  const out: Genome[] = [];
  for (let i = 0; i < size; i++) {
    const tier = tiers[i];
    if (tier === 'Mythic') {
      const g = { ...mythics.pop()! };
      taken.add(dna(g));
      out.push(g);
      continue;
    }
    const r = stream(seed, `slot:${i}`);
    let g: Genome | null = null;
    for (let tries = 0; tries < MAX_REROLLS; tries++) {
      const cand = drawGenome(r, tier);
      if (brokenRule(cand) || taken.has(dna(cand))) continue;
      g = cand;
      break;
    }
    if (!g) throw new Error(`the ${tier} pools cannot hold ${q[tier]} unique tokens`);
    taken.add(dna(g));
    out.push(g);
  }
  return out;
}

/** The provenance hash of an art order: sha256 of the concatenated sha256 of each DNA line. */
export function provenanceHash(genomes: readonly Genome[]): string {
  return sha256Hex(Buffer.concat(genomes.map((g) => sha256(dna(g)))));
}

/** The reveal offset: sha256(blockHash ‖ provenance) mod size (nobody knows the block hash before it is mined). */
export function revealOffset(blockHash: string, provenance: string, size: number): number {
  const h = sha256(`${blockHash.toLowerCase()}${provenance.toLowerCase()}`);
  return Number(BigInt(`0x${h.toString('hex')}`) % BigInt(size));
}

/** Art index of token `id` (ids start at 1). */
export const artIndex = (id: number, offset: number, size: number): number => (id - 1 + offset) % size;

/** Per-layer value counts and per-token statistical rarity rank (1 = rarest), for reports and the admin view. */
export function rarityStats(genomes: readonly Genome[]): {
  size: number;
  tiers: Record<Tier, number>;
  layers: Record<string, Record<string, number>>;
  duplicates: number;
  /** Rank by the sum of -log2(share) over the layers (the OpenRarity idea), index order. */
  scores: number[];
} {
  const layers: Record<string, Record<string, number>> = {};
  const tiers = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
  for (const g of genomes) {
    tiers[g.tier]++;
    for (const [name, key] of LAYERS) {
      const m = (layers[name] ??= {});
      m[g[key]] = (m[g[key]] ?? 0) + 1;
    }
  }
  const n = genomes.length;
  const scores = genomes.map((g) => {
    let s = -Math.log2(tiers[g.tier] / n);
    for (const [name, key] of LAYERS) s += -Math.log2(layers[name][g[key]] / n);
    return Math.round(s * 100) / 100;
  });
  return { size: n, tiers, layers, duplicates: n - new Set(genomes.map(dna)).size, scores };
}
