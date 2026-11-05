# Elymum: operations guide

What comes after the setup: deploying on Robinhood Chain Testnet, the server key and its gas, the fees and the
burn mode, the allowlist, the $1 price, opening the game, pausing, retiring an arena, moving to mainnet, ownership,
key rotation and backups. Elymum runs on **Robinhood Chain only** (testnet now, mainnet later; `CHAIN_ID`). Hosting:
[DEPLOY.md](DEPLOY.md). Money flow and trust model: [ARCHITECTURE.md](ARCHITECTURE.md). The economy:
[ECONOMY.md](ECONOMY.md). Chain facts and sources: [RESEARCH.md](RESEARCH.md).

Everything on chain is done from **`/admin`** with the **owner wallet** (connect, Sign in, then the tabs); the
CLI (`pnpm admin help`) has the same operations for a key file. Every transaction is previewed before the
wallet prompt, a double click cannot send twice, and on mainnet a red MAINNET banner stays at the top. The
server key is a separate hot key that only settles tickets, burns floor loot and (optionally) keeps the mint
price at $1.

## The admin panel

| Tab | What it does |
|---|---|
| **Launch** | The live checklist: chain, server key gas, contracts deployed and registered, token, arenas, allowlist root, $1 price, mint phase, game access. Each line links to the tab that fixes it |
| **Setup** | The deploy wizard (ElymumArena v3, ElymumNFT and, on the testnet, the TestToken), Finish setup, holder perks, the TestToken faucet, register an already deployed contract |
| **Mint** | Phase (closed / allowlist / public), publish the allowlist root, Sync to $1, price bounds and keeper, per-wallet limits, max supply (down only), base URI and freeze, contract URI, royalty, treasury, withdraw, owner mint |
| **Game** | Who may play, pause and per-arena open / close, map sizes, arena instances (auto-scaling), custom rooms, power-ups, leaderboards; the arena contract: status, the fee pair on profit, the burn mode (with the token's `burn()` probe), the power-up burn share, the fee wallet, arenas, sweeps, rescue, the server key's ETH balance |
| **Play** | Play the arenas yourself before launch |
| **WL**, **Tasks**, **Collabs** | The whitelist applications, the WL steps, the community collabs |
| **Integrity** | Cheat and collusion flags, bans, held payouts, detector settings |
| **Settings** | `wlOpen`, `collabOpen`, who may play (`gameAccess`: admins / holders / public), the X handle (default `elymum`) |

Admin endpoints need a SIWE session whose wallet is in `ADMIN_WALLETS`. Contract actions also need the
connected wallet to be the contract's owner and on the chain the server reports; otherwise signing is blocked
with the reason.

## The server key and gas

- `SERVER_PRIVATE_KEY=auto` keeps the key in `DATA_DIR/server-key.json` (mode 0600); its address is logged and
  published as `serverKey`. It must be the arena's **server authority** (set at deploy, changeable in Arena).
- It pays gas in **ETH** for every settlement batch (one per arena per bell, chunked at 40 tickets), every cancel,
  every loot burn and, when it is the price keeper, every re-price. Below **0.01 ETH** the server logs a warning and
  the Launch and Game tabs show it; with no gas at all the log says `!!! chain: the server key ... cannot pay gas`
  and settlements wait (nothing is lost: they stay in the journal). Top it up from any wallet.
- `!!! chain: the server key ... is NOT the arena's server authority` means the arena points at another key: set
  the server authority again (Game tab, the arena contract) or run the server with the right key.

## WL, collabs and the allowlist

The site's applications are run from `/admin` with an admin wallet signed in. Nothing here touches the chain
until you publish a root.

| Task | In `/admin` |
|---|---|
| Open or close the WL and collabs; the X handle | **Settings** |
| Review WL entries | **WL**: counts, filter, search (wallet, handle, note, id), open an entry for its answers, approve / reject / reset, a note; bulk actions on up to 500 rows |
| Export | **WL** → CSV (approved or all): `wallet,x_handle,status,created_at,dup_collabs,note` |
| Edit the WL steps | **Tasks**: add, edit, reorder, enable, delete; paste the launch post link to open the like / repost / reply step |
| Communities | **Collabs**: approve with spots and a deadline, extend, unlock a submitted list, export wallets (`collab_id,community,name,wallet,dup_wl,dup_collabs`) |

- Wallets are EVM addresses (checksummed); anything else is refused. One entry per wallet and per X handle.
- The X handle (Settings) defaults to `elymumio`. A data dir that still holds the earlier default `elymum` is
  switched to `elymumio` on start, and the seeded WL tasks (follow, post, launch post, handle, wallet) are pointed at
  the current handle; tasks you wrote and the answers stored in WL entries are never rewritten.
- Duplicates are flagged, never dropped: a collab wallet that is also on the WL (`dup_wl`) or in another list
  (`dup_collabs`) is marked; decide by hand.
- **Publishing the allowlist** (Mint tab): the server snapshots every approved WL wallet plus every wallet of a
  submitted collab list (EVM only, de-duplicated, sorted) and builds the Merkle tree; you sign `setMerkleRoot`.
  Players fetch their proof from `/api/site/mint/proof?wallet=`. When approvals change after a publish, the panel
  shows the diff (to add / to drop): publish again. Publishing a new root does not affect tokens already minted.
- Site files: `DATA_DIR/site/{settings,tasks,wl,collab}.json` (atomic writes). Back them up with the journal.

## The mint at $1 in ETH

The price is held in wei; the target is `MINT_USD_CENTS` (100 = $1) at the ETH/USD price from Hyperliquid's
public info API (`GAS_PRICE_URL`). The UI always shows the ETH amount with its USD value.

- **By hand:** Mint → **Sync to $1** computes the wei price for the current ETH/USD and asks your wallet to call
  `setPrice`. Do it before opening a phase and whenever the USD value drifts.
- **Automatically (price keeper):** set **price bounds** (`setPriceBounds`, e.g. $0.80 to $1.25 in wei at today's
  rate) and make the **server key the price keeper** (`setPriceKeeper`). Every 5 minutes the server re-prices when
  the price is off by more than 2 %, always clamped into your bounds; it logs `price keeper: ...`. It only moves after
  two consecutive ETH/USD readings agree within 3 %, and at most ±20 % per update (a big move takes several
  5-minute checks). The keeper can
  never price outside the bounds; widen or move them yourself if ETH moves a lot. Remove the keeper
  (`setPriceKeeper(0)`) to stop it.
- **Phases:** Closed → **Allowlist** (proof required, `wlLimit` per wallet) → **Public** (`publicLimit` per wallet;
  allowlisted wallets may still use their allowlist allowance). Opening the mint offers "activate the game for
  holders" (sets `gameAccess` to `holders`).
- **Who may play:** `admins` (default on mainnet; `public` on the testnet), `holders` (NFT `balanceOf > 0`, cached 15 s, plus admins) or `public`;
  `GAME_ACCESS` on the server overrides the setting. In `holders` mode every room entry checks the gate, and every
  arena seat (each new ticket, i.e. each round) re-reads `balanceOf` uncached right before seating.
  **Known limitation:** the gate is a snapshot at seat time. One NFT can be passed between wallets between rounds
  (or between joins), so several wallets can take turns playing on a single NFT; a seated player is not removed
  mid-round if they transfer it away. Tickets are bought on chain, so the server cannot refuse a ticket purchase
  itself: a non-holder who buys one is refused at the seat and gets the entry fee back by the stale-session refund.
- **Money:** mint proceeds stay in the NFT contract until **Withdraw** sends the whole balance to the treasury.
- **Metadata:** `tokenURI = baseURI + id`, served by the server at `/api/nft/<id>` (JSON) and `/api/nft/<id>.svg`.
  Change the base URI if the domain changes; **Freeze metadata** is forever.
- Supply can only go down (`setMaxSupply`, never below what is minted). Owner mints are for giveaways and the team.

## Integrity (cheat and collusion detection)

The server is authoritative (it runs the physics), so speed hacks and teleporting cannot happen. What is left is economic
and behavioural cheating, and the **Integrity** tab of `/admin` (admin wallet signed in) is where it shows up. The
detection is evidence for a person to review: nothing is punished automatically, and nothing on chain changes.

**What is recorded.** For every arena ticket the server keeps a small summary: who ate whom and how much value moved,
whose ejected mass was eaten by whom, idle (AFK) time and value received while idle, the IP and browser fingerprint as
keyed hashes (HMAC with a secret in `DATA_DIR/integrity/secret.key`; the raw IP is never stored), and input statistics
(timing of aim changes, direction-change spread, share of whole-number aims, reaction time to a threat that comes close).
The web sends the fingerprint with `join`: a SHA-256 of a random id kept in the browser plus language, time zone, screen
size and CPU count (no canvas or font probing). The server treats it as untrusted evidence: a missing or fake one proves
nothing. Practice rooms record nothing.

**Detectors** (pure functions in `apps/server/src/integrity/detectors.ts`, run every minute over the last 7 days and on
demand with **Run detectors now**). Each flag has a score from 0 to 100 and its evidence:

| Flag | Fires when (defaults) |
|---|---|
| Pair transfer | wallet B took value from wallet A on at least 4 occasions in 3+ rounds, net 2+ entry fees, and the chance of that is at most 1 in 10,000. The null model uses B's own eating rate against everyone else, so a strong player is not mistaken for a partner. An idle eater raises the score |
| Eject feeding | at least 40 of A's ejected blobs were eaten by other players and 70 % of them by B, over 2+ rounds (mass only, so the score is capped at 75) |
| Suicide feeding | a much smaller A kept moving toward the same bigger B (60 % of its last 3 s) and was eaten by B, 2+ times in 2+ rounds |
| Shared IP or browser | two wallets in one arena at the same time (30 s+) from one browser hash (60, both 80, +10 in one instance) or one IP hash (30, below the flag score: households, cafes and mobile carriers share IPs). Value moving between them adds 10 to 15 |
| Bot-like input | 2+ of: aim timing variation under 1 % (the web client sends on a 33 ms frame budget, so timing alone is weak), no mouse jitter (direction-change entropy at most 0.6 bits, or 95 % whole-number aims), median reaction under 110 ms over 20+ threats, play in 21+ hours of the last 24. The reaction signal alone also flags |
| Round-bell pattern | 3+ tickets that joined in the last 20 s before joins close and sat idle (80 %+) until the bell, or that gained half an entry fee or more while idle |

Every threshold is editable under **Detector settings → Thresholds** (with its default next to it); **Restore defaults**
puts them back. Flags scoring below `flagMinScore` (40) are not kept.

**Working a flag.** Open it for the summary, the evidence and the timeline of value transfers between the wallets (amount,
round, idle eater). Mark it **reviewed** (looked at, keep watching) or **dismissed** (explained, e.g. siblings on one
router), with a note. A dismissed or reviewed flag opens again only if its score rises by 20 or more. **CSV** exports the
filtered list.

**Bans.** **Ban…** (in a flag) or the **Banned wallets** card refuses new arena games for a wallet with the error
`banned` (the player sees "This wallet is banned from paid arenas after an integrity review. Practice is open."). A ticket
already in play finishes normally (it is the player's money), practice still works, and **Unban** lifts it at once.
A ban does not refund or move anything; the player can still collect or refund tickets on chain.

**Auto-hold (`integrityAutoHold`, default off).** When switched on, a profitable settlement (a bell, kick or age-limit
payout above the entry fee) whose wallet's risk score is at or above the hold score (default 90) is written to the journal
as **held** instead of being paid. A held item is owed, not lost: it counts in every conservation check and in the vault
guard, the settlement worker never sends it, and the stale sweeper never refunds it. In **Held settlements**:

- **Release** pays it exactly as it was.
- **Settle at 0** (a reason is required) settles the ticket on chain with payout 0. The value stays in the arena vault
  and is journaled as a forfeit (`journal.json` → `forfeits`), so the books still add up:
  Σ live + Σ loot + Σ pending + Σ forfeited = Σ entry fees − Σ paid. Forfeited value is surplus in the vault; it leaves
  only through `sweepArena` when the arena is retired.

**Decide within 24 hours.** A held ticket is still open on chain, and after 24 h its player may refund it themselves at
the entry fee (`refund`). The tab marks items older than 12 h in red. Every hold, release, settle at 0, ban and
unban is logged (`integrity: HELD …`, `RELEASED`, `SETTLED AT 0`, `BANNED`).

**Files.** `DATA_DIR/integrity/state.json` (settings, bans, flags; atomic writes), `secret.key` (keep it with the
backup: without it old hashes no longer match new ones), and `log/*.json` (immutable chunks of ticket summaries and
transfers, one per 30 s flush, deleted after 30 days or beyond 3,000 files). An unreadable `state.json` is moved aside
(`state.json.corrupt-*`, logged with `!!!`) and the service starts with no bans and auto-hold off. Memory holds at most
20,000 tickets and 60,000 transfers.

**Cost.** The telemetry runs in the arena rooms only: a few counters per input message and a threat check every second
tick. `pnpm -F @elymum/server integrity-sim` plays the same seeded arena with and without it and prints both tick times,
the flags honest players raise (none at the defaults) and those two scripted bots raise.

## Monitoring

- `GET /api/health`: ok, uptime, players, rooms (the Docker health check).
- `GET /api/config`: the chain (`chainId`, `chainName`, `testnet`, `faucetUrl`, `explorerUrl`), the arena and NFT
  addresses, `tokenReady`, the token, `fees` (the fee pair on profit, the holder pair, the payment burn share, the
  burn mode), `serverKey`.
- `GET /api/rooms`: rooms, instances, people (and the practice bots of free custom rooms), floor loot.
- `GET /api/pending?wallet=0x...`: payouts the server is still sending for a wallet. A finalized session (the payout
  transfer failed) is collected by the player with `refund`, any time.
- `GET /api/site/mint`: the mint state, ETH/USD, the price in USD, holders, game access.
- Log lines starting with `!!!` need attention: an unreadable journal, an arena whose vault falls short, the wrong
  server authority, no gas, a fee wallet that cannot receive the token, an arena contract whose code hash differs,
  an RPC that serves another chain than `CHAIN_ID` (`!!! chain: EVM_RPC_URL serves chain …`).
  `integrity: HELD ...` means a payout waits in `/admin` → Integrity.

## Fees, burns and the fee wallet

ElymumArena v3 takes **no entry fee**. A winning ticket pays a fee on its **profit** (payout − entry fee):
`burnBps` (15 %) is burned and `vaultBps` (5 %) goes to the fee wallet, both in the `settle` batch that settles it
(one burn and one transfer per batch). A loss or a break-even pays nothing; an unplayed ticket is cancelled with its
full entry fee back. Power-up packs are paid with `pay`: `paymentBurnBps` (50 %) is burned and the rest goes to the
fee wallet at once. Example: entry 1,000, payout 2,000 → 150 burned, 50 to the fee wallet, 1,800 to the player
(ECONOMY.md has more).

| Setting | In `/admin` → Game → the arena contract → Advanced | Contract call | Limits |
|---|---|---|---|
| Fee pair on profit | Fees → Burned / To the fee wallet | `setFeeRates(burnBps, vaultBps)` | together at most 2,500 bps (25 %); new tickets only |
| Holder pair | Setup → Holder perks | `setHolderPerks(nft, holderBurnBps, holderVaultBps)` | used when it totals less than the normal pair; suggested 1,500 + 0 |
| Power-up burn share | Fees → Power-up payments burned | `setPaymentBurnBps(bps)` | 0 to 10,000 |
| Burn mode | Fees → Preview mode 0 / mode 1 | `setBurnMode(0 or 1)` | mode 1 only when the token's `burn()` works |
| Fee wallet | Fees → Fee wallet | `setFeeWallet(address)` | any address that can receive the token |

**Burn mode.** Mode 0 (the default) sends burned tokens to `0x…dEaD`: it works with any ERC-20 and the tokens are
gone for good, but `totalSupply` does not change. Mode 1 calls the token's own `burn(uint256)`: `totalSupply` falls.
The arena accepts a burn only when its balance fell by exactly the amount; a token whose `burn()` does nothing falls
back to `0x…dEaD`, one that burns a different amount makes the batch revert. The panel probes the token
(`eth_call` of `burn(0)` from the arena) and shows "the token has a working burn()" or not; it refuses mode 1 when
the probe fails. The bundled TestToken is ERC20Burnable (mode 1 works on the testnet); whether a Pons token has a
working `burn()` is not documented (RESEARCH.md): keep mode 0 until the probe says yes.

**The fee wallet** is an ordinary address: what it holds is yours. A swept arena's vault also goes there. If the
transfer to it fails (a token that refuses that address), the whole batch reverts and the server logs
`!!! chain: settle batches revert on the fee transfer`: change the fee wallet and the pending settlements go out
by themselves.

## Deploying on Robinhood Chain Testnet

Everything is done from `/admin` with the owner wallet; nothing needs a terminal once the server runs.

1. **Server.** Set `CHAIN_ID=46630` (the default), `EVM_RPC_URL` (the public `https://rpc.testnet.chain.robinhood.com`
   works; a provider such as Alchemy is better for production), `SERVER_PRIVATE_KEY=auto`, `ADMIN_WALLETS` and
   `PUBLIC_URL`, then start it. The log shows `chain: Robinhood Chain Testnet (chain id 46630)` and the server key;
   `/api/config` publishes it as `serverKey`.
2. **Gas.** Get testnet ETH for the owner wallet and the server key (faucet: `faucet.testnet.chain.robinhood.com`,
   or Alchemy's; see RESEARCH.md: the faucet URL is unconfirmed, override the link with `GAS_FAUCET_URL`). A few
   hundredths of an ETH last a long time on an Arbitrum chain.
3. **Wallet.** Open `/admin`, connect the owner wallet and Sign in. The panel asks the wallet to add or switch to
   Robinhood Chain Testnet (chain id 46630, RPC, explorer) when it does not know it.
4. **Deploy** (Setup → the deploy wizard; each step is previewed and registered with the server on success):
   - **TestToken** (testnet only): an ERC20Burnable game token with a faucet; the owner mints, nobody else.
   - **ElymumArena v3** with the server key as server authority and the owner (or a separate wallet) as fee wallet.
     The server checks the code hash and the server authority before it registers it.
   - **ElymumNFT** at the $1 price in ETH (the wizard reads ETH/USD).
5. **Finish setup** (one button, the remaining steps in order): set the TestToken as the arena's game token, create
   the four arenas (1,000 / 10,000 / 50,000 / 250,000), the holder perks (15 % + 0 %), the Isles of the Blessed
   holders-only, the emblem as the faucet's 2x, and on the testnet open the mint to the public. The server picks the
   token up within 30 s and the lobby opens the arenas without a reload.
6. **Burn mode** (optional on the testnet): Game → the arena contract → Advanced → Fees: the probe shows the
   TestToken's working `burn()`; preview mode 1 if you want `totalSupply` to fall.
7. **Check**: Launch shows every line green; buy a ticket in the Play tab, play a round, see the receipt (fee on
   profit), buy a power-up pack.

The same can be scripted with the CLI (`pnpm admin help`: `deploy-test-token`, `deploy-arena`, `deploy-nft`, `set-token`, `create-arena`, `fee`,
`burn-mode`, `payment-burn`, `holder-perks`, `status`) and a key file.

## Moving to Robinhood Chain (mainnet)

The testnet and the mainnet are two networks of the same chain; the server follows `CHAIN_ID`.

1. Deploy the game token on Pons (mainnet only; RESEARCH.md), then on the server set `CHAIN_ID=4663` and
   `EVM_RPC_URL` to a mainnet RPC (a provider), keep `SERVER_PRIVATE_KEY` or rotate it, fund the server key with ETH,
   and restart. The server opens a clean state in `DATA_DIR/chains/4663/`; the testnet's records stay in
   `chains/46630/` (the Network tab lists them).
2. Deploy ElymumArena v3 and ElymumNFT from `/admin` (no TestToken on mainnet), set the token, create the arenas,
   set the holder perks, publish the allowlist root, Sync to $1. Keep burn mode 0 until the probe shows the token's
   `burn()` works.
3. "Import testnet emblem holders" (Mint tab) reads the testnet NFT through `TESTNET_RPC_URL` (default the public
   testnet RPC) and adds its holders to the mainnet allowlist.
4. On mainnet a red MAINNET banner stays at the top of `/admin` and `JOURNAL_ABANDON_CONTRACT` is refused.

## Resetting the leaderboards

`/admin` → Game → Leaderboards → "Reset both leaderboards" (`POST /api/admin/leaderboards/reset` with
`{"confirm":"RESET"}`, admin session) clears the Today and All-time boards and keeps the old file as
`leaderboards.json.reset-<ms>.bak`. Raising `LEADERBOARD_EPOCH` in `apps/server/src/leaderboards.ts` resets them once
on the next deploy (the old file is kept as `leaderboards.json.epoch-<n>-<ms>.bak`). Profiles (XP, levels, games,
kills, best score) are never touched.

## Arena rounds and the loot burn

Paid arenas play wall-clock rounds: `ROUND_SECONDS` (default 300) and `ROUND_JOIN_CLOSE_SECONDS` (default 60,
capped at half a round). Round *n* covers `[n x ROUND_SECONDS, (n + 1) x ROUND_SECONDS)` of Unix time, so keep the
server clock synced. At the bell every live ticket is settled at its value in one batch, and the floor loot is
journaled as a sweep and sent with `sweepLoot(arenaId, sweepId, amount)`, which **burns** it (to `0x...dEaD`). The
`sweepId` is monotonic and kept in the journal, so a sweep is never applied twice.

- `!!! chain: arena #N vault cannot cover ...` means the vault holds less than the journal says; the server retries
  with backoff. Check the arena in `/admin` → Arena before doing anything.
- `sweepLoot` is capped only by the vault (the same trust as a payout): **protect the server key**.
- Unplayed tickets are cancelled with their full entry fee after `STALE_SESSION_AFTER_S` (15 minutes).

## Custom rooms and practice with bots

`/admin` → Game → **Custom rooms** (`/api/admin/custom-rooms`, `DATA_DIR/site/custom-rooms-settings.json`): creating
on / off, ticket rooms on / off, the base price and its step per 10 players, the biggest room (up to 100 players),
the seats of all live rooms together, the holder perk, the live rooms (close one: a free room ends after a 10 s
countdown and its final board, a ticket room at its bell). **Practice with bots** on / off and "practice rooms at
once" (`practiceMaxLive`, default 12, 0..50): the free one-click rooms the quiet ponds offer (8 bots, 15 minutes, one
per player, 4 per IP per 30 minutes, closed after 2 minutes empty). They take none of the paid rooms' slots or seats;
each costs about 8 bots of CPU, so 12 at once is about 100 practice bots.

## Share on X

Players get a "Share on X" button on a bell's receipt, a custom room's final board and, for a few seconds, after
eating a big coin (1,000+ mass). It opens X's composer (`x.com/intent/post`, no X API or keys) with a localized line
and a link to `/share/<id>`, whose Open Graph image X shows as the card. The server makes each card from its own
records (name, the wallet's short form, the coin's paint, flag code, emblem badge, place, mass, kills, net paid):
nothing else, and nothing a client sends. Cards live in `DATA_DIR/site/shares.json` (the newest 5,000). The image is
rendered on demand and cached (30 renders per IP a minute). On Vercel, `vercel.json` rewrites `/share/*` to the game
server like `/api/*`; in Docker the server serves it on the same origin; `pnpm dev` proxies it.

## Arena instances (auto-scaling)

Each official arena (ticket tier) runs as public instances `arena-<id>-<n>` of `ARENA_INSTANCE_CAP` (50) seats
on the same vault. The scaler (`apps/server/src/rooms/arena-scaler.ts`, rules in
`packages/shared/src/arena-scaling.ts`) samples every 5 s and decides per arena:

- **Seating:** a ticket goes to the fullest instance taking seats that is not full (rooms stay lively). When every
  one is full a draining instance is taken back first, else a new instance opens on the least-loaded room worker.
  At the maximum a bought ticket still gets a seat (an `overflow`, logged): a paid ticket is never left waiting.
- **Scale up** (ahead of demand, up to `maxInstances`): an instance reached capacity `fullHits` times in
  `windowMin` minutes while the arena was at least `highPct` % full, or the arena stayed at least `highPct` % full
  for `sustainMin` minutes.
- **Scale down** (down to `minInstances`): the arena's peak fill over `lowMin` minutes stayed under `lowPct` %, and
  one instance fewer would still hold that peak under `highPct` %. The emptiest extra instance (never #1) starts
  **draining**: it takes no new seat, its people play on, their tickets settle at the bell like everywhere else, and
  it closes once nothing of value is left in it (no player, ticket or loot); its spectators go back to the lobby.
  Nobody is evicted.
- **Hysteresis:** `lowPct` must stay below `highPct`, a consolidation must leave room under the busy line, and the
  scaler's own moves are at most one per arena per `cooldownMin` minutes.

| Setting | Default | Range |
|---|---|---|
| Scale ahead of demand (`enabled`; off: overflow only, and only empty extra instances close) | on | on / off |
| `minInstances` / `maxInstances` per arena | 1 / 6 | 1..10 / 1..20 |
| `fullHits` in `windowMin` | 3 in 10 min | 1..50 / 1..120 |
| `highPct` for `sustainMin` | 80 % for 2 min | 10..100 / 1..60 |
| `lowPct` for `lowMin` | 35 % for 10 min | 0..90 / 1..240 |
| `cooldownMin` | 3 min | 0..60 |

`/admin` → Game → **Arena instances** (`GET` / `PUT /api/admin/arena-scaling`, stored in
`DATA_DIR/site/arena-scaling.json`, applied at the next sample): the settings, every arena's instances (people /
seats, draining, the worker each runs on) and the last 100 decisions (`open`, `overflow`, `drain`, `undrain`,
`close`, each with its reason). `pnpm -F @elymum/server arena-sim` plays arrival waves against the real room
directory and prints the instances minute by minute and every decision, then checks that every seated ticket was
settled exactly once.

## Pausing and emergencies

| What | How | Effect |
|---|---|---|
| Stop new tickets | Arena → **Pause** (`setPaused(true)`; CLI `pnpm admin pause`) | `join` is refused; **settlements, refunds and collects go on**. Undo with Unpause |
| Close one arena | Arena → disable it (`updateArena(..., enabled=false)`) | no new tickets there; open ones are played and settle |
| Close the arenas on the server | `STAKE_ENABLED=false`, restart | the arenas leave the lobby; the settlement queue keeps running |
| Close the game to players | Settings → who may play: `admins` | everyone else sees the gate; tickets already bought can still be refunded after 24 h |
| Close the mint | Mint → phase **Closed** | no mints; nothing else changes |
| Change the fees | Game → the arena contract → Fees (`setFeeRates`, at most 2,500 bps together) | applies to tickets bought from now on; open tickets keep their rates |

On `SIGTERM` the server settles the players in the arenas at their current value (an operator exit) and saves its
state; Docker `stop` and Render deploys send it.

### Retiring an arena (sweep)

1. Disable the arena (Game tab).
2. Wait until it has no open sessions: live tickets settle at the next bell; a finalized payout counts as open
   until its player collects it (that money is theirs: wait); unsettled tickets can be refunded by players after
   24 h. Make sure `/api/rooms` shows no loot left in its rooms and the log no pending item for it.
3. **Sweep arena** (`sweepArena(id)`): the whole vault goes to the fee wallet. The contract refuses while the arena
   is enabled or has open sessions. Do not re-enable a swept arena; the server keeps an arena whose vault does not
   cover the journal disabled (`!!! arena #N KEPT DISABLED`).

## Ownership

Both contracts are **Ownable2Step**: ownership moves only when the new owner accepts.

1. From the current owner: `transferOwnership(newOwner)` on the arena and on the NFT (the admin panel where
   offered, or the contract's write page on the explorer, or any tool that sends a contract call;
   the SDK has `transferOwnershipCall`).
2. From the new owner: `acceptOwnership()` on each contract. Until then the old owner stays in control.
3. Add the new owner to `ADMIN_WALLETS` on the server (and remove the old one when you are done). Registering the
   contracts again from `/admin` is only needed if you move to new contracts.

A multisig (e.g. a Safe on Robinhood Chain) can be the new owner: it then signs every owner action.
The fee wallet and the NFT treasury are separate settings: change them too if they were the old owner.

## Rotating the server key

1. Pause the arena (optional but calm) and stop the server (SIGTERM: live tickets settle, the journal is saved).
2. Give the server a new key: move `DATA_DIR/server-key.json` aside (with `auto` a new key is generated at the next
   start) or set `SERVER_PRIVATE_KEY` to a new 0x key or key file. Start the server and note the new `serverKey`.
3. Fund the new key with ETH.
4. Game → the arena contract → **Server authority** → the new key (`setServerAuthority`). If the old key was the NFT price keeper, set the
   new one as keeper too (`setPriceKeeper`). The pending settlements in the journal go out with the new key.
5. Move any ETH left on the old key elsewhere and destroy it.

If the key **leaked**: pause first, then step 4 at once. Until it is replaced the old key can settle open tickets
with any amount up to a vault and burn up to a vault with `sweepLoot`.

## Journal and data backup

| File in `DATA_DIR` | Contents | If it is lost |
|---|---|---|
| `chains/<id>/journal.json` | pending settlements, live values, floor loot, the last `sweepId`, the arena contract it belongs to | owed payouts drop out of the queue (players can only refund the entry fee after 24 h); the stale sweeper stays off while a quarantined copy exists |
| `server-key.json` | the server key (`auto`) | a new key: set it as server authority again |
| `chains/<id>/contracts.json` | the registered arena, NFT and test token | register them again from `/admin` |
| `site/*.json`, `profiles.json`, `leaderboards.json` | WL, collabs, tasks, settings, map sizes, arena scaling, shop and custom room settings, share cards, names and skins, standings | the site data and profiles are gone; keep backups (lost share cards only break old links) |
| `integrity/` | integrity state, the hashing secret, ticket summaries | flags and bans are gone |

- The journal is written to a temporary file and renamed, so the file on disk is always a complete snapshot. Copy
  `DATA_DIR` regularly and keep the copies encrypted (they hold a private key and wallet addresses).
- An unreadable journal is moved aside as `journal.json.corrupt-<time>` with a `!!!` log, and the stale sweeper stays
  off until you inspect it and restart with `STALE_SWEEP_ACK=1` (or move the file away).
- **The journal is bound to one arena contract.** While it owes money (pending settlements, live tickets, floor loot)
  on an arena, the server refuses to switch to another arena contract: `POST /api/admin/contracts` answers 409
  `wrong_state`. Let the rounds settle first, or start the new arena on a fresh `DATA_DIR`.
- Never run two servers on the same `DATA_DIR` or the same server key.
