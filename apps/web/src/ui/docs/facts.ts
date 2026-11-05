import {
  CAPACITY,
  DEFAULT_ARENAS,
  DEFAULT_FEE_RATES,
  DEFAULT_PAYMENT_BURN_BPS,
  MAX_TOTAL_FEE_BPS,
  RULES,
  SHOP_DEFAULTS,
  arenaMeta,
  feeExample,
  type FeeRates,
  type ProfitFee,
} from '@elymum/shared';
import { REFUND_DELAY_SECS } from '@elymum/sdk';

/**
 * Every number the player guide quotes, taken from the code that enforces it, so the
 * page cannot drift from the game. Contract defaults come from `@elymum/sdk` (mirrors of
 * `packages/contracts/contracts/ElymumArena.sol`, checked against the ABI by an SDK test), gameplay from
 * `@elymum/shared` `RULES` / `CAPACITY` (server defaults; operators may change them with
 * env vars). The few server-only timings are mirrored in `SERVER` below and checked
 * against the server source by `test/docs.test.ts`.
 */

/** Server timings that live only in apps/server (checked by test/docs.test.ts). */
export const SERVER = {
  /** `PRO_LEVEL` (rooms/manager.ts): practice players at this level or more play in the pro league. */
  proLevel: 5,
  /** `PROMOTE_MAX_MASS` / `PROMOTE_KILLS` (rooms/manager.ts): a rookie game above either promotes to pro… */
  promoteMaxMass: 3000,
  promoteKills: 8,
  /** …for `PROMOTION_MS` (24 h). */
  promotionHours: 24,
  /** `MAX_STAKE_SESSION_AGE_S` (rooms/room.ts): a safety cap; rounds end every 5 minutes, so tickets close far sooner. */
  maxTicketHours: 6,
  /** `STALE_SESSION_AFTER_S` (chain/evm.ts): a ticket nobody plays gets its full entry fee back after 15 min. */
  staleTicketMinutes: 15,
  /** `PRIVATE_ROOM_CAPACITY` default (shared CAPACITY.private) and the 5-character room code (rooms/manager.ts). */
  privateCodeLength: 5,
} as const;

/** The worked example of the guide: a 1,000-token ticket with 1,900 tokens in the till at the bell. */
export const EXAMPLE = { entry: 1000, cashout: 1900 } as const;

/**
 * The worked payout at `rates` (the arena's live fee rates on profit, else the contract defaults), exactly as the
 * arena contract splits it (`fees.ts`): the coin starts at the whole entry fee, the till at the bell is 1,900, the
 * profit is 900 and the fee is taken from it (15 % burned = 135, 5 % to the fee wallet = 45); the player gets 1,720.
 */
export function payoutExample(rates: FeeRates = DEFAULT_FEE_RATES): ProfitFee<number> & { entry: number } {
  return feeExample(EXAMPLE.entry, EXAMPLE.cashout, rates);
}

export interface DocsFacts {
  /** The contract's default fee rates on profit (bps), their on-chain cap, and the burned share of a shop payment. */
  fee: { burnBps: number; vaultBps: number; maxBps: number; paymentBurnBps: number };
  shop: { packSize: number; prices: Record<'magnet' | 'leap' | 'speed' | 'invis', number>; holderDiscountPct: number; arenaUses: number; holderExtraUses: number };
  example: { entry: number; cashout: number };
  arenas: { id: number; name: string; entry: number; maxSessions: number }[];
  capacity: { practice: number; private: number; arena: number };
  rules: {
    roundMin: number;
    joinCloseS: number;
    afkS: number;
    spawnShieldS: number;
    eatRatio: number;
    lootMin: number;
    lootMax: number;
    lootEntryDiv: number;
  };
  refundHours: number;
  server: typeof SERVER;
}

export const FACTS: DocsFacts = {
  fee: { burnBps: DEFAULT_FEE_RATES.burnBps, vaultBps: DEFAULT_FEE_RATES.vaultBps, maxBps: MAX_TOTAL_FEE_BPS, paymentBurnBps: DEFAULT_PAYMENT_BURN_BPS },
  shop: {
    packSize: SHOP_DEFAULTS.packSize,
    prices: {
      magnet: Number(SHOP_DEFAULTS.prices.magnet),
      leap: Number(SHOP_DEFAULTS.prices.leap),
      speed: Number(SHOP_DEFAULTS.prices.speed),
      invis: Number(SHOP_DEFAULTS.prices.invis),
    },
    holderDiscountPct: SHOP_DEFAULTS.holderDiscountPct,
    arenaUses: SHOP_DEFAULTS.arenaUsesPerRound,
    holderExtraUses: SHOP_DEFAULTS.holderExtraArenaUses,
  },
  example: EXAMPLE,
  arenas: DEFAULT_ARENAS.map((a) => ({ id: a.id, name: arenaMeta(a.id).name, entry: a.entryTokens, maxSessions: a.maxSessions })),
  capacity: { practice: CAPACITY.practice, private: CAPACITY.private, arena: CAPACITY.arena },
  rules: {
    roundMin: RULES.roundMs / 60_000,
    joinCloseS: RULES.roundJoinCloseMs / 1000,
    afkS: RULES.afkGraceMs / 1000,
    spawnShieldS: RULES.spawnShieldMs / 1000,
    eatRatio: RULES.eatRatio,
    lootMin: RULES.lootPiecesMin,
    lootMax: RULES.lootPiecesMax,
    lootEntryDiv: Math.round(1 / RULES.lootPieceEntryFraction),
  },
  refundHours: REFUND_DELAY_SECS / 3600,
  server: SERVER,
};

/* ------------------------------------------------------------------ */
/* Content model                                                       */
/* ------------------------------------------------------------------ */

export type DocBlock =
  | { kind: 'p'; text: string }
  /** Bulleted list; an item may lead with a bold term. */
  | { kind: 'list'; items: (string | { term: string; text: string })[] }
  /** Key → action rows (controls). */
  | { kind: 'keys'; rows: { key: string; action: string }[]; caption: string }
  /** Newspaper table. */
  | { kind: 'table'; caption: string; head: string[]; rows: string[][]; numeric?: number[] }
  /** Boxes joined by arrows: how value moves. */
  | { kind: 'flow'; label: string; steps: { title: string; text: string }[]; diagram?: { ticket: string; vault: string; wallet: string; fee: string } }
  /** The worked payout example as a receipt (at the server's fee rate). */
  | { kind: 'fee-example' }
  /** Two columns compared side by side. */
  | { kind: 'compare'; left: { title: string; items: string[] }; right: { title: string; items: string[] } }
  /** A boxed notice; `stamp` is printed on it. */
  | { kind: 'note'; tone: 'warn' | 'info'; stamp: string; title: string; text: string }
  /** Questions and answers (disclosure widgets). */
  | { kind: 'faq'; items: { q: string; a: string }[] };

export interface DocSection {
  /** Anchor id (prefixed `docs-` on the page). */
  id: string;
  title: string;
  /** One-line summary under the title. */
  lede: string;
  /** The three-panel comic that opens the section (captions; the drawings live in Comics.tsx). */
  strip?: DocStrip;
  blocks: DocBlock[];
}

/** A section's comic strip: a label and one caption per panel. */
export interface DocStrip {
  label: string;
  panels: [string, string, string];
}

export interface DocsContent {
  kicker: string;
  title: string;
  deck: string;
  /** Short facts for the dateline strip under the head. */
  dateline: string[];
  tocLabel: string;
  /** The worked payout receipt (its numbers come from `payoutExample(rates)`). */
  receipt: {
    title: string;
    meta: string;
    entry: string;
    cashout: string;
    winnings: string;
    burn: (pct: string) => string;
    vault: (pct: string) => string;
    net: string;
    footer: string;
    caption: string;
  };
  /** The fee rates on profit the guide quotes: the server's (`ChainStatus.fees`), else the contract defaults. */
  rates: FeeRates;
  colophon: string;
  backToTop: string;
  sections: DocSection[];
  /** Formats a percentage given in basis points (`500` → `%5` / `5%`). */
  pct: (bps: number) => string;
  /** Formats a whole number with the language's grouping (`1.000` / `1,000`). */
  num: (n: number) => string;
}
