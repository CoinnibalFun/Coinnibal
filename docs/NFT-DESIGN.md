# The Coinnibal emblem collection: design, rarity and fair reveal

The Coinnibal NFT ("emblems") is a 3,333-token PFP collection (`NFT_SUPPLY`). Each emblem is a portrait of a Coinnibal coin creature
drawn in the game's Ring Storybook style. Traits are layered, rarity comes in five tiers, and the reveal is
provably fair. This page covers the research behind the design, the design system, the odds, the comparison
between the two art styles, and the commit-and-reveal flow. Researched and built 2026-11-05.

Code: `apps/server/src/site/nft/` (see [Files](#files)). Previews: `pnpm -F @coinnibal/server nft:sheets` writes the
contact sheets (`compare.png`, `vector-tiers.png`, `pixel-tiers.png`, `vector-traits.png`, `pixel-traits.png`,
`rarity-table.png`, `unrevealed.png`) to `out/nft2/`. Distribution proof: `pnpm -F @coinnibal/server nft:report`.

## 1. Research

### How successful PFP collections structure traits and rarity

- **Layers.** Generative PFPs stack 5 to 8 transparent layers in a fixed order: background, body or skin, eyes,
  mouth, headwear, clothing or accessory, and sometimes an effect. Each trait value lives on its own layer over a
  shared canvas grid. The design work is making every combination look intentional
  ([HashLips art engine](https://github.com/HashLips/hashlips_art_engine),
  [rarity generator walkthrough](https://dev.to/rounakbanik/create-generative-nft-art-with-rarities-1n6f),
  [NiftyKit asset guidelines](https://docs.niftykit.com/get-started/getting-started/art-generator-asset-guidelines)).
- **Weights, not a coin flip.** Rarity is a weight per trait value. A token's overall rarity is the combination
  of its layers. Most collections put about 50 to 70 % of tokens in the plain bucket, with a long tail of named
  rare values. Our current generator draws everything uniformly (5 paints, 7 moods, sweat 8 %, feet 50 %), so
  almost no token reads as rarer than another. That is the main thing to fix.
- **Why rares read as rare.** The collections with the strongest rarity signal (CryptoPunks' aliens, apes and
  zombies; BAYC's gold and trippy fur; Azuki's spirit and golden types) change the **material** of the character,
  not just one hat. A rare token uses a different substance (gold, glass, foil), a special background, and an
  effect, so it reads at thumbnail size. A few hand-made **1/1s** sit on top of the rolled tiers and become the
  collection's landmarks
  ([The mysteries of PFP rarity](https://fortunefriendsclub.substack.com/p/the-mysteries-of-pfp-rarity),
  [NFT traits overview](https://traitsniper.substack.com/p/nft-traits-overview-for-newcomers)).
- **Rarity rank.** Marketplaces rank tokens by information content: each trait contributes `-log2(p)` bits,
  summed. A trait on every token adds nothing, so trait count matters. This is the OpenRarity standard, adopted
  by OpenSea ([methodology](https://openrarity.gitbook.io/developers/fundamentals/methodology),
  [introduction](https://mirror.xyz/openrarity.eth/-R8ZA5KCMgqtsueySlruAhB77YBX6fSnS_dT-8clZPQ)). Our metadata
  ships the same score as `Rarity Rank`.

### What makes a collection look cheap or like "AI slop"

These are the failure modes we design against. Each one has a guard in the code.

| Failure | What it looks like | Our guard |
|---|---|---|
| Incoherent palette | every trait picks its own hues; neon next to pastel | one palette (`nft/palette.ts`) built on the game's `ELYSIUM` paints plus a few curated material colours; every pixel comes from it |
| Random clutter | many unrelated props stacked on one character | at most one item per slot. Commons have no effect at all. Exclusion rules stop pairs that crowd or contradict each other |
| Inconsistent line weight | traits drawn at different scales, so outlines go 1 px here and 6 px there | vector: one 3 px ink line (`LW`), scaled back inside the coin group. Pixel: a single outline pass, always 1 px of ink |
| Generic gradients, glows, blur | the "rendered in a hurry" look | no gradient, filter or blur anywhere (a test checks this). Cel fills with one hard shade, as in the game |
| Hue-swap rarity | the legendary is the common in another colour | materials change the rendering: reeded metal, stone veins, glass facets, foil bands, molten cracks |
| Low contrast | gold coin on a gold sky | contrast exclusions (material against background), plus a rim light on dark materials |
| Off-model | the NFT does not look like the game | same coin geometry, eyes, cheeks, feet and ink as `packages/art` and the storybook reference |

### Metadata standards

- ERC-721 metadata JSON: `name`, `description`, `image`, plus OpenSea's `external_url`, `background_color`
  (hex without `#`) and `attributes` ([OpenSea metadata standards](https://docs.opensea.io/docs/metadata-standards),
  [media and traits](https://docs.opensea.io/docs/media-and-traits)).
- `attributes` is an array of `{ trait_type, value }`. A numeric trait takes `display_type` (`number`,
  `boost_number`, `boost_percentage`, `date`) and an optional `max_value`.
- ERC-4906 `MetadataUpdate` / `BatchMetadataUpdate` tells marketplaces to re-fetch `tokenURI`
  ([EIP-4906](https://eips.ethereum.org/EIPS/eip-4906)). CoinnibalNFT emits `BatchMetadataUpdate(1, max)` from
  `setBaseURI`, so the reveal can be announced without a new contract.

### Fair-mint provenance

- **BAYC's scheme** (the reference most collections copy): before the sale, the team publishes
  `PROVENANCE = sha256(concat(sha256(image_i)))` over the images in their original order. After the sale (or at a
  reveal time), `startingIndex = uint(blockhash(startingIndexBlock)) % 10000` comes from a block nobody could
  predict. Token `t` gets image `(t + startingIndex) % 10000`. Nobody, the team included, can steer a rare to a
  chosen token id ([BAYC contract source](https://etherscan.io/address/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d#code)).
- **Variants:** Chainlink VRF as the entropy source (stronger, but it needs a contract integration and a
  subscription), and a commit to a seed (the generator's input) instead of a hash per image (cheaper, and anyone
  can re-run the generator).
- **The sniping risks** are a reveal that starts while the mint is open (the next ids become predictable), an
  offset the team can re-roll, and traits computed on chain from the token id at mint time.

## 2. Design system

**The character** is our coin creature, framed as a portrait. It uses the same 46-unit geometry as
`packages/art`: eyes at (±15, −6), cheeks at (±27, 9), a lit disc offset (−6, −8) for the one hard shade, an
inner groove, a highlight arc, little feet, and a 3 px ink outline.

**The layers, in drawing order:**

1. Frame band (by tier)
2. Background (a scene from the game world)
3. Effect, back half (flames, starburst, halo ring)
4. Shadow and feet
5. Coin material
6. Cheeks, eyes and mouth
7. Accessory
8. Headwear
9. Effect, front half (sparkles, notes, bolts)
10. Frame front (window line, rivets, tier tag, number tag)

**Signature layers and character layers.** Background, Material and Effect are *signature* layers: they come
only from the token's own tier, so the tier shows at a glance. Any silver or gold coin is Rare, and any obsidian,
crystal or holographic coin is Legendary. Eyes, Mouth, Headwear and Accessory are *character* layers: higher
tiers can also draw lower-tier values, at lower weights. A Legendary can still smile like a Common, but it never
wears a cap.

**The frame by tier:**

| Tier | Frame | Rivets | Tag |
|---|---|---|---|
| Common | cream | none | none |
| Rare | cyan | 4 | RARE |
| Epic | violet | 10 | EPIC |
| Legendary | gold | a full row, cream studs | LEGENDARY |
| Mythic | holographic foil | none | MYTHIC (ink), and the 1/1's name on the number tag |

**Materials** change the rendering, not just the colour:

| Material | Tier | Rendering |
|---|---|---|
| Cyan, Teal, Foam, Mint, Cream, Copper | Common | the game's own skins: flat cel paint, groove, highlight |
| Silver, Gold | Rare | struck metal: reeded edge (72 ticks), stamped bead ring, two hard shine stripes |
| Rose Gold | Epic | struck metal, warm |
| Jade | Epic | stone: light veins, specks, a polished ring |
| Pearl | Epic | nacre: pink, foam and lilac sheen patches |
| Obsidian | Legendary | black glass: facets, a cyan rim light, a cream face (so the mouth still reads) |
| Crystal | Legendary | faceted: six translucent facets with white edges |
| Holographic | Legendary | foil: five pastel bands at 35°, a translucent shade |
| Molten Sun, Void, Moonstone, Prismatic, Ancient Gold | Mythic only | cracked crust with glowing seams; a starfield inside the coin; craters; saturated foil; gold with patina |

**Palette:** the `ELYSIUM` paints (ink `#04181C`, trench, reef, teal, cyan, foam, mist, cream, sun, coral, blush,
meadow, clover, verdant), each with its one `SHADE`. Added only where the game palette has no word for it:
violet (the Epic tier), silver, rose, jade, pearl, obsidian, crystal, tan (the cowboy hat), and the five foil
pastels.

### Tiers

The generator does not roll tiers. It hands out exact quotas (largest remainder), shuffled by the seed:

| Tier | Share | Of 3,333 |
|---|---:|---:|
| Common | 60 % | 2,000 |
| Rare | 25 % | 833 |
| Epic | 11 % | 366 |
| Legendary | 3.8 % | 127 |
| Mythic (1/1s) | 0.2 % | 7 |

The brief suggested Legendary 3.5 % and Mythic 0.5 %. At 3,333 tokens 0.5 % is about 17 Mythics, too many to stay
landmarks: the Mythic share is 0.2 % (7 tokens, each one of the hand-authored, named 1/1s below) and the difference
went to Legendary.

**The ten 1/1s:** The Sun Eater, The Abyss, The Moon Coin, The Prism, The First Coin, The Ember King, The Night
Swimmer, The Last Bite, The Dreamer, The Old Gold. Each one has a Mythic-only material, background and effect,
and a `One of One` attribute.

At 3,333 tokens the Mythic quota is 7 (0.2 %), so only 7 of the ten hand-authored 1/1s are in the collection. The
seed picks which 7 (a seeded shuffle of the ten, `generate.ts`); the other 3 are left out. Open owner decision: keep
the ten-1/1 list as it is, or choose the 7 by hand (`TIER_SHARE` is unchanged either way).

### Odds per tier

Share of each value within a token's tier, before the exclusion rules (which shift a few points; see the report).
Tables are generated from `nft/traits.ts`.

**Background** (signature)

| Value | Common | Rare | Epic | Legendary |
|---|--:|--:|--:|--:|
| Dawn Plain | 30 % | – | – | – |
| Shallows | 25 % | – | – | – |
| Seigaiha | 20 % | – | – | – |
| Night Ring | 25 % | – | – | – |
| Sunset Ring | – | 35 % | – | – |
| Deep Sea | – | 35 % | – | – |
| Moon Night | – | 30 % | – | – |
| Aurora | – | – | 50 % | – |
| Treasury | – | – | 50 % | – |
| Cosmos | – | – | – | 50 % |
| Golden Rays | – | – | – | 50 % |

Mythic only: Eclipse, Abyss, Prism, Origin.

**Material** (signature): Common: Cyan 18, Teal 18, Foam 16, Mint 16, Cream 14, Copper 18 %. Rare: Silver 50,
Gold 50 %. Epic: Rose Gold 35, Jade 35, Pearl 30 %. Legendary: Obsidian 34, Crystal 33, Holographic 33 %.

**Effect** (signature): Common: none. Rare: None 45, Sparkles 30, Bubbles 25 %. Epic: Orbit Coins 40, Hearts 30,
Notes 30 %. Legendary: Flames 34, Lightning 33, Starburst 33 %. Mythic only: Corona, Embers, Starfall, Prism Halo.

**Eyes**

| Value | Common | Rare | Epic | Legendary |
|---|--:|--:|--:|--:|
| Round | 19.5 % | 14.5 % | 9.5 % | 5.7 % |
| Happy | 18.4 % | 10.9 % | 7.6 % | 3.8 % |
| Sleepy | 13.8 % | 7.3 % | 4.8 % | 2.9 % |
| Wink | 13.8 % | 9.1 % | 7.6 % | 4.8 % |
| Smug | 16.1 % | 10.9 % | 9.5 % | 7.6 % |
| Determined | 18.4 % | 10.9 % | 9.5 % | 7.6 % |
| Dizzy | – | 9.1 % | 5.7 % | 2.9 % |
| Star | – | 14.5 % | 11.4 % | 9.5 % |
| Shades | – | 12.7 % | 9.5 % | 7.6 % |
| Heart | – | – | 24.8 % | 13.3 % |
| Glow | – | – | – | 34.3 % |

**Mouth**

| Value | Common | Rare | Epic | Legendary |
|---|--:|--:|--:|--:|
| Smile | 20.5 % | 18.0 % | 12.0 % | 8.0 % |
| Grin | 22.7 % | 15.0 % | 12.0 % | 10.0 % |
| Cat | 18.2 % | 12.0 % | 10.0 % | 6.0 % |
| Ooh | 15.9 % | 10.0 % | 6.0 % | 4.0 % |
| Smirk | 22.7 % | 15.0 % | 12.0 % | 10.0 % |
| Tongue | – | 14.0 % | 12.0 % | 8.0 % |
| Fang | – | 16.0 % | 14.0 % | 12.0 % |
| Chomp | – | – | 22.0 % | 18.0 % |
| Gold Tooth | – | – | – | 24.0 % |

**Headwear**

| Value | Common | Rare | Epic | Legendary |
|---|--:|--:|--:|--:|
| None | 21.1 % | 13.3 % | 5.2 % | – |
| Cap | 18.4 % | 8.9 % | 4.2 % | – |
| Beanie | 18.4 % | 8.9 % | 4.2 % | – |
| Flower | 15.8 % | 7.8 % | 3.1 % | – |
| Party Hat | 13.2 % | 7.8 % | 3.1 % | – |
| Sprout | 13.2 % | 6.7 % | 3.1 % | – |
| Propeller | – | 15.6 % | 7.3 % | – |
| Cowboy | – | 15.6 % | 7.3 % | – |
| Headphones | – | 15.6 % | 8.3 % | – |
| Viking | – | – | 15.6 % | 10.0 % |
| Wizard | – | – | 14.6 % | 10.0 % |
| Top Hat | – | – | 12.5 % | 10.0 % |
| Laurel | – | – | 11.5 % | 10.0 % |
| Crown | – | – | – | 30.0 % |
| Halo | – | – | – | 30.0 % |

**Accessory**

| Value | Common | Rare | Epic | Legendary |
|---|--:|--:|--:|--:|
| None | 33.9 % | 32.4 % | 19.7 % | 18.5 % |
| Scarf | 25.4 % | 17.6 % | 10.5 % | 7.4 % |
| Bandana | 20.3 % | 14.7 % | 7.9 % | 5.6 % |
| Bow Tie | 20.3 % | 14.7 % | 10.5 % | 9.3 % |
| Medal | – | 20.6 % | 13.2 % | 14.8 % |
| Monocle | – | – | 18.4 % | 18.5 % |
| Gold Chain | – | – | 19.7 % | 25.9 % |

The resulting whole-collection counts for the preview seed are in `out/nft2/rarity-table.png`. Example: Halo 0.9 %,
Glow eyes 1.2 %, Obsidian 1.3 %. A Mythic-only value is on at most 3 tokens of the 3,333 (0.09 %), and on none when
the seed leaves its 1/1s out (`pnpm -F @coinnibal/server nft:report --seed <s>` gives the counts of one seed).

### Exclusion rules

Pairs that never meet on one token (`EXCLUSIONS` in `nft/traits.ts`; the 1/1s obey them too):

- **Contrast:** Foam × Shallows, Cream × Seigaiha, Teal × Night Ring, Mint × Dawn Plain, Gold × Sunset Ring,
  Jade × Aurora, Rose Gold × Treasury.
- **Same colour twice:** a gold chain or a gold medal on a Gold coin; a gold chain on Ancient Gold.
- **Cannot be worn together, or contradicts itself:** Monocle with Shades, Wink, Happy, Sleepy, Heart or Dizzy
  eyes; Halo × Fang; Headphones × Notes; Starburst × Golden Rays; Bubbles × Sunset Ring; Sleepy × Lightning;
  Shades × Moon Night.

**How the generator applies them.** It draws layer by layer: material, background, effect, eyes, mouth,
headwear, accessory. Each layer chooses only among values that break no rule with the layers already drawn. The
material odds therefore hold exactly, and only the later layers bend around the rules.

**No duplicates.** A DNA (all eight values) that already exists is redrawn. The Common space is wide enough
(about 17,000 combinations) that the redraws barely move the odds. The report measures this: the worst deviation
from the intended odds is about 3 standard deviations across every value of every tier, which is consistent with chance.

## 3. Two styles: vector vs pixel art

Both styles are implemented. They draw the same genome with the same palette. `NFT_ART_STYLE` (`vector` by
default, or `pixel`) picks the collection's style, and `/api/nft/<id>.svg?style=` previews the other one.

- **Vector** (`nft/vector.ts`): 512 × 512 SVG in the house style. Cel fills, one hard shade, a 3 px ink line,
  and the same coin geometry as the game.
- **Pixel** (`nft/pixel.ts`): drawn natively on a 64 × 64 grid. It is not a downscaled vector: hats, horns and
  flames are pixel shapes, faces are hand-placed sprites, and an outline pass adds exactly 1 px of ink around
  every part. A 3 × 5 pixel font draws the tags. The output is an SVG of crisp 8 px cells.

`out/nft2/compare.png` shows the same 12 tokens side by side. Verdict: **vector is better for Coinnibal, and it is
the default.** The reasons:

1. **It is our character.** The game, the site, the stickers and the share cards are all vector storybook art.
   The vector emblem is recognisably the coin you play. The pixel emblem is a cousin from another game.
2. **Expressions survive.** At 64 px a face has about 6 × 7 pixels per eye. Smug, Dizzy and Determined collapse
   into nearly the same square eyes, and mouths become two or three pixels. In vector every mood reads. Faces
   are the heart of this character.
3. **Materials survive.** Reeded metal, stone veins, glass facets and foil bands look distinct in vector. In
   pixel art, Jade and Pearl look like flat paint with a blotch, and Obsidian and Void lose their faces against
   night backgrounds.
4. **Rare effects read better.** Vector flames, starbursts and lightning are unmistakable. The pixel flames read
   as a frame.

Where pixel art wins, honestly: it holds up at tiny thumbnail sizes (marketplace grids at 64 to 96 px), its tags
are legible there, and it has a strong "collectible" feel. If the owner wants a retro collection, it is a working
option today. Before shipping it, its faces would need a hand-drawn pass at 2 × 2 pixels per feature.

## 4. Fair mint: commit, seal, reveal

No contract change is needed. CoinnibalNFT computes `tokenURI(id) = baseURI + id`, and its base URI points at the
server (`/api/nft/`). The server decides what each token shows, so the commit-and-reveal scheme runs server-side.

1. **Commit (first boot).** The server generates a random 32-byte seed (or uses `NFT_COLLECTION_SEED`). It
   generates the art order from the seed and stores `nft-collection.json` (mode 0600) in the chain's state
   directory. That file holds the seed, `seedHash = sha256(seed)`, and
   `provenance = sha256(concat(sha256(dna_i)))` over the art order. After a commit, a different seed or size in
   the environment is ignored with a warning. A tampered file (a seed that no longer matches its hash) stops the
   server.
2. **Publish before the mint.** `GET /api/nft/provenance` returns the size, the seed hash, the provenance hash and
   the algorithm. Also call `setContractURI("<PUBLIC_URL>/api/nft/contract?provenance=<hash>")`. That puts the
   hash in an owner transaction with a timestamp, which nobody can backdate. `GET /api/nft/contract` repeats the
   hashes (`provenance_hash`, `seed_hash`).
3. **Sealed during the mint.** Every minted token shows the sealed emblem: a face-down coin with a question mark.
   Its metadata carries one attribute, `Status: Sealed`, so there is no tier and no trait to snipe. Responses are
   cached for 60 s only.
4. **Schedule (admin, after the mint).** `POST /api/admin/nft/reveal/schedule` fixes a reveal block 50 blocks
   ahead (or one the admin chooses, at least 10 ahead). The server refuses while the mint is open and not sold
   out, refuses when the contract's max supply is above the collection size, and never lets a scheduled block be
   moved. Moving it after seeing the block's hash would amount to choosing the offset.
5. **Reveal.** Once that block is mined, `POST /api/admin/nft/reveal` computes
   `offset = uint256(sha256(blockHash ‖ provenance)) mod size`. From then on, token `t` shows art
   `(t − 1 + offset) mod size`, and the seed is published at `/api/nft/provenance`. Then call `setBaseURI` with
   the same URI. It emits ERC-4906 `BatchMetadataUpdate`, and marketplaces re-fetch. After the reveal the image URL
   carries `?v=<block>` so caches cannot serve the sealed picture.
6. **Verify (anyone).** Check that `sha256(seed)` equals the committed hash. Run
   `pnpm -F @coinnibal/server nft:report --seed <seed>`, or `generateCollection(seed, size)`, and compare the
   provenance hash. Recompute the offset from the block's hash.

**Why nobody can snipe a rare:**

- **Minters:** the art is invisible until after the mint.
- **The team:** they know the seed, and with it the art order, but not the offset. The offset depends on the
  hash of a block mined after the mint closed. Once scheduled, the block cannot be moved.
- **Reopening:** never reopen the mint after the reveal. The art of the next ids would be known. The admin view
  shows the mint state next to the reveal state.

**Limits, stated plainly:**

- Robinhood Chain is an Arbitrum Orbit L2 with a single sequencer. The sequencer could in principle grind block
  hashes. That is far-fetched for this collection, but Chainlink VRF would close the gap if it ever matters.
- The server, not the chain, holds the mapping. The contract cannot enforce it. What the public can do is verify
  every token against the published commitment.
- `freezeMetadata` must not be called before the reveal. The reveal needs a `setBaseURI` to announce itself.

**Existing testnet tokens** also show the sealed emblem until a reveal on the testnet's own state.

## 5. Metadata

A revealed token:

```json
{
  "name": "Coinnibal No. 42",
  "description": "A Rare Coinnibal NFT: a metal coin. Holders play Coinnibal, the arena where the coins eat, on Robinhood Chain.",
  "image": "https://<site>/api/nft/42.svg?v=<revealBlock>",
  "external_url": "https://<site>",
  "background_color": "34B7DD",
  "attributes": [
    { "trait_type": "Tier", "value": "Rare" },
    { "trait_type": "Background", "value": "Deep Sea" },
    { "trait_type": "Material", "value": "Gold" },
    { "trait_type": "Eyes", "value": "Star" },
    { "trait_type": "Mouth", "value": "Fang" },
    { "trait_type": "Headwear", "value": "Cowboy" },
    { "trait_type": "Accessory", "value": "None" },
    { "trait_type": "Effect", "value": "Sparkles" },
    { "display_type": "number", "trait_type": "Rarity Rank", "value": 812, "max_value": 3333 }
  ]
}
```

The fields:

- `None` stays an explicit value, so holders can filter on "no hat".
- 1/1s add `{ "trait_type": "One of One", "value": "The Sun Eater" }`, and their name goes into `name`.
- `Rarity Rank` is the information-content rank (OpenRarity's idea) over the whole collection; 1 is the rarest.

### Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /api/nft/provenance` | the commitment, and after the reveal the seed, block hash and offset |
| `GET /api/nft/rarity` | aggregate counts per tier and per trait value (the public rarity table; it reveals nothing about which token gets what) |
| `GET /api/admin/nft` | admin: provenance, stats, style, current block, mint state. The **Emblems** card in `/admin` → Mint shows this |
| `POST /api/admin/nft/reveal/schedule {block?}` | admin: fixes the reveal block |
| `POST /api/admin/nft/reveal` | admin: reveals once the scheduled block is mined |

## Files

- `apps/server/src/site/nft/traits.ts`: tiers, layers, odds, exclusion rules, the 1/1s, DNA.
- `apps/server/src/site/nft/generate.ts`: the seeded PRNG streams, quotas, `generateCollection`, provenance,
  reveal offset, rarity stats.
- `apps/server/src/site/nft/palette.ts`: the emblem palette, material specs, tier frames.
- `apps/server/src/site/nft/vector.ts`: the vector style.
- `apps/server/src/site/nft/pixel.ts`: the pixel style.
- `apps/server/src/site/nft/unrevealed.ts`: the sealed emblem, in both styles.
- `apps/server/src/site/nft/render.ts`: the style switch.
- `apps/server/src/site/nft/collection.ts`: commit, persistence, metadata, schedule and reveal.
- `apps/server/scripts/nft/report.ts`: the distribution report (`nft:report`).
- `apps/server/scripts/nft/sheets.ts`: the contact sheets (`nft:sheets`).
- `apps/web/src/admin/EmblemsCard.tsx`: the admin card.
- Tests: `apps/server/test/nft-collection.test.ts` and `apps/server/test/site-mint.test.ts` (the reveal through
  the API).
