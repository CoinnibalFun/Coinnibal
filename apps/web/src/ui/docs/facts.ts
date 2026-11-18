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
import { APPROVE_DEFAULT_TICKETS, APPROVE_TICKET_CHOICES } from '../../wallet/ticket';

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
  /** The length of a private room's invite code (rooms/manager.ts). */
  privateCodeLength: 8,
} as const;

/** The worked example of the guide: a ticket of 1,000 tokens worth 1,900 tokens at the bell. */
export const EXAMPLE = { entry: 1000, cashout: 1900 } as const;

/**
 * The worked payout at `rates` (the arena's live fee rates on profit, else the contract defaults), exactly as the
 * arena contract splits it (`fees.ts`): the coin starts at the whole ticket price, its value at the bell is 1,900, the
 * profit is 900 and the fee is taken from it (15 % burned = 135, 5 % to the team wallet = 45); the player gets 1,720.
 */
export function payoutExample(rates: FeeRates = DEFAULT_FEE_RATES): ProfitFee<number> & { entry: number } {
  return feeExample(EXAMPLE.entry, EXAMPLE.cashout, rates);
}

export interface DocsFacts {
  /** The contract's default fee rates on profit (bps), their on-chain cap, and the burned share of a shop payment. */
  fee: { burnBps: number; vaultBps: number; maxBps: number; paymentBurnBps: number };
  /** `prices`: whole tokens (used until a token price is set); `usdCents`: the default price of a pack in US cents. */
  shop: {
    packSize: number;
    prices: Record<'magnet' | 'leap' | 'speed' | 'invis', number>;
    usdCents: Record<'magnet' | 'leap' | 'speed' | 'invis', number>;
    holderDiscountPct: number;
    arenaUses: number;
    holderExtraUses: number;
  };
  example: { entry: number; cashout: number };
  /** `entry`: whole tokens at the reference price; `usdCents`: the ticket's price in US cents. */
  arenas: { id: number; name: string; entry: number; usdCents: number; holdersOnly: boolean; maxSessions: number }[];
  capacity: { practice: number; private: number; arena: number };
  rules: {
    roundMin: number;
    joinCloseS: number;
    breakS: number;
    afkS: number;
    spawnShieldS: number;
    eatRatio: number;
    lootMin: number;
    lootMax: number;
    lootEntryDiv: number;
  };
  refundHours: number;
  /** How many tickets of a room one token approval may cover, and the preselected choice (wallet/ticket.ts). */
  approve: { choices: readonly number[]; preselected: number };
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
    usdCents: { ...SHOP_DEFAULTS.usdCents },
    holderDiscountPct: SHOP_DEFAULTS.holderDiscountPct,
    arenaUses: SHOP_DEFAULTS.arenaUsesPerRound,
    holderExtraUses: SHOP_DEFAULTS.holderExtraArenaUses,
  },
  example: EXAMPLE,
  arenas: DEFAULT_ARENAS.map((a) => ({ id: a.id, name: arenaMeta(a.id).name, entry: a.entryTokens, usdCents: a.usdCents, holdersOnly: a.holdersOnly, maxSessions: a.maxSessions })),
  capacity: { practice: CAPACITY.practice, private: CAPACITY.private, arena: CAPACITY.arena },
  rules: {
    roundMin: RULES.roundMs / 60_000,
    joinCloseS: RULES.roundJoinCloseMs / 1000,
    breakS: RULES.roundBreakMs / 1000,
    afkS: RULES.afkGraceMs / 1000,
    spawnShieldS: RULES.spawnShieldMs / 1000,
    eatRatio: RULES.eatRatio,
    lootMin: RULES.lootPiecesMin,
    lootMax: RULES.lootPiecesMax,
    lootEntryDiv: Math.round(1 / RULES.lootPieceEntryFraction),
  },
  refundHours: REFUND_DELAY_SECS / 3600,
  approve: { choices: APPROVE_TICKET_CHOICES, preselected: APPROVE_DEFAULT_TICKETS },
  server: SERVER,
};

/* ------------------------------------------------------------------ */
/* Content model                                                       */
/* ------------------------------------------------------------------ */

/**
 * A block of a guide section. Text may link to another section with `[label](#id)` (content.en.ts `see`): in the
 * section ledes, paragraphs, list items, steps, table cells and the controls' actions.
 */
export type DocBlock =
  | { kind: 'p'; text: string }
  /** A small heading inside a long section (private rooms, linking X). */
  | { kind: 'h'; text: string }
  /** Bulleted list; an item may lead with a bold term. */
  | { kind: 'list'; items: (string | { term: string; text: string })[] }
  /** Numbered steps to follow in order. */
  | { kind: 'steps'; label: string; items: string[] }
  /** Key → action rows (controls). */
  | { kind: 'keys'; rows: { key: string; action: string }[]; caption: string }
  /**
   * Open table (no box). `numeric`: columns of figures (mono, right on wide screens); `keys`: a column of keys drawn
   * as key caps; `stack`: on phones each row becomes a small block that names its columns; `quiet`: the caption is
   * read by screen readers only (where the chapter's title already says it).
   */
  | { kind: 'table'; caption: string; head: string[]; rows: string[][]; numeric?: number[]; keys?: number; stack?: boolean; quiet?: boolean }
  /** The moving diagram of how value moves: ticket, vault, wallet, fee. */
  | { kind: 'flow'; label: string; diagram: { ticket: string; vault: string; wallet: string; fee: string } }
  /** The worked payout example as a receipt (at the server's fee rate). */
  | { kind: 'fee-example' }
  /** Two columns compared side by side (open, no boxes). */
  | { kind: 'compare'; left: { title: string; items: string[] }; right: { title: string; items: string[] } }
  /** A boxed notice (the risk before buying a ticket). */
  | { kind: 'note'; tone: 'warn' | 'info'; title: string; text: string }
  /** Questions and answers (disclosure widgets). */
  | { kind: 'faq'; items: { q: string; a: string }[] };

export interface DocSection {
  /** Anchor id (prefixed `docs-` on the page). */
  id: string;
  title: string;
  /** A line under the title, only where it adds something the title does not say. */
  lede?: string;
  /** The three-panel comic that opens the section (captions; the drawings live in Comics.tsx). Only where a picture
   * says it better than words: the basic rule and wallet safety. */
  strip?: DocStrip;
  blocks: DocBlock[];
}

/** A section's comic strip: a label (read by screen readers) and one caption per panel. */
export interface DocStrip {
  label: string;
  panels: [string, string, string];
}

export interface DocsContent {
  title: string;
  deck: string;
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
  backToTop: string;
  /** The guide's last word, beside "Back to top": the official links and the seed-phrase rule, and the X account. */
  closing: { lines: string[]; follow: string; href: string };
  sections: DocSection[];
  /** Formats a percentage given in basis points (`500` → `%5` / `5%`). */
  pct: (bps: number) => string;
  /** Formats a whole number with the language's grouping (`1.000` / `1,000`). */
  num: (n: number) => string;
}
