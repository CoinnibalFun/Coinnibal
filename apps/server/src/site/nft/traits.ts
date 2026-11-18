/**
 * The Elymum emblem trait catalogue (docs/NFT-DESIGN.md): tiers, the layers and their odds per tier, the
 * exclusion rules and the ten hand-authored 1/1s. Pure data plus two small helpers; the generator
 * (`./generate`) draws from it and the renderers (`./vector`, `./pixel`) draw the values.
 *
 * Two kinds of layers:
 *  - **signature layers** (Background, Material, Effect) come from the token's own tier pool only, so the
 *    tier reads at a glance (a silver or gold coin is always Rare, an obsidian one always Legendary);
 *  - **character layers** (Eyes, Mouth, Headwear, Accessory) mix values of the token's tier and below, with
 *    the higher-tier values weighted up (a Legendary may smile like a Common; it never wears a cap).
 */

export const TIERS = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'] as const;
export type Tier = (typeof TIERS)[number];
/** Tiers that are rolled (Mythics are the authored 1/1s). */
type RolledTier = Exclude<Tier, 'Mythic'>;

/**
 * Target share of each tier. The generator hands out exact quotas (largest remainder), so the 3,333 collection
 * (`NFT_SUPPLY`) has exactly 2,000 / 833 / 366 / 127 / 7. Mythic = the 1/1s: never more than `MYTHICS.length`.
 */
export const TIER_SHARE: Record<Tier, number> = { Common: 0.6, Rare: 0.25, Epic: 0.11, Legendary: 0.038, Mythic: 0.002 };

/** Odds columns: [Common, Rare, Epic, Legendary] weights (0 = never at that tier). */
type Odds = readonly [number, number, number, number];
const T = (c: number, r: number, e: number, l: number): Odds => [c, r, e, l];

export const BACKGROUNDS = {
  'Dawn Plain': T(30, 0, 0, 0),
  Shallows: T(25, 0, 0, 0),
  Seigaiha: T(20, 0, 0, 0),
  'Night Ring': T(25, 0, 0, 0),
  'Sunset Ring': T(0, 35, 0, 0),
  'Deep Sea': T(0, 35, 0, 0),
  'Moon Night': T(0, 30, 0, 0),
  Aurora: T(0, 0, 50, 0),
  Treasury: T(0, 0, 50, 0),
  Cosmos: T(0, 0, 0, 50),
  'Golden Rays': T(0, 0, 0, 50),
} as const satisfies Record<string, Odds>;

export const MATERIALS = {
  Cyan: T(18, 0, 0, 0),
  Teal: T(18, 0, 0, 0),
  Foam: T(16, 0, 0, 0),
  Mint: T(16, 0, 0, 0),
  Cream: T(14, 0, 0, 0),
  Copper: T(18, 0, 0, 0),
  Silver: T(0, 50, 0, 0),
  Gold: T(0, 50, 0, 0),
  'Rose Gold': T(0, 0, 35, 0),
  Jade: T(0, 0, 35, 0),
  Pearl: T(0, 0, 30, 0),
  Obsidian: T(0, 0, 0, 34),
  Crystal: T(0, 0, 0, 33),
  Holographic: T(0, 0, 0, 33),
} as const satisfies Record<string, Odds>;

export const EYES = {
  Round: T(17, 16, 10, 6),
  Happy: T(16, 12, 8, 4),
  Sleepy: T(12, 8, 5, 3),
  Wink: T(12, 10, 8, 5),
  Smug: T(14, 12, 10, 8),
  Determined: T(16, 12, 10, 8),
  Dizzy: T(0, 10, 6, 3),
  Star: T(0, 16, 12, 10),
  Shades: T(0, 14, 10, 8),
  Heart: T(0, 0, 26, 14),
  Glow: T(0, 0, 0, 36),
} as const satisfies Record<string, Odds>;

export const MOUTHS = {
  Smile: T(18, 18, 12, 8),
  Grin: T(20, 15, 12, 10),
  Cat: T(16, 12, 10, 6),
  Ooh: T(14, 10, 6, 4),
  Smirk: T(20, 15, 12, 10),
  Tongue: T(0, 14, 12, 8),
  Fang: T(0, 16, 14, 12),
  Chomp: T(0, 0, 22, 18),
  'Gold Tooth': T(0, 0, 0, 24),
} as const satisfies Record<string, Odds>;

export const HEADWEAR = {
  None: T(16, 12, 5, 0),
  Cap: T(14, 8, 4, 0),
  Beanie: T(14, 8, 4, 0),
  Flower: T(12, 7, 3, 0),
  'Party Hat': T(10, 7, 3, 0),
  Sprout: T(10, 6, 3, 0),
  Propeller: T(0, 14, 7, 0),
  Cowboy: T(0, 14, 7, 0),
  Headphones: T(0, 14, 8, 0),
  Viking: T(0, 0, 15, 10),
  Wizard: T(0, 0, 14, 10),
  'Top Hat': T(0, 0, 12, 10),
  Laurel: T(0, 0, 11, 10),
  Crown: T(0, 0, 0, 30),
  Halo: T(0, 0, 0, 30),
} as const satisfies Record<string, Odds>;

export const ACCESSORIES = {
  None: T(20, 22, 15, 10),
  Scarf: T(15, 12, 8, 4),
  Bandana: T(12, 10, 6, 3),
  'Bow Tie': T(12, 10, 8, 5),
  Medal: T(0, 14, 10, 8),
  Monocle: T(0, 0, 14, 10),
  'Gold Chain': T(0, 0, 15, 14),
} as const satisfies Record<string, Odds>;

export const EFFECTS = {
  None: T(100, 45, 0, 0),
  Sparkles: T(0, 30, 0, 0),
  Bubbles: T(0, 25, 0, 0),
  'Orbit Coins': T(0, 0, 40, 0),
  Hearts: T(0, 0, 30, 0),
  Notes: T(0, 0, 30, 0),
  Flames: T(0, 0, 0, 34),
  Lightning: T(0, 0, 0, 33),
  Starburst: T(0, 0, 0, 33),
} as const satisfies Record<string, Odds>;

/** Values only the 1/1s carry. */
export const MYTHIC_BACKGROUNDS = ['Eclipse', 'Abyss', 'Prism', 'Origin'] as const;
export const MYTHIC_MATERIALS = ['Molten Sun', 'Void', 'Moonstone', 'Prismatic', 'Ancient Gold'] as const;
export const MYTHIC_EFFECTS = ['Corona', 'Embers', 'Starfall', 'Prism Halo'] as const;

export type Background = keyof typeof BACKGROUNDS | (typeof MYTHIC_BACKGROUNDS)[number];
export type Material = keyof typeof MATERIALS | (typeof MYTHIC_MATERIALS)[number];
export type Eyes = keyof typeof EYES;
export type Mouth = keyof typeof MOUTHS;
export type Headwear = keyof typeof HEADWEAR;
export type Accessory = keyof typeof ACCESSORIES;
export type Effect = keyof typeof EFFECTS | (typeof MYTHIC_EFFECTS)[number];

/** Everything that decides a picture. Two tokens never share one (the DNA is unique). */
export interface Genome {
  tier: Tier;
  background: Background;
  material: Material;
  eyes: Eyes;
  mouth: Mouth;
  headwear: Headwear;
  accessory: Accessory;
  effect: Effect;
  /** The 1/1's name (Mythic only). */
  name?: string;
}

/** The ten 1/1s: authored, not rolled. */
export const MYTHICS: readonly Genome[] = [
  { tier: 'Mythic', name: 'The Sun Eater', background: 'Eclipse', material: 'Molten Sun', eyes: 'Glow', mouth: 'Chomp', headwear: 'Crown', accessory: 'None', effect: 'Corona' },
  { tier: 'Mythic', name: 'The Abyss', background: 'Abyss', material: 'Void', eyes: 'Glow', mouth: 'Smirk', headwear: 'Halo', accessory: 'None', effect: 'Starfall' },
  { tier: 'Mythic', name: 'The Moon Coin', background: 'Eclipse', material: 'Moonstone', eyes: 'Sleepy', mouth: 'Ooh', headwear: 'Wizard', accessory: 'None', effect: 'Starfall' },
  { tier: 'Mythic', name: 'The Prism', background: 'Prism', material: 'Prismatic', eyes: 'Star', mouth: 'Grin', headwear: 'Halo', accessory: 'Gold Chain', effect: 'Prism Halo' },
  { tier: 'Mythic', name: 'The First Coin', background: 'Origin', material: 'Ancient Gold', eyes: 'Determined', mouth: 'Smile', headwear: 'Laurel', accessory: 'None', effect: 'Corona' },
  { tier: 'Mythic', name: 'The Ember King', background: 'Abyss', material: 'Molten Sun', eyes: 'Determined', mouth: 'Fang', headwear: 'Crown', accessory: 'Gold Chain', effect: 'Embers' },
  { tier: 'Mythic', name: 'The Night Swimmer', background: 'Abyss', material: 'Moonstone', eyes: 'Round', mouth: 'Cat', headwear: 'Viking', accessory: 'Scarf', effect: 'Prism Halo' },
  { tier: 'Mythic', name: 'The Last Bite', background: 'Origin', material: 'Void', eyes: 'Heart', mouth: 'Chomp', headwear: 'Top Hat', accessory: 'Gold Chain', effect: 'Embers' },
  { tier: 'Mythic', name: 'The Dreamer', background: 'Prism', material: 'Prismatic', eyes: 'Happy', mouth: 'Tongue', headwear: 'Propeller', accessory: 'Bow Tie', effect: 'Starfall' },
  { tier: 'Mythic', name: 'The Old Gold', background: 'Eclipse', material: 'Ancient Gold', eyes: 'Smug', mouth: 'Gold Tooth', headwear: 'Top Hat', accessory: 'Monocle', effect: 'Corona' },
];

/** The layers in drawing / metadata order, with their odds tables (Tier is first in the metadata). */
export const LAYERS = [
  ['Background', 'background', BACKGROUNDS],
  ['Material', 'material', MATERIALS],
  ['Eyes', 'eyes', EYES],
  ['Mouth', 'mouth', MOUTHS],
  ['Headwear', 'headwear', HEADWEAR],
  ['Accessory', 'accessory', ACCESSORIES],
  ['Effect', 'effect', EFFECTS],
] as const;
export type LayerKey = (typeof LAYERS)[number][1];

/** Index of a rolled tier in the odds columns. */
const tierIndex = (t: RolledTier): number => TIERS.indexOf(t);

/** The tier a value first appears at (its lowest non-zero column). */
export function valueTier(odds: Odds): RolledTier {
  return TIERS[odds.findIndex((w) => w > 0)] as RolledTier;
}

/**
 * The weighted choices of `layer` for a token of `tier` (non-zero weights only). Signature layers have one
 * tier per value; character layers list explicit weights for every tier a value may appear at (higher-tier
 * values weigh more on higher tiers, and the cheapest hats are gone from Legendaries altogether).
 */
export function choicesFor(layer: LayerKey, tier: RolledTier): [string, number][] {
  const table = LAYERS.find((l) => l[1] === layer)![2] as Record<string, Odds>;
  const ti = tierIndex(tier);
  return Object.entries(table)
    .filter(([, odds]) => odds[ti] > 0)
    .map(([value, odds]) => [value, odds[ti]]);
}

/**
 * Exclusion rules: pairs of values that never meet on one token, each with the reason. A rolled token that
 * breaks one is rerolled (the 1/1s are authored to respect them too).
 */
export const EXCLUSIONS: readonly { a: [LayerKey, string]; b: [LayerKey, string]; why: string }[] = [
  // contrast: the coin must stand off its background
  { a: ['material', 'Foam'], b: ['background', 'Shallows'], why: 'foam coin on foam water' },
  { a: ['material', 'Cream'], b: ['background', 'Seigaiha'], why: 'cream coin on cream paper' },
  { a: ['material', 'Teal'], b: ['background', 'Night Ring'], why: 'dark coin on the night' },
  { a: ['material', 'Mint'], b: ['background', 'Dawn Plain'], why: 'green coin on the green terraces' },
  { a: ['material', 'Gold'], b: ['background', 'Sunset Ring'], why: 'gold on a gold sky' },
  { a: ['material', 'Jade'], b: ['background', 'Aurora'], why: 'green coin on green lights' },
  { a: ['material', 'Rose Gold'], b: ['background', 'Treasury'], why: 'warm coin on a warm hoard' },
  // the same colour twice on one coin
  { a: ['material', 'Gold'], b: ['accessory', 'Gold Chain'], why: 'a gold chain vanishes on a gold coin' },
  { a: ['material', 'Gold'], b: ['accessory', 'Medal'], why: 'a gold medal vanishes on a gold coin' },
  { a: ['material', 'Ancient Gold'], b: ['accessory', 'Gold Chain'], why: 'a gold chain vanishes on a gold coin' },
  // things that cannot be worn together, or say two opposite things
  { a: ['accessory', 'Monocle'], b: ['eyes', 'Shades'], why: 'a monocle over sunglasses' },
  { a: ['accessory', 'Monocle'], b: ['eyes', 'Wink'], why: 'the monocle sits on the winking eye' },
  { a: ['accessory', 'Monocle'], b: ['eyes', 'Happy'], why: 'a monocle needs an open eye' },
  { a: ['accessory', 'Monocle'], b: ['eyes', 'Sleepy'], why: 'a monocle needs an open eye' },
  { a: ['accessory', 'Monocle'], b: ['eyes', 'Heart'], why: 'too much going on in one eye' },
  { a: ['accessory', 'Monocle'], b: ['eyes', 'Dizzy'], why: 'too much going on in one eye' },
  { a: ['headwear', 'Halo'], b: ['mouth', 'Fang'], why: 'an angel with fangs' },
  { a: ['headwear', 'Headphones'], b: ['effect', 'Notes'], why: 'a cliche, and it crowds the head' },
  { a: ['effect', 'Starburst'], b: ['background', 'Golden Rays'], why: 'rays on rays' },
  { a: ['effect', 'Bubbles'], b: ['background', 'Sunset Ring'], why: 'bubbles in the sky' },
  { a: ['eyes', 'Sleepy'], b: ['effect', 'Lightning'], why: 'nobody sleeps through that' },
  { a: ['eyes', 'Shades'], b: ['background', 'Moon Night'], why: 'sunglasses at night' },
];

/** The first exclusion rule `g` breaks, or null. */
export function brokenRule(g: Genome): (typeof EXCLUSIONS)[number] | null {
  for (const r of EXCLUSIONS) if (g[r.a[0]] === r.a[1] && g[r.b[0]] === r.b[1]) return r;
  return null;
}

/** The DNA: every layer, one string (identical DNA = identical picture). */
export function dna(g: Genome): string {
  return [g.tier, g.background, g.material, g.eyes, g.mouth, g.headwear, g.accessory, g.effect].join('|');
}
