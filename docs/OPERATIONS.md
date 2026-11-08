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
| **Game** | Who may play, pause and per-arena open / close, map sizes, **arena prices in US dollars** (the token price, the tiers, "Sync arena prices to USD", "Re-price at next bell"), arena instances (auto-scaling), custom rooms, power-ups (priced in US dollars, converted like the tickets), leaderboards; the arena contract: status, the fee pair on profit, the burn mode (with the token's `burn()` probe), the power-up burn share, the fee wallet, arenas, sweeps, rescue, the server key's ETH balance and gas runway |
| **Play** | Play the arenas yourself before launch |
| **WL**, **Tasks**, **Collabs** | The whitelist applications, the WL steps, the community collabs |
| **Integrity** | Cheat and collusion flags, bans, held payouts, detector settings |
| **Settings** | `wlOpen`, `collabOpen`, who may play (`gameAccess`: admins / holders / public), the X handle (default `elymum`) |

Admin endpoints need a SIWE session whose wallet is in `ADMIN_WALLETS`. Contract actions also need the
connected wallet to be the contract's owner and on the chain the server reports; otherwise signing is blocked
with the reason.

**Admin sessions** last `ADMIN_TOKEN_TTL_MIN` (120 minutes) and are never extended by a reconnect (sign in again);
a player's session lasts 24 h. `POST /api/admin/auth/revoke {"wallet":"0x…"}` ends one wallet's sessions,
`{"wallet":"admins"}` every admin session (kept across restarts); changing `AUTH_SECRET` ends every session.

**Secret exports.** `GET /api/admin/backup` (the data volume, server key included) and `GET /api/admin/migration-env`
(the server's settings, `SERVER_PRIVATE_KEY` and `AUTH_SECRET` included) need, besides the session, a fresh
signature of the admin wallet for that purpose: `POST /api/admin/secret-proof {"purpose":"backup"}` (or
`"migration"`: the settings and the backup, each once) returns a text to sign with the wallet (`personal_sign`);
the base64url of `{"message","signature"}` goes in the `X-Elymum-Proof` header. A proof is single use and expires
after 10 minutes. Every request of these routes is in the audit log, reads included. On the mainnet they are off
unless `ADMIN_SECRET_EXPORT=1` is set on the server for the time of a move.

## The server key and gas

- `SERVER_PRIVATE_KEY=auto` keeps the key in `DATA_DIR/server-key.json` (mode 0600); its address is logged and
  published as `serverKey`. It must be the arena's **server authority** (set at deploy, changeable in Arena).
- It pays gas in **ETH** for every settlement batch (one per arena per bell, chunked at 40 tickets), every cancel,
  every loot burn and, when it is the price keeper, every re-price. Eaten tickets (payout 0) wait up to
  `DEATH_SETTLE_BATCH_S` (6 s) for each other and go out in one batch.
- **Gas runway.** The balance is read every 5 minutes; its drops over the last day (a top-up is not spend) give the
  spend per day and the days left. Under **7 days** the log warns (`chain: WARNING gas runway under 7 days`, every
  6 h) and the alert job posts it; under **2 days**, or under the floor `GAS_FLOOR_ETH` (0.002 ETH), it is
  `!!! chain: gas LOW`, `/api/health` answers 503 and the Launch and Game tabs show it (`GET /api/admin/network` →
  `gas`: balance, spend per day, days, level). With no gas at all the log says `!!! chain: the server key ... cannot
  pay gas` and settlements wait (nothing is lost: they stay in the journal). Top it up from any wallet; at the
  mainnet gas price a week of runway is a few thousandths of an ETH (`pnpm -F @elymum/server econ-sim`).
- `!!! chain: the server key ... is NOT the arena's server authority` means the arena points at another key: set
  the server authority again (Game tab, the arena contract) or run the server with the right key.

### What the server key can do, and the limits around it

The arena contract lets its server authority settle any open ticket with any payout up to that arena's vault. So
whoever holds the key could buy a ticket from a wallet of their own and settle it with the whole vault (less the fee
on profit): **the open stakes of the arenas are what a stolen key can take** (never owed payouts, never the fee
wallet, never another contract; the contract test `test_security_compromisedServerKey_blastRadiusIsTheOpenVault`).
Rounds settle every 5 minutes, so a vault normally holds only the tickets in play (plus forfeits).

The server limits what a bug, a tampered journal or a confused process can pay through it:

| Guard | What it does |
|---|---|
| **Payout guard** | a settlement paying one ticket more than every ticket of its round's instance put in (its `roundPool`: the entry fees seated there that round, plus loot restored into it; no game can win more) is not sent: it is held in `/admin` → Integrity → Held settlements (`payout guard: ...`, `!!! chain: settlement ... HELD for review`). A settlement without a pool (crash recovery) is held above `PAYOUT_GUARD_MULTIPLE` (100) entry fees. **Release** pays it exactly as it was; **Settle at 0** keeps it in the vault. It is never released by itself; `PAYOUT_GUARD_MULTIPLE=0` turns the guard off |
| **Books guard** | before anything leaves an arena vault, what the journal owes that arena (pending payouts and burns of tickets still open on chain, live tickets, floor loot) must fit in the vault. If not (`!!! chain: arena #N PAYOUTS STOPPED`), nothing is paid from that arena until the books add up again: the stakes stay in the vault, the Integrity tab shows "Payouts stopped" with the pending settlements, and each can be **held** by hand and settled at 0 |
| **Settled log** (`DATA_DIR/chains/<id>/settled.jsonl`) | every settlement, cancel and loot burn the server saw confirmed, for 14 days: a settlement reorged out (the ticket open again) is sent again with the same payout instead of being refunded at the entry fee by the stale sweeper; the record of what each ticket was paid, and in which transaction, for appeals |
| **Sweep ids** | a `lastSweepId` beyond 2^53 (only a server key can set it) stops loot burns of that arena loudly instead of guessing |

**Key management.**

- The server key is a **hot key with gas only**: it never holds tokens, never owns a contract, never is the fee wallet
  or the NFT treasury. Keep about 0.05 ETH on it and top it up; anything more is risk without use.
- The **owner** of both contracts should be a **multisig** (a Safe on Robinhood Chain, 2 of 3 with keys on separate
  hardware wallets): it is the key that can rotate the server key, pause, and change fees. "Ownership" below moves it.
- `DATA_DIR/server-key.json` is mode 0600 and inside the backup: keep backups encrypted (they hold this key).
- **Rotate** the server key at least once a year, at once when the VPS or a backup may have been exposed, and whenever
  a person with server access leaves ("Rotating the server key" below). After a suspected leak: **pause** the arena
  first (no new tickets), then `setServerAuthority` to a fresh key from the multisig; the stolen key is useless
  from that block on.

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
  `GAME_ACCESS` on the server overrides the setting (`site`: the setting decides). In `holders` mode every room entry
  checks the gate, and every arena seat (each new ticket, i.e. each round) re-reads `balanceOf` uncached right before
  seating.
- **One emblem, one holder perk at a time.** The contract checks the emblem only when a ticket is bought, and an
  emblem can be passed from wallet to wallet in seconds (or flash-borrowed). So at the seat of a **holder ticket** (a
  holders-only arena, or a ticket bought at the holder fee rates) the server re-reads the holding fresh and binds the
  ticket to one of the wallet's token ids (from the NFT's `Transfer` logs, `DATA_DIR/chains/<id>/emblem-claims.json`)
  until it is settled: a token id serves one open holder ticket at a time. An extra ticket is refused at its seat and
  cancelled at once with its full entry fee; an emblem passed on while its ticket is open raises an integrity flag
  (Shared device · emblem shared). The power-up holder discount and the free daily custom room go to one wallet per
  token id per UTC day. A seated player is not removed mid-round if they transfer the emblem away (the ticket keeps
  its token id until its bell). Tickets are bought on chain, so the server cannot refuse a purchase itself.
- **Money:** mint proceeds stay in the NFT contract until **Withdraw** sends the whole balance to the treasury.
- **Metadata:** `tokenURI = baseURI + id`, served by the server at `/api/nft/<id>` (JSON) and `/api/nft/<id>.svg`.
  Change the base URI if the domain changes; **Freeze metadata** is forever (never before the reveal: the reveal
  needs one `setBaseURI` to tell marketplaces to refresh).
- **Emblem reveal** (docs/NFT-DESIGN.md, "Fair mint"): every token shows the sealed emblem until the reveal.
  1. Before the mint opens: read `GET /api/nft/provenance` and put the commitment on chain:
     `setContractURI("<PUBLIC_URL>/api/nft/contract?provenance=<provenance>")` (a timestamped transaction), and
     post the seed hash and the provenance hash publicly.
  2. After the mint (phase **Closed**, or sold out): `POST /api/admin/nft/reveal/schedule {}` fixes a reveal block
     50 blocks ahead (`{"block": n}` for another one, at least 10 ahead).
  3. Once that block is mined: `POST /api/admin/nft/reveal {}`. The seed is published, the offset comes from the
     block's hash, and every token shows its emblem. Then `setBaseURI` with the same URI (it emits ERC-4906
     `BatchMetadataUpdate`, so marketplaces refresh).
  Never reopen the mint after the reveal (the next ids' art would be known). `GET /api/admin/nft` shows the state,
  the rarity counts and the mint; `pnpm -F @elymum/server nft:report --seed <seed>` re-checks a collection.
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
| Input twins | two wallets with automated input (the bot-like input tests) whose input statistics match (direction-change distributions within 0.02 bits, the same timing) and that played the same room at the same time in 2+ rounds: one script, several accounts. Only automated wallets are compared, so people never match; the score (60 to 75) stays below the hold score on its own |
| Fresh feeders (pair transfer · `fresh_feeders`) | one wallet took at least half of what fresh wallets (at most 2 tickets in the window) lost in its rounds, from 4+ of them over 3+ rounds, 2+ entry fees, and 2.5 times its share of the other losses there: sybil feeding (a new wallet per round, which the pair detector cannot see). 8+ feeders reach the hold score. The econ-sim abuse study flags its sybil ring at 100 and no honest wallet |
| Non-aggression (pair transfer · `non_aggression`) | two wallets often within eating range (the bigger one at least 1.3 times the smaller, the gap under 250) that never ate each other over 3+ rounds, while each one's eat rate elsewhere makes 6+ eats expected: a pact. Below the hold score on its own; the emulated players of the econ-sim are within range of each other without eating so often that its teaming ring is not caught (evidence for a person, not proof) |

Every threshold is editable under **Detector settings → Thresholds** (with its default next to it); **Restore defaults**
puts them back. The two newer detectors use the fixed `COLLUSION_DEFAULTS` (`integrity/detectors.ts`) until they get
admin thresholds. Flags scoring below `flagMinScore` (40) are not kept. **Shared funding** (feeder wallets that got
their first gas or tokens from one wallet) is not detected: the server indexes no ETH or ERC-20 transfers, only the
arena's `Joined` and the NFT's `Transfer` logs; check a flagged ring's funding by hand on the explorer.

**Working a flag.** Open it for the summary, the evidence and the timeline of value transfers between the wallets (amount,
round, idle eater). Mark it **reviewed** (looked at, keep watching) or **dismissed** (explained, e.g. siblings on one
router), with a note. A dismissed or reviewed flag opens again only if its score rises by 20 or more. **CSV** exports the
filtered list.

**Bans.** **Ban…** (in a flag) or the **Banned wallets** card refuses new arena games for a wallet with the error
`banned` (the player sees "This wallet is banned from paid arenas after an integrity review. Practice is open."). A ticket
already in play finishes normally (it is the player's money), practice still works, and **Unban** lifts it at once.
A ban does not refund or move anything; the player can still collect or refund tickets on chain.

**Auto-hold (`integrityAutoHold`: on by default on the mainnet, 4663; off on a testnet unless switched on).** When on, a profitable settlement (a bell, kick or age-limit
payout above the entry fee) whose wallet's risk score is at or above the hold score (default 90) is written to the journal
as **held** instead of being paid. A held item is owed, not lost: it counts in every conservation check and in the vault
guard, the settlement worker never sends it, and the stale sweeper never refunds it. In **Held settlements**:

- **Release** pays it exactly as it was.
- **Settle at 0** (a reason is required) settles the ticket on chain with payout 0. The value stays in the arena vault
  and is journaled as a forfeit (`journal.json` → `forfeits`), so the books still add up:
  Σ live + Σ loot + Σ pending + Σ forfeited = Σ entry fees − Σ paid. Forfeited value is surplus in the vault; it leaves
  only through `sweepArena` when the arena is retired.

**Decide within 24 hours.** A held ticket is still open on chain, and after 24 h its player may refund it themselves at
the entry fee (`refund`). The tab marks items older than 12 h in red. So that a false positive never costs a player
the winnings, an auto-held payout nobody decided on is **paid as settled after `autoReleaseHours`** (default 20 h,
Detector settings; 0 turns it off; `integrity: ... AUTO-RELEASED`). Holds of the payout guard and holds by hand wait for
a person. If a player does refund a held ticket, the server drops the item and journals the difference (payout −
entry fee) as a forfeit, so the books keep matching the vault. Every hold, release, settle at 0, ban and unban is
logged (`integrity: HELD …`, `RELEASED`, `SETTLED AT 0`, `BANNED`), and every admin write is in the audit log
(`DATA_DIR/admin-audit.jsonl`, `GET /api/admin/audit`: who, what path, when, from which address, the answer).

**Files.** `DATA_DIR/integrity/state.json` (settings, bans, flags; atomic writes), `secret.key` (keep it with the
backup: without it old hashes no longer match new ones), and `log/*.json` (immutable chunks of ticket summaries and
transfers, one per 30 s flush, deleted after 30 days or beyond 3,000 files). An unreadable `state.json` is moved aside
(`state.json.corrupt-*`, logged with `!!!`) and the service starts with no bans and auto-hold off. Memory holds at most
20,000 tickets and 60,000 transfers.

**Cost.** The telemetry runs in the arena rooms only: a few counters per input message and a threat check every second
tick. `pnpm -F @elymum/server integrity-sim` plays the same seeded arena with and without it and prints both tick times,
the flags honest players raise (none at the defaults) and those two scripted bots raise.

## Monitoring

- `GET /api/health`: 200 when nothing needs a person, **503 with `reasons`** when the journal cannot be written,
  more than `HEALTH_MAX_PENDING` (400) settlements are due or the oldest is older than `HEALTH_MAX_PENDING_AGE_S`
  (15 min), the RPC did not answer for 3 minutes, the server key's gas runway is under 2 days, the books guard stopped
  an arena, the server clock is more than 30 s off the chain's, or a room worker is down; plus uptime, players,
  rooms, the journal (pending, held, oldest), the chain (reachable, last answer, clock skew), `gas` (the runway) and
  the books guard. `GET /api/health?live=1` only says the process answers: the container's health check (a server
  that waits on the RPC, or whose disk is full, must not be restarted for it).
- **Alerts:** on the VPS `elymum-alert.timer` posts to Telegram every minute on a `!!!` log line, a 503 and its
  reasons, a gas runway under 7 days, a disk over 80 %, the container down; it restarts an app whose liveness check
  failed 3 minutes in a row (deploy/vps/README.md, "Alerts and autoheal").
- **Clock:** ticket ages (the 15-minute stale limit, the 6-hour cap) are measured on the chain's clock (the latest
  block's timestamp), never the server's; `!!! clock: the server clock is N s ahead of the chain` means NTP is off.
- `GET /api/config`: the chain (`chainId`, `chainName`, `testnet`, `faucetUrl`, `explorerUrl`), the arena and NFT
  addresses, `tokenReady`, the token, `fees` (the fee pair on profit, the holder pair, the payment burn share, the
  burn mode), `serverKey`.
- `GET /api/rooms`: rooms, instances, people (and the practice bots of free custom rooms and test arenas), floor loot.
- `GET /api/pending?wallet=0x...`: payouts the server is still sending for a wallet. A finalized session (the payout
  transfer failed) is collected by the player with `refund`, any time.
- `GET /api/site/mint`: the mint state, ETH/USD, the price in USD, holders, game access.
- Log lines starting with `!!!` need attention: an unreadable journal or one that cannot be written (disk full:
  nothing is sent and no new arena seat is taken until it can), an arena whose vault falls short, the wrong server
  authority, low gas, a fee wallet that cannot receive the token, an arena contract whose code hash differs, an RPC
  that serves another chain than `CHAIN_ID` (`!!! chain: EVM_RPC_URL serves chain …`, or a fallback of
  `EVM_RPC_URLS` left out), the server clock off the chain's, an emblem seat refused.

## RPC

`EVM_RPC_URLS` (on the VPS: `ELYMUM_RPC_URLS` in `/opt/elymum/.env`) lists the server's RPCs in order: the provider (Alchemy, `https://robinhood-mainnet.g.alchemy.com/v2/<key>`)
first, the public RPC (`https://rpc.mainnet.chain.robinhood.com`) as fallback. Reads and sends go through a viem
fallback: a URL that keeps answering 429 or is down hands the call on after two tries, and the first URL is tried
first again for every new call; a resent transaction is the same signed one (same hash and nonce). Each URL has its
own budget (`RPC_MAX_RPS`, on the VPS `ELYMUM_RPC_MAX_RPS`, e.g. `25,4`). Concurrent reads merge into one Multicall3 call, or a deployless multicall
on a chain without Multicall3 (the log says which), so the bell of 200 tickets reads its sessions in about 24 calls
instead of 216. Set-up and checks: deploy/vps/README.md, "RPC". `rpc: N calls/min …` in the log, once a minute per
URL, shows the traffic and the 429s.
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
| Holder pair | Setup → Holder perks | `setHolderPerks(nft, holderBurnBps, holderVaultBps)` | used when it totals less than the normal pair; the owner's pair 800 + 200 (holders pay 10 % instead of 20 %) |
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

1. **Server.** On the VPS nothing is needed for the chain (`ELYMUM_CHAIN_ID` defaults to 46630 and `ELYMUM_RPC_URLS` to the public `https://rpc.testnet.chain.robinhood.com`;
   a provider such as Alchemy is better for production), then set `SERVER_PRIVATE_KEY=auto`, `ADMIN_WALLETS` and
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
   the four arenas (1,000 / 3,000 / 5,000 / 10,000: the $1 / $3 / $5 / $10 tiers at the reference price of $0.001 a
   token), the holder perks (8 % + 2 %), the Isles of the Blessed ($10) holders-only, the emblem as the faucet's 2x, and on the testnet open the mint to the public. The server picks the
   token up within 30 s and the lobby opens the arenas without a reload.
6. **Burn mode** (optional on the testnet): Game → the arena contract → Advanced → Fees: the probe shows the
   TestToken's working `burn()`; preview mode 1 if you want `totalSupply` to fall.
7. **Arena prices** (Game → Arena prices): set the token's USD price, save, then sync and sign (below).
8. **Check**: Launch shows every line green; buy a ticket in the Play tab, play a round, see the receipt (fee on
   profit), buy a power-up pack.

The same can be scripted with the CLI (`pnpm admin help`: `deploy-test-token`, `deploy-arena`, `deploy-nft`, `set-token`, `create-arena`, `fee`,
`burn-mode`, `payment-burn`, `holder-perks`, `status`) and a key file.

## First deploy checklist (the ELYMUM_* keys)

The VPS deploys `main` by itself (deploy/vps/update.sh). The first deploy of the server/ops release needs no change in
`/opt/elymum/.env`: every new key is optional, and `docker-compose.yml` fills in the live values. Check, in order:

1. **Nothing to add.** Unset `ELYMUM_CHAIN_ID`, `ELYMUM_RPC_URLS`, `ELYMUM_RPC_MAX_RPS` and `ELYMUM_GAME_ACCESS` mean
   46630, `https://rpc.testnet.chain.robinhood.com`, 4 calls a second and `public`: the chain, contracts and open game
   of today.
2. **Stale keys are harmless.** `CHAIN_ID`, `EVM_RPC_URL`, `EVM_RPC_URLS`, `RPC_MAX_RPS`, `GAME_ACCESS`, `WEB_DIST`
   and the Elysium-era `PUBLIC_RPC_URL`, `EXPLORER_URL`, `ARENA_ADDRESS`, `NFT_ADDRESS`, `TOKEN_ADDRESS`,
   `TESTNET_RPC_URL`, `JOURNAL_ABANDON_CONTRACT` in `.env` are always overridden. Delete them when convenient, so the
   file says what runs. If you tuned `RPC_MAX_RPS` there, copy it to `ELYMUM_RPC_MAX_RPS`.
3. **`AUTH_SECRET`.** Under 32 bytes the testnet server only warns (`!!! AUTH_SECRET is …`); the mainnet refuses to
   start. Replace it with `openssl rand -hex 32` before the mainnet, or leave it empty for the generated one (every
   session then has to sign in again once).
4. **Sign in to `/admin` again.** Admin sessions are now 2 hours and the earlier long tokens are refused on admin
   routes (`admin_session_expired`); players keep theirs.
5. **After the deploy:** `elymum-compose config | grep -E 'CHAIN_ID|EVM_RPC|GAME_ACCESS'` shows `46630`, the testnet
   RPC and `public`; `elymum-status` shows `/api/health`; `/admin` → Network shows the chain, the server key's gas
   runway and the same contracts.
6. **Logs move to journald.** `elymum-compose logs app` keeps working; `journalctl CONTAINER_NAME=elymum-app-1` too.

Optional keys (all have defaults): `ELYMUM_CHAIN_ID`, `ELYMUM_RPC_URLS`, `ELYMUM_RPC_MAX_RPS`, `ELYMUM_GAME_ACCESS`,
`ELYMUM_WEB_DIST` (leave unset), `ELYMUM_REQUIRE_CI` (off: without the CI marker the branch head deploys as before),
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `BACKUP_RCLONE_REMOTE`, `BACKUP_RCLONE_KEEP_DAYS`, `ADMIN_TOKEN_TTL_MIN`
(120), `ADMIN_SECRET_EXPORT` (on on testnet, off on mainnet), `DEATH_SETTLE_BATCH_S` (6), `GAS_FLOOR_ETH` (0.002),
`GAS_RUNWAY_WARN_DAYS` (7), `GAS_RUNWAY_CRITICAL_DAYS` (2), `HEALTH_MAX_PENDING` (400), `HEALTH_MAX_PENDING_AGE_S`
(900). Required as before: `GAME_DOMAIN`, `NODE_ENV=production`, `PUBLIC_URL`, `CORS_ORIGIN`, `ADMIN_WALLETS`.

## Moving to Robinhood Chain (mainnet)

The testnet and the mainnet are two networks of the same chain; the server follows `CHAIN_ID`.

1. Deploy the game token on Pons (mainnet only; RESEARCH.md), then in `/opt/elymum/.env` set `ELYMUM_CHAIN_ID=4663`
   and `ELYMUM_RPC_URLS` to the Alchemy mainnet URL and the public RPC (section "RPC"), an `AUTH_SECRET` of at least 32 bytes
   (the mainnet refuses less), keep `SERVER_PRIVATE_KEY` or rotate it, fund the server key with ETH, and restart.
   Integrity auto-hold is on by default there, and the secret exports are off (`ADMIN_SECRET_EXPORT`). The server opens a clean state in `DATA_DIR/chains/4663/`; the testnet's records stay in
   `chains/46630/` (the Network tab lists them).
2. Deploy ElymumArena v3 and ElymumNFT from `/admin` (no TestToken on mainnet), set the token, create the arenas,
   set the holder perks, publish the allowlist root, Sync to $1, then price the arenas in US dollars (set the token
   price → sync → sign, "Arena prices in US dollars"). Keep burn mode 0 until the probe shows the token's
   `burn()` works.
3. "Import testnet emblem holders" (Mint tab) reads the testnet NFT through `TESTNET_RPC_URL` (default the public
   testnet RPC) and adds its holders to the mainnet allowlist.
4. On mainnet a red MAINNET banner stays at the top of `/admin` and `JOURNAL_ABANDON_CONTRACT` is refused.

## Arena prices in US dollars

The tiers are priced in dollars ($1 / $3 / $5 / $10, the $10 arena holders-only; ECONOMY.md section 1); the chain
keeps entry fees in token units. `/admin` → Game → **Arena prices (USD)** (`GET` / `PUT /api/admin/arena-prices`,
stored per chain in `DATA_DIR/chains/<id>/arena-prices.json`; the lobby reads `GET /api/site/arena-prices`):

| Setting | Default | Notes |
|---|---|---|
| Price source | manual | the admin's price per token; "Pons TWAP" is shown but not wired (refused) |
| Token price (USD per whole token) | not set | a plain decimal, at most 18 decimals ("0.00081"); stamped with the time it was set |
| Tiers | #1 $1, #2 $3, #3 $5, #4 $10 holders-only | whole cents; holders-only per tier |
| Rounding | 2 significant figures | 1 to 6 |

**Owner steps** (with the owner wallet connected and signed in):

1. **Set the price.** Type the token's USD price, **Save arena prices**. Nothing on chain changes yet; the lobby now
   shows each ticket's dollar value ("≈ $0.81" while an arena is not at its tier price).
2. **Sync.** The **Sync arena prices to USD** table shows, per tier, the entry now and the new entry in tokens and
   USD, and what changes (`updateArena`, holders-only on / off). An arena with open tickets is marked: the contract
   changes an entry fee only while none of that arena's tickets is open (`ArenaBusy`). To re-price a busy arena use
   **Re-price at next bell** (`POST /api/admin/reprice {"arenaIds":[2]}`; `GET` shows where each arena is): joins
   close at the round's last minute (as every round), the bell settles every coin, the break does not reopen the
   arena, its unseated tickets are cancelled at once with their full entry fee (a closed, disabled or paused arena's
   unseated tickets no longer wait out the 15-minute limit), and once nothing of it is open on chain, in the journal
   or in a room the arena shows **ready to sign** (the log says `reprice: arena #N is READY TO SIGN`). Sign
   now; when the chain shows the new entry fee the arena opens again by itself (`{"arenaIds":[2],"cancel":true}`
   opens it without a re-price). Measured on the mainnet money simulation: an arena is closed about one round
   (5 minutes) per re-price instead of eight (40 minutes). Max open tickets and the enabled state are kept.
3. **Sign.** **Sign N changes with the owner wallet**: one wallet prompt per call, in order (`updateArena(id,
   newEntry, maxSessions, enabled)` per re-priced arena, `setArenaHoldersOnly(id, on)` where a tier's holders-only flag
   differs). The table re-reads the chain afterwards and shows "in sync". Then unpause (or reopen the arena).

Tickets already bought keep the entry fee they were bought with, whatever the sync does (ECONOMY.md section 1). The
running rooms of a re-priced arena take the new price for their own figures at the next arena read (within a
minute; the log says `arena #N: ticket price … on chain`). Re-sync whenever the token's price moves enough to matter;
`dex_twap` (a Pons / DEX TWAP) will replace the manual price once it is wired.

**The holder pair** (holders pay 10 % of their profit): Setup → Holder perks → `setHolderPerks(<ElymumNFT>, 800, 200)`
(Finish setup does it on a fresh deploy). An arena deployed earlier with the old suggestion (1,500 + 0) needs this
call once; tickets bought before it keep the pair they joined with.

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
the seats of all live rooms together, the holder perk (default: one free room of up to 10 players a day per holder,
UTC day, kept in `site/custom-rooms.json` across restarts; or a discount, or none), the live rooms (close one: a free room ends after a 10 s
countdown and its final board, a ticket room at its bell). **Practice with bots** on / off and "practice rooms at
once" (`practiceMaxLive`, default 12, 0..50): the free one-click rooms the quiet ponds offer (8 bots, 15 minutes, one
per player, 4 per IP per 30 minutes, closed after 2 minutes empty). They take none of the paid rooms' slots or seats;
each costs about 8 bots of CPU, so 12 at once is about 100 practice bots.

## Test arenas with bots (testnet)

On the testnet every official arena (ticket tier) gets one extra instance, **Test · <arena>** (`test-<arenaId>`):
the same arena, the same ElymumArena contract and vault, real tickets, rounds, bell, settlement with the fee on
profit, loot burns, journal and crash recovery as the official instances, plus practice bots so the whole system can
be tested with few people. Bots never buy a ticket and carry no value: eating one gives mass, never tokens; a bot
that eats a player makes the eaten value spill as loot (burned at the bell if nobody picks it up). A ticket is the
arena's normal ticket: the same on-chain session can be played in an official instance or in the test arena (one
seat at a time).

- **Lobby:** listed after the official arenas under "Test arenas · testnet", each with a TEST badge and the line
  "testnet test room with bots; same tickets and payouts". Quick play never goes there. Who may play follows the
  normal game access rule (`gameAccess` / `GAME_ACCESS`): admins during maintenance, everyone when the game is open.
- **Boards:** test-arena games count nowhere official: no leaderboard record, country game or "Last rounds" entry,
  no profile stats (XP, games, best), no Share on X card.
- **Admin:** `/admin` → Game → **Test arenas (testnet)** (`GET` / `PUT /api/admin/test-arenas`, stored in
  `DATA_DIR/site/test-arenas.json`): "Test arenas with bots" on / off (default on), bots per test arena (3..20,
  default 10), difficulty (easy / mixed / hard, default mixed), and every test arena live (people, bots, open or
  closing, its worker). New settings apply at once: more bots arrive one by one, extra bots leave, the difficulty
  applies to bots that arrive from then on. Turned off, no test arena takes a new seat and each closes once its bell
  settled every ticket in it.
- **Mainnet:** impossible. With `CHAIN_ID=4663` (or an RPC that serves the mainnet) no test arena opens, `PUT` answers
  409 and the card says test arenas exist on a testnet only; a `test-arenas.json` left from the testnet is ignored.

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
on the same vault. The testnet's test arenas (`test-<id>`) are not scaled: one fixed instance per arena while they
are on. The scaler (`apps/server/src/rooms/arena-scaler.ts`, rules in
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

## Abuse and DDoS

| Layer | Limit |
|---|---|
| Cloudflare (recommended, deploy/vps/README.md "Cloudflare in front") | volumetric floods, bad bots at the edge; WebSockets pass |
| Caddy | headers in 10 s, bodies in 30 s and at most 1 MB, headers at most 16 KB, idle keep-alive 2 min |
| WebSocket front door | `MAX_CONNECTIONS` (1500); guests (not signed in) at most 80 % of it, per IP (8) and per IPv4 /24 or IPv6 /64 (48); a signed-in socket leaves its IP's guest count (carrier NAT), up to 64 per IP; a socket offering its session token (`elymum.auth.<token>` subprotocol) takes the reserve, and a wallet with a live arena coin always gets in (5 % headroom, past the load shedder); near the cap the longest-idle lobby guest (30 s silent) is closed (1013) for a newcomer; 60 upgrades per IP a minute; a socket without a valid `hello` in 10 s is closed; 90 messages/s per socket (bursts of 120), a socket that floods or sends garbage (300 strikes in 10 s) is closed with 1008; at most 4 KB per message; sign-ins and ticket reads 1 per 2 s |
| HTTP | 240 API requests per IP a minute, 20 sign-in nonces per IP a minute (at most 24 unused per IP and 4 per address; a full pool evicts the biggest holder's first), headers in 15 s, the whole request in 30 s, 64 KiB bodies, `/api/rooms` and `/api/leaderboard` built at most once a second, 30 share-card renders per IP and 120 in all a minute |
| Load shedding (`LOAD_SHED`, on in production) | when the game thread with the most headroom runs a tick p95 over 28 ms or the main thread lags over 150 ms (p99): new free games wait (`server_full`); over 45 ms / 400 ms: new sockets (503) and new arena seats wait too (the ticket stays on chain). Live games and reconnects always go on. Logged as `!!! load: BUSY` / `CRITICAL` |

The per-IP limits need the real client address: Caddy hands it on (one hop), and the website must call the game
server directly (`VITE_SERVER_URL`): `vercel.json` proxies only `/api/nft/*` and `/share/*`.

`node --import tsx scripts/bench/flood.ts` (in `apps/server`) plays 60 people and runs four attacks from thousands of
spoofed addresses (idle sockets, a message flood, an HTTP flood, slowloris) and prints what the players saw.

## Pausing and emergencies

| What | How | Effect |
|---|---|---|
| Stop new tickets | Arena → **Pause** (`setPaused(true)`; CLI `pnpm admin pause`) | `join` is refused; **settlements, refunds and collects go on**; unseated tickets are cancelled at once (full entry fee back). Undo with Unpause |
| Close one arena | Arena → disable it (`updateArena(..., enabled=false)`) | no new tickets there; seated ones are played and settle, unseated ones are cancelled at once (full entry fee back) |
| Close the arenas on the server | `STAKE_ENABLED=false`, restart | the arenas leave the lobby; the settlement queue keeps running |
| Close the game to players | Settings → who may play: `admins` | everyone else sees the gate; tickets already bought can still be refunded after 24 h |
| Close the mint | Mint → phase **Closed** | no mints; nothing else changes |
| Change the fees | Game → the arena contract → Fees (`setFeeRates`, at most 2,500 bps together) | applies to tickets bought from now on; open tickets keep their rates |

On `SIGTERM` the server settles the players in the arenas at their current value (an operator exit) and saves its
state; Docker `stop` sends it. That is why deploys (`update.sh`) and the update reboots (`reboot.sh`) wait for the
break after an arena bell, when no coin is live.

**Reconnects.** A player whose network switched comes back on a new socket while the old one still looks open: a
join of the same signed-in wallet takes the live coin over at once, and the old socket is closed with
`CLOSE_REPLACED` (4000) so it does not reconnect. Another wallet can never take a coin (it has no ticket there).

**Deploys** go out only for commits CI passed (the `ci-green-<branch>` tag), in the round break, and roll back by
themselves when the new container is not healthy within 60 s (deploy/vps/README.md, "Deploys"). If the VPS dies:
deploy/vps/README.md, "Moving to another VPS, or the VPS died".

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
| `chains/<id>/settled.jsonl` | every confirmed settlement, cancel and loot burn of the last 14 days | reorg protection and the payout record start empty |
| `admin-audit.jsonl` | every admin write (who, what, when, from where) and every request of the secret exports | the audit trail is gone |
| `chains/<id>/emblem-claims.json`, `reprice.json`, `auth-revoked.json` | the token ids open holder tickets hold, the arenas closing for a re-price, revoked sessions | an emblem may serve one extra ticket; a re-price is asked again; revoked sessions come back until they expire |

- The journal is written to a temporary file and renamed, so the file on disk is always a complete snapshot. Copy
  `DATA_DIR` regularly and keep the copies encrypted (they hold a private key and wallet addresses): on the VPS the
  daily backup and, with `BACKUP_RCLONE_REMOTE`, an rclone crypt copy offsite (deploy/vps/README.md, "Backups").
- **A full disk.** While the journal cannot be written the server sends no settlement (one sent from memory, an eaten
  ticket at 0 whose eater's gain never reached the disk, would leave the eater short after a crash: that is where the
  full-disk drill's 16,000 tokens stayed in the vault), takes no new arena seat (`server_full` with "the server
  cannot save right now") and the lobby stops selling tickets; live coins play on. It all resumes by itself once a
  write succeeds; `/api/health` and the alert job say it at once.
- An unreadable journal is moved aside as `journal.json.corrupt-<time>` with a `!!!` log, and the stale sweeper stays
  off until you inspect it and restart with `STALE_SWEEP_ACK=1` (or move the file away).
- **The journal is bound to one arena contract.** While it owes money (pending settlements, live tickets, floor loot)
  on an arena, the server refuses to switch to another arena contract: `POST /api/admin/contracts` answers 409
  `wrong_state`. Let the rounds settle first, or start the new arena on a fresh `DATA_DIR`.
- Never run two servers on the same `DATA_DIR` or the same server key.
