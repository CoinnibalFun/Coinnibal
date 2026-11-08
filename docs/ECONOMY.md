# Elymum economy

How value moves, what leaves circulation, and what each price is set against. Every number here is a code
default; the module that holds it is named so this page and the game cannot drift apart:

| What | Where |
|---|---|
| Fee on profit, payment split, cap | `packages/shared/src/fees.ts` (mirrors `ElymumArena` v3, `packages/contracts/contracts/ElymumArena.sol`) |
| Arena tiers in US dollars, entry fees at the reference price | `DEFAULT_ARENAS`, `packages/shared/src/arenas.ts` |
| USD → token conversion, rounding, the admin sync's diff | `packages/shared/src/arena-pricing.ts` (`usdToTokenRaw`, `arenaPriceDiff`) |
| Token price source (manual; a Pons / DEX TWAP stub, not wired) | `apps/server/src/chain/token-price.ts` |
| Power-up packs (in US cents, converted like the tickets) | `SHOP_DEFAULTS`, `packages/shared/src/boosts.ts`; `apps/server/src/shop/service.ts` |
| Custom rooms | `CUSTOM_SETTINGS_DEFAULT`, `packages/shared/src/custom-rooms.ts` |
| Loot | `RULES.loot*`, `packages/shared/src/constants.ts` |

The token is the game token on Robinhood Chain (launched on Pons: a fixed supply of 1,000,000,000 with no mint after
launch; on the testnet the bundled `TestToken`). **Nothing in Elymum mints the game token**: the arena only holds,
pays out and burns tokens players brought, so every sink below shrinks circulation for good. The server key cannot
mint either (the testnet `TestToken` is minted only by its owner and its public faucet: 1,000,000 an hour per
wallet, 2,000,000 for emblem holders).

## 1. Arena tickets: priced in US dollars, paid in the token

The four tiers are priced in **US dollars** (owner decision 2026-11; every number is an admin setting in `/admin` →
Game → Arena prices):

| Arena | Ticket | Who | Created at (reference price $0.001 a token) |
|---|---|---|---|
| #1 Asphodel Meadow | **$1** | everyone | 1,000 |
| #2 Lethe Shore | **$3** | everyone | 3,000 |
| #3 Golden Bough | **$5** | everyone | 5,000 |
| #4 Isles of the Blessed | **$10** | **emblem holders only** (on chain, `setArenaHoldersOnly`) | 10,000 |

- **The chain keeps entry fees in token units** (`ElymumArena.createArena` / `updateArena`). The admin turns the
  dollar prices into token amounts at the token's USD price and the **owner's wallet signs** the change
  (OPERATIONS.md, "Arena prices in US dollars"). The server never holds the owner key.
- **Price source.** `manual`: a USD price per token the admin types (the testnet default; the TestToken has no
  market). `dex_twap`: reserved for a future on-chain Pons / DEX time-weighted price; it is a marked stub that reads
  nothing and cannot be selected until it is wired (`apps/server/src/chain/token-price.ts`).
- **Rounding.** `entry = $ / price`, rounded half up to `sigFigs` significant figures (default 2: "1,200", not
  "1,234.57"), in exact integer arithmetic. At $0.00081 a token: $1 → 1,200 ($0.97), $3 → 3,700, $5 → 6,200,
  $10 → 12,000 ($9.72). Two figures keep a ticket within about 5 % of its dollar price; 3 figures within 0.5 %.
- **The lobby** shows the dollar price with the token amount next to it ("$1 · 1,200 $ELYMUM"). An arena whose
  entry is not the tier price at the current token price (not re-synced yet) shows its value instead ("≈ $0.81").
- **A price change never touches a ticket already bought.** Each ticket records its entry fee at `join`
  (`Session.entryFee`); settlement, the fee on profit, cancel, the 24 h refund, the server's payout guard and its
  books all use that recorded amount, never the arena's current entry fee. On top of that the contract refuses a new
  entry fee while any ticket of that arena is open (`ArenaBusy`): an arena is re-priced between rounds.

## 2. No entry fee, a fee on profit

- A ticket costs the arena's entry fee and **the whole of it goes into the arena vault**: the coin starts at the
  entry fee. There is no entry or ticket fee.
- Value moves between players in play (eating). At the bell every live coin is paid its value.
- **A winning ticket pays 20 % of its profit** (profit = payout − entry fee): **15 % is burned** and **5 % goes to
  the fee wallet** (the vault of the business). Each share rounds down. **A loss or a break-even pays nothing.**
- The rates are fixed into the ticket at join; the owner may change them for new tickets only, and the contract
  caps the pair at **25 %** of the profit (`MAX_TOTAL_FEE_BPS`).
- **Emblem holders pay half: 10 % of their profit** (800 bps burned + 200 bps to the fee wallet), against 20 %
  (1,500 + 500) for everyone else. It is the contract's holder pair (`setHolderPerks(nft, 800, 200)`), fixed into the
  ticket at join like the normal pair, and used only when it totals less than the normal pair. Both pairs are
  owner-set and capped at 25 % (`MAX_TOTAL_FEE_BPS`).

Worked examples at the defaults (`computeProfitFee`, the contract's `computeFees`):

| Entry | Payout at the bell | Profit | Burned (15 %) | Fee wallet (5 %) | Player gets |
|---|---|---|---|---|---|
| 1,000 | 2,000 | 1,000 | 150 | 50 | **1,800** |
| 1,000 | 1,900 | 900 | 135 | 45 | 1,720 |
| 1,000 | 1,000 | 0 | 0 | 0 | 1,000 |
| 1,000 | 400 | 0 (a loss) | 0 | 0 | 400 |
| 250,000 | 1,000,000 | 750,000 | 112,500 | 37,500 | 850,000 |
| 1,000 | 2,000 (holder, 8 % + 2 %) | 1,000 | 80 | 20 | **1,900** |
| 1,000 | 1,001 (holder, 8 % + 2 %) | 1 | 0 (rounds down) | 0 | 1,001 |

Why on profit: arenas are zero-sum between players, so a fee on every entry would drain the table whatever anyone
did; a fee on profit charges only the value a player actually took from others, never their stake. The burn share
(three quarters of the fee) ties the token's supply to play.

A ticket that is never played is cancelled by the server with its full entry fee back; a ticket the server never
settles can be refunded by its player after 24 h (the entry fee, capped by the vault).

## 3. Power-ups: half burned, half to the fee wallet

Packs of **3 charges**, paid in the game token through `ElymumArena.pay(amount, ref)`: the contract burns
**50 %** (`paymentBurnBps`, owner-settable 0 to 100 %) and sends the rest to the fee wallet in the same call. The
shop is a cart: the player picks several packs (+/−), and one `pay(total, ref)` pays them all (the `ref` names the
cart, `elymum.cart.…`; a single pack is `elymum.shop.<kind>`). The server credits the charges after checking the
`Paid` event (contract, payer, cart, amount).

**Priced in US dollars** like the tickets (`priceIn: 'usd'`, the default): the server converts each pack at the same
token price source and the same significant figures as the arena tiers (Game → Arena prices: the manual price; the
DEX source stays a stub), so a charge stays the same share of the $1 ticket whatever the token's price. The shop shows
both: "$0.60 · 740 $ELYMUM" (at $0.00081 a token).

| Pack | Price | Holders | Per charge | vs the $1 ticket | vs the $10 ticket | In tokens at $0.001 / at $0.00081 |
|---|---|---|---|---|---|---|
| Magnet | $0.60 | $0.48 | $0.20 | 20 % per use | 2 % | 600 / 740 |
| Speed burst | $0.60 | $0.48 | $0.20 | 20 % | 2 % | 600 / 740 |
| Leap | $0.90 | $0.72 | $0.30 | 30 % | 3 % | 900 / 1,100 |
| Invisibility | $1.20 | $0.96 | $0.40 | 40 % | 4 % | 1,200 / 1,500 |

Until a token price is set (or with `priceIn: 'token'`) the packs cost their token prices (`prices`: 600 / 900 / 600 /
1,200). **Emblem holders pay 20 % less** (`holderDiscountPct`, an admin setting), rounded like the full price. The
server quotes each wallet its price (`GET /api/shop`) and credits a `pay(amount, ref)` for the full price or, for a
wallet that holds the emblem (re-read on chain), the holder price, now or as shown in the last 15 minutes (a token
price that moved between the quote and the payment). One emblem token id gives the discount to one wallet a UTC day.
**Paid arenas allow 2 uses per round** (3 for holders), so a big-arena player cannot buy an edge by volume; practice
and private rooms use charges freely, with cooldowns.

Pricing logic: a pack costs between 60 % and 120 % of the cheapest ticket, so in the entry arena a power-up is a
real decision (one charge is a fifth of a ticket or more), while the per-round cap keeps the higher arenas from
becoming pay-to-win. The admin changes the dollar prices in `/admin` (Game → Power-ups, `usdCents`).

## 4. Floor loot: burned at the bell

Value a coin loses to something without a ticket spills on the floor as loot that any staker can pick up until the
bell; whatever is left is burned (`sweepLoot`, with a monotonic sweep id). With people only in the arenas this is a
safety path that rarely triggers.

## 5. Custom rooms: a small fee in ETH

A signed-in wallet opens a room with its own rules for **0.0005 ETH** (about $1.50 at ETH = $3,000) up to 10
players, +50 % per further 10 players (100 players: x5.5), paid as a plain ETH transfer to the treasury (an admin setting; unset, the
owner, the first `ADMIN_WALLETS` wallet) and checked on chain before the room opens. Free rooms and ticket rooms pay
the same fee. **Emblem holders open one room a day for free** (`holderPerk: free_daily`, the
default): one room of the base size (up to 10 players) per wallet per UTC day (it renews at 00:00 UTC), enforced by
the server and recorded in `DATA_DIR/site/custom-rooms.json` in the same write that stores the room, so a restart
never hands out a second one. The admin can switch the perk to a discount (`holderDiscountPct`, 50 % by default) or
off.

**Why ETH and not the game token**, decided on purpose and applied consistently (server, web, admin):

- It is a service fee for server capacity, not part of the game's money: it should not depend on the token's price,
  its liquidity or whether it has launched (custom rooms work on day one, also on the testnet).
- Every creator already holds ETH (it pays their gas); many do not hold the token (a free room is meant for friends
  who just want to play).
- The token's sinks come from play (profit burns, power-ups, loot), where they scale with activity; a room fee in the
  token would add little burn and a lot of friction.
- A **ticket room** (an invite-only instance of an arena) charges no extra token at all: its players buy the normal
  arena ticket, and the normal fee on profit and burn apply.

Practice bots exist only in **free** custom rooms (the creator turns them on: count and difficulty). They carry no
value, never pick up loot and never use power-ups.

## 6. The Elymum NFT (emblem)

Minted for **$1 in ETH** (the price keeper follows ETH/USD within owner-set bounds), allowlist first, then public;
proceeds go to the NFT treasury. What it does in the economy:

- **One emblem, one perk at a time.** Every holder perk is bound to a token id of the emblem (read from its
  `Transfer` logs): a token id serves one open holder ticket (a holders-only seat or the holder fee rates) until it is
  settled, and gives the power-up discount and the free room to one wallet a UTC day. An emblem passed around (or
  borrowed for a moment) cannot serve several wallets at once: the extra ticket is refused at its seat and refunded in
  full, and the admin sees a flag.
- **Access** while the game opens in phases (holders play first).
- **Half the fee on profit:** 10 % (8 % burned + 2 % to the fee wallet) instead of 20 % (the arena's holder pair).
- **The $10 arena is holders-only** (the Isles of the Blessed, on chain).
- **20 % off power-ups** and **one extra power-up use per arena round**.
- **One free custom room a day** (UTC; the admin may pick a discount instead).
- **2x from the testnet faucet**; cosmetic only: the **emblem coin skin** and the **holder badge** (the laurel next to
  the name in game and in the standings, the "Emblem holder" badge on the lobby's profile card).

Every one of these numbers is an admin setting: the holder pair on chain (`setHolderPerks`, owner-signed), the tiers,
the price and the rounding (Game → Arena prices), the power-up discount (Game → Power-ups), the custom-room perk
(Game → Custom rooms).

None of these create tokens; they lower what a holder pays into the sinks.

## 7. No inflation

| Flow | Direction |
|---|---|
| Entry fees | player → vault (held, paid back out to players) |
| Payouts | vault → players (net of the fee on profit) |
| Fee on profit | 15 % burned, 5 % fee wallet (holders: 8 % burned, 2 % fee wallet) |
| Power-ups | 50 % burned, 50 % fee wallet |
| Floor loot | burned |
| Custom rooms, NFT mint | ETH, not the token |
| Mint of the game token | none (fixed supply; the testnet token: its owner and its faucet only) |

The arena's books are checked on chain (`balance = Σ vaults + Σ owed`; per arena: deposited = vault + paid out +
burned + fees) and off chain (Σ live + Σ loot + Σ pending + Σ forfeited = Σ entry fees − Σ paid), by unit, fuzz and
invariant tests.

## Open questions

- Whether the Pons token exposes a working `burn()` (burn mode 1) is not documented: the arena burns to `0x…dEaD`
  until `/admin` shows it works (docs/RESEARCH.md).
- The Pons / DEX TWAP price source is a stub: which pool, which interface and which averaging window are not known
  until the token launches. Until it is wired the manual price is the only source, and the owner re-syncs by hand.
- The custom room fee follows ETH; re-price it in `/admin` if ETH moves a lot.
