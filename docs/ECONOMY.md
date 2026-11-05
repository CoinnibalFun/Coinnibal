# Elymum economy

How value moves, what leaves circulation, and what each price is set against. Every number here is a code
default; the module that holds it is named so this page and the game cannot drift apart:

| What | Where |
|---|---|
| Fee on profit, payment split, cap | `packages/shared/src/fees.ts` (mirrors `ElymumArena` v3, `packages/contracts/contracts/ElymumArena.sol`) |
| Arena entry fees | `DEFAULT_ARENAS`, `packages/shared/src/arenas.ts` |
| Power-up packs | `SHOP_DEFAULTS`, `packages/shared/src/boosts.ts` |
| Custom rooms | `CUSTOM_SETTINGS_DEFAULT`, `packages/shared/src/custom-rooms.ts` |
| Loot | `RULES.loot*`, `packages/shared/src/constants.ts` |

The token is the game token on Robinhood Chain (launched on Pons: a fixed supply of 1,000,000,000 with no mint after
launch; on the testnet the bundled `TestToken`). **Nothing in Elymum mints the game token**: the arena only holds,
pays out and burns tokens players brought, so every sink below shrinks circulation for good. The server key cannot
mint either (the testnet `TestToken` is minted by its owner only).

## 1. Arena tickets: no entry fee, a fee on profit

- A ticket costs the arena's entry fee and **the whole of it goes into the arena vault**: the coin starts at the
  entry fee. There is no entry or ticket fee.
- Value moves between players in play (eating). At the bell every live coin is paid its value.
- **A winning ticket pays 20 % of its profit** (profit = payout − entry fee): **15 % is burned** and **5 % goes to
  the fee wallet** (the vault of the business). Each share rounds down. **A loss or a break-even pays nothing.**
- The rates are fixed into the ticket at join; the owner may change them for new tickets only, and the contract
  caps the pair at **25 %** of the profit (`MAX_TOTAL_FEE_BPS`).
- Emblem holders can be given their own, lower pair (suggested: 15 % burned + 0 % to the fee wallet: the holder
  keeps the burn, the business waives its share). It applies only when it totals less than the normal pair.

Worked examples at the defaults (`computeProfitFee`, the contract's `computeFees`):

| Entry | Payout at the bell | Profit | Burned (15 %) | Fee wallet (5 %) | Player gets |
|---|---|---|---|---|---|
| 1,000 | 2,000 | 1,000 | 150 | 50 | **1,800** |
| 1,000 | 1,900 | 900 | 135 | 45 | 1,720 |
| 1,000 | 1,000 | 0 | 0 | 0 | 1,000 |
| 1,000 | 400 | 0 (a loss) | 0 | 0 | 400 |
| 250,000 | 1,000,000 | 750,000 | 112,500 | 37,500 | 850,000 |
| 1,000 | 1,001 (holder, 15 % + 0 %) | 1 | 0 (rounds down) | 0 | 1,001 |

Why on profit: arenas are zero-sum between players, so a fee on every entry would drain the table whatever anyone
did; a fee on profit charges only the value a player actually took from others, never their stake. The burn share
(three quarters of the fee) ties the token's supply to play.

A ticket that is never played is cancelled by the server with its full entry fee back; a ticket the server never
settles can be refunded by its player after 24 h (the entry fee, capped by the vault).

## 2. Power-ups: half burned, half to the fee wallet

Packs of **3 charges**, paid in the game token through `ElymumArena.pay(amount, ref)`: the contract burns
**50 %** (`paymentBurnBps`, owner-settable 0 to 100 %) and sends the rest to the fee wallet in the same call. The
server credits the charges after checking the `Paid` event (contract, payer, pack, amount).

| Pack | Price (tokens) | Per charge | vs the Asphodel ticket (1,000) | vs the Isles ticket (250,000) |
|---|---|---|---|---|
| Magnet | 600 | 200 | 20 % per use | 0.08 % |
| Speed burst | 600 | 200 | 20 % | 0.08 % |
| Leap | 900 | 300 | 30 % | 0.12 % |
| Invisibility | 1,200 | 400 | 40 % | 0.16 % |

Emblem holders pay 30 % less. **Paid arenas allow 2 uses per round** (3 for holders), so a big-arena player
cannot buy an edge by volume; practice and private rooms use charges freely, with cooldowns.

Pricing logic: a pack costs between 60 % and 120 % of the cheapest ticket, so in the entry arena a power-up is a
real decision (one charge is a fifth of a ticket or more), while the per-round cap keeps the higher arenas from
becoming pay-to-win. The prices are whole tokens and the admin can change them in `/admin` (Game → Power-ups); revisit
them once the token has a market price.

## 3. Floor loot: burned at the bell

Value a coin loses to something without a ticket spills on the floor as loot that any staker can pick up until the
bell; whatever is left is burned (`sweepLoot`, with a monotonic sweep id). With people only in the arenas this is a
safety path that rarely triggers.

## 4. Custom rooms: a small fee in ETH

A signed-in wallet opens a room with its own rules for **0.0005 ETH** (about $1.50 at ETH = $3,000) up to 10
players, +50 % per further 10 players (100 players: x5.5), paid as a plain ETH transfer to the treasury and checked on
chain before the room opens. Holders get 50 % off (or one free small room a day, an admin setting).

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

## 5. The Elymum NFT (emblem)

Minted for **$1 in ETH** (the price keeper follows ETH/USD within owner-set bounds), allowlist first, then public;
proceeds go to the NFT treasury. What it does in the economy:

- **Access** while the game opens in phases (holders play first).
- **A lower fee on profit** when the arena's holder perks are on (suggested 15 % + 0 %).
- **Holders-only arena** (the Isles of the Blessed, 250,000 entry).
- **30 % off power-ups** and **one extra power-up use per arena round**.
- **Cheaper custom rooms** (50 % off, or one free small room a day).
- **2x from the testnet faucet**; the emblem skin and the holder mark.

None of these create tokens; they lower what a holder pays into the sinks.

## 6. No inflation

| Flow | Direction |
|---|---|
| Entry fees | player → vault (held, paid back out to players) |
| Payouts | vault → players (net of the fee on profit) |
| Fee on profit | 15 % burned, 5 % fee wallet |
| Power-ups | 50 % burned, 50 % fee wallet |
| Floor loot | burned |
| Custom rooms, NFT mint | ETH, not the token |
| Mint of the game token | none (fixed supply; the testnet token is owner-minted only) |

The arena's books are checked on chain (`balance = Σ vaults + Σ owed`; per arena: deposited = vault + paid out +
burned + fees) and off chain (Σ live + Σ loot + Σ pending + Σ forfeited = Σ entry fees − Σ paid), by unit, fuzz and
invariant tests.

## Open questions

- Whether the Pons token exposes a working `burn()` (burn mode 1) is not documented: the arena burns to `0x…dEaD`
  until `/admin` shows it works (docs/RESEARCH.md).
- Power-up prices are in whole tokens; revisit them against the token's market price after launch.
- The custom room fee follows ETH; re-price it in `/admin` if ETH moves a lot.
