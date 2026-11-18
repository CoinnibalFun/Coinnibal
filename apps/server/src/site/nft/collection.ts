/**
 * The emblem collection on this server: the committed seed, the provenance, the reveal, the metadata and the
 * rarity stats (docs/NFT-DESIGN.md, "Fair mint"). The contract is untouched: `tokenURI(id) = baseURI + id`
 * points here, and this service decides what `/api/nft/<id>` shows.
 *
 * Flow:
 *  1. **Commit** (first boot): a random 32-byte seed is generated (or `NFT_COLLECTION_SEED`), the art order is
 *     generated from it, and `seedHash = sha256(seed)` and `provenance = sha256(concat sha256(dna_i))` are
 *     stored and published at `/api/nft/provenance` (and should be put on chain with `setContractURI`
 *     before the mint opens). From then on the seed never changes.
 *  2. **Mint**: every token shows the sealed emblem; nobody (the team included) knows which token gets which
 *     art, because the offset does not exist yet.
 *  3. **Schedule** (admin, mint closed or sold out): a reveal block in the future is fixed.
 *  4. **Reveal** (admin, once that block is mined): `offset = sha256(blockHash ‖ provenance) mod size`, the seed
 *     is published, and token `t` shows art `(t - 1 + offset) mod size`. Anyone can re-run the generator and
 *     check both hashes and the offset.
 */
import { BRAND_NAME, NFT_NAME, type NftProvenance, type NftRarityStats } from '@elymum/shared';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { TIER_FRAME } from './palette';
import { artIndex, generateCollection, provenanceHash, rarityStats, revealOffset, sha256Hex, tierQuotas } from './generate';
import { renderEmblem, type ArtStyle } from './render';
import { LAYERS, type Genome, type Tier } from './traits';
import { unrevealedSvg } from './unrevealed';

/** The collection state file in the chain's state directory (holds the secret seed until the reveal). */
export const NFT_COLLECTION_FILE = 'nft-collection.json';
/** A reveal block must be at least this many blocks ahead when it is scheduled. */
export const REVEAL_MIN_DELAY_BLOCKS = 10;
/** The default distance of a scheduled reveal block. */
export const REVEAL_DEFAULT_DELAY_BLOCKS = 50;

interface StoredCollection {
  version: 1;
  size: number;
  seed: string;
  seedHash: string;
  provenance: string;
  committedAt: number;
  /** The scheduled reveal block (decimal string) and when it was scheduled. */
  revealBlock: string | null;
  scheduledAt: number | null;
  reveal: { block: string; blockHash: string; offset: number; revealedAt: number } | null;
}

/** `GET /api/nft/provenance`: everything needed to verify the collection (the seed only after the reveal). */
type ProvenanceView = NftProvenance;

export interface CollectionDeps {
  /** The state file (null: memory only, e.g. tests). */
  file: string | null;
  size: number;
  /** `NFT_COLLECTION_SEED`: used only when nothing is committed yet. */
  seed: string | null;
  style: ArtStyle;
  log?: (m: string) => void;
  now?: () => number;
}

export class CollectionFail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class NftCollection {
  private state: StoredCollection;
  private genomesV: Genome[] | null = null;
  private ranksV: number[] | null = null;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  readonly style: ArtStyle;

  constructor(private readonly deps: CollectionDeps) {
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? Date.now;
    this.style = deps.style;
    this.state = this.load() ?? this.commit();
  }

  private load(): StoredCollection | null {
    const p = this.deps.file;
    if (!p || !existsSync(p)) return null;
    const s = JSON.parse(readFileSync(p, 'utf8')) as StoredCollection;
    if (s?.version !== 1 || typeof s.seed !== 'string' || !Number.isSafeInteger(s.size)) throw new Error(`${p}: not an emblem collection file`);
    if (sha256Hex(s.seed) !== s.seedHash) throw new Error(`${p}: the seed does not match its committed hash`);
    if (this.deps.seed && this.deps.seed !== s.seed) this.log(`nft: NFT_COLLECTION_SEED differs from the committed seed in ${p}; the committed one stays (the provenance is public)`);
    if (this.deps.size !== s.size) this.log(`nft: NFT_COLLECTION_SIZE=${this.deps.size} differs from the committed size ${s.size}; the committed one stays`);
    return s;
  }

  private commit(): StoredCollection {
    const seed = this.deps.seed ?? `0x${randomBytes(32).toString('hex')}`;
    const genomes = generateCollection(seed, this.deps.size);
    this.genomesV = genomes;
    const s: StoredCollection = {
      version: 1,
      size: this.deps.size,
      seed,
      seedHash: sha256Hex(seed),
      provenance: provenanceHash(genomes),
      committedAt: this.now(),
      revealBlock: null,
      scheduledAt: null,
      reveal: null,
    };
    this.state = s;
    this.save();
    this.log(`nft: collection committed: ${s.size} emblems, seed hash ${s.seedHash}, provenance ${s.provenance}`);
    return s;
  }

  private save(): void {
    const p = this.deps.file;
    if (!p) return;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(`${p}.tmp`, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(`${p}.tmp`, p);
    try {
      chmodSync(p, 0o600);
    } catch {
      /* not every file system has modes */
    }
  }

  /** The art order (generated once, ~100 ms for the 3,333 of the collection). */
  private get genomes(): Genome[] {
    this.genomesV ??= generateCollection(this.state.seed, this.state.size);
    return this.genomesV;
  }

  get size(): number {
    return this.state.size;
  }

  get revealed(): boolean {
    return this.state.reveal !== null;
  }

  provenance(): ProvenanceView {
    const r = this.state.reveal;
    return {
      size: this.state.size,
      seedHash: this.state.seedHash,
      provenance: this.state.provenance,
      committedAt: this.state.committedAt,
      revealBlock: this.state.revealBlock,
      revealed: r !== null,
      seed: r ? this.state.seed : null,
      blockHash: r?.blockHash ?? null,
      offset: r?.offset ?? null,
      algorithm:
        'art order = generateCollection(seed, size) (apps/server/src/site/nft/generate.ts); seedHash = sha256(seed); provenance = sha256(concat(sha256(dna_i))); offset = uint256(sha256(blockHash ‖ provenance)) mod size; token t shows art (t - 1 + offset) mod size',
    };
  }

  /** The genome of token `id`; null before the reveal (or for an id beyond the collection). */
  genomeOf(id: number): Genome | null {
    const r = this.state.reveal;
    if (!r || id < 1 || id > this.state.size) return null;
    return this.genomes[artIndex(id, r.offset, this.state.size)];
  }

  /** The SVG of token `id` (the sealed emblem before the reveal). */
  svg(id: number, style: ArtStyle = this.style): string {
    const g = this.genomeOf(id);
    return g ? renderEmblem(g, id, style) : unrevealedSvg(id, style);
  }

  /** Statistical rarity rank of each art index (1 = rarest). */
  private get ranks(): number[] {
    if (!this.ranksV) {
      const { scores } = rarityStats(this.genomes);
      const order = scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
      this.ranksV = new Array<number>(scores.length);
      order.forEach(([, i], k) => (this.ranksV![i] = k + 1));
    }
    return this.ranksV;
  }

  /** ERC-721 metadata JSON (OpenSea attributes) of a minted token. */
  metadata(id: number, baseUrl: string): Record<string, unknown> {
    const g = this.genomeOf(id);
    if (!g) {
      return {
        name: `${NFT_NAME} No. ${id}`,
        description: `A ${NFT_NAME} NFT, not revealed yet. Every NFT is revealed at once after the mint, from a seed committed before it (see /api/nft/provenance). Holders get perks in ${BRAND_NAME}, the game where coins eat coins, on Robinhood Chain.`,
        image: `${baseUrl}/api/nft/${id}.svg`,
        external_url: baseUrl,
        attributes: [{ trait_type: 'Status', value: 'Sealed' }],
      };
    }
    const r = this.state.reveal!;
    const rank = this.ranks[artIndex(id, r.offset, this.state.size)];
    const attributes: Record<string, unknown>[] = [{ trait_type: 'Tier', value: g.tier }];
    for (const [label, key] of LAYERS) attributes.push({ trait_type: label, value: g[key] });
    if (g.name) attributes.push({ trait_type: 'One of One', value: g.name });
    attributes.push({ display_type: 'number', trait_type: 'Rarity Rank', value: rank, max_value: this.state.size });
    return {
      name: g.name ? `${NFT_NAME} No. ${id}: ${g.name}` : `${NFT_NAME} No. ${id}`,
      description: `${tierLine(g.tier)} Holders play ${BRAND_NAME}, the arena where the coins eat, on Robinhood Chain.`,
      // the reveal block in the URL: marketplaces that cached the sealed picture fetch the new one
      image: `${baseUrl}/api/nft/${id}.svg?v=${r.block}`,
      external_url: baseUrl,
      background_color: TIER_FRAME[g.tier][0].slice(1),
      attributes,
    };
  }

  /** Aggregate counts of the whole collection (public: it tells nothing about which token gets what). */
  stats(): NftRarityStats & { quotas: Record<Tier, number>; tiers: Record<Tier, number> } {
    const { size, tiers, layers, duplicates } = rarityStats(this.genomes);
    return { size, quotas: tierQuotas(size), tiers, layers, duplicates };
  }

  /**
   * Fixes the reveal block, once: at least `REVEAL_MIN_DELAY_BLOCKS` ahead of `current`. Refused once scheduled, while
   * the mint is open and not sold out (later mints could pick their art), or when the contract can mint more
   * tokens than the collection holds.
   */
  schedule(opts: { block: bigint | null; current: bigint; mintOpen: boolean; soldOut: boolean; maxSupply: number }): ProvenanceView {
    if (this.state.reveal) throw new CollectionFail(409, 'revealed', 'The collection is already revealed.');
    // once fixed, never moved: moving it after seeing the block's hash would be choosing the offset
    if (this.state.revealBlock) throw new CollectionFail(409, 'scheduled', `The reveal is already scheduled at block ${this.state.revealBlock}; it cannot be moved.`);
    if (opts.mintOpen && !opts.soldOut) throw new CollectionFail(409, 'mint_open', 'Close the mint (or sell out) before scheduling the reveal: tokens minted after it could pick their art.');
    if (opts.maxSupply > this.state.size) {
      throw new CollectionFail(409, 'supply_too_large', `The contract's max supply (${opts.maxSupply}) is above the collection size (${this.state.size}): lower it first.`);
    }
    const block = opts.block ?? opts.current + BigInt(REVEAL_DEFAULT_DELAY_BLOCKS);
    if (block < opts.current + BigInt(REVEAL_MIN_DELAY_BLOCKS)) {
      throw new CollectionFail(400, 'bad_request', `The reveal block must be at least ${REVEAL_MIN_DELAY_BLOCKS} blocks ahead (current ${opts.current}).`);
    }
    this.state.revealBlock = block.toString();
    this.state.scheduledAt = this.now();
    this.save();
    this.log(`nft: reveal scheduled at block ${block} (current ${opts.current})`);
    return this.provenance();
  }

  /** Reveals with the hash of the scheduled block (`blockHash` returns null while it is not mined). */
  async reveal(blockHash: (n: bigint) => Promise<string | null>): Promise<ProvenanceView> {
    if (this.state.reveal) throw new CollectionFail(409, 'revealed', 'The collection is already revealed.');
    if (!this.state.revealBlock) throw new CollectionFail(409, 'not_scheduled', 'Schedule the reveal block first.');
    const block = BigInt(this.state.revealBlock);
    const hash = await blockHash(block);
    if (!hash) throw new CollectionFail(409, 'too_early', `Block ${block} is not mined yet.`);
    const offset = revealOffset(hash, this.state.provenance, this.state.size);
    this.state.reveal = { block: block.toString(), blockHash: hash, offset, revealedAt: this.now() };
    this.save();
    this.log(`nft: revealed with block ${block} (${hash}): offset ${offset}, seed ${this.state.seed}`);
    return this.provenance();
  }
}

function tierLine(t: Tier): string {
  switch (t) {
    case 'Common':
      return `A ${NFT_NAME} NFT: a coin character.`;
    case 'Rare':
      return `A Rare ${NFT_NAME} NFT: a metal coin.`;
    case 'Epic':
      return `An Epic ${NFT_NAME} NFT: a coin made of something precious.`;
    case 'Legendary':
      return `A Legendary ${NFT_NAME} NFT: one of the few coins of glass, crystal and foil.`;
    case 'Mythic':
      return `A Mythic ${NFT_NAME} NFT: one of ten one-of-a-kind coins.`;
  }
}
