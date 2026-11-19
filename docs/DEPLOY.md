# Coinnibal: setup and deployment (Robinhood Chain Testnet → Robinhood Chain)

This is the whole path from an empty host to a running game with an open mint. The server goes up first;
then the owner deploys both contracts **from their own wallet in `/admin`** and the server registers them.
Nothing here needs a terminal on the chain side: the CLI (`pnpm admin`, at the end) is an alternative.

The game server runs on a VPS (Docker + Caddy, CI-green auto-deploy with rollback, alerts, daily and offsite
backups, one-command install): [deploy/vps/README.md](../deploy/vps/README.md). The backup of the whole data folder
(`GET /api/admin/backup`) needs a fresh signature of the admin wallet each time, and is off on the mainnet unless
`ADMIN_SECRET_EXPORT=1` (OPERATIONS.md, "Journal and data backup").

Day-to-day running: [OPERATIONS.md](OPERATIONS.md) (with the step-by-step testnet deploy). How the money moves:
[ARCHITECTURE.md](ARCHITECTURE.md). The economy: [ECONOMY.md](ECONOMY.md). Chain facts: [RESEARCH.md](RESEARCH.md).
(The specs under `docs/specs/` are historical: they describe the earlier Elysium build.)

## The order

1. **Server** on the VPS (deploy/vps/README.md), `SERVER_PRIVATE_KEY=auto`, `ADMIN_WALLETS` = your owner wallet,
   `CHAIN_ID=46630` and `EVM_RPC_URLS` = Robinhood Chain Testnet (later `4663` and Alchemy plus the public RPC; on the
   VPS these are `COINNIBAL_CHAIN_ID` and `COINNIBAL_RPC_URLS`, and unset they already mean the testnet).
2. **Fund the server key** with a little ETH (it pays gas for settlements, cancels and loot burns).
3. In `/admin` on the site, with the owner wallet on Robinhood Chain: **Deploy Arena → Deploy NFT → register both**
   (on the testnet also the TestToken).
4. **WL**: review applications in `/admin` → Community (WL, Collabs) → **publish the allowlist root**.
5. **Open the mint**: phase Allowlist, later Public (on the testnet, Finish setup, step 7, opens it to the public).
   Leave "activate the game for holders" unchecked (the default): the game opens last, at step 8, once the token
   and the rooms are set. The visitor site says the public mint will be on OpenSea; how
   that sale and this contract's phases fit together is an open owner decision.
6. Keep the mint at its USD target (`MINT_USD_CENTS`) in ETH: the Sync button, or let the server's price keeper do it
   within your bounds.
7. **Set the game token** on the arena when the token exists (once and for good; the launch order is the NFT mint,
   then the token, then the game), then **create the four arenas**. On testnet you can deploy the `TestToken` first
   and use it (Finish setup does the token, the arenas and the perks in one go).
8. **Open the game** (`/admin` → Game → Who may play): it starts closed (`admins`).

`/admin` → **Network** shows the launch checklist live: a line that is not done links to the drawer that finishes it
(the chain and the server key's gas are fixed on Network itself and on the server).

## 0. Robinhood Chain

Coinnibal runs on Robinhood Chain only (an Arbitrum Orbit L2, gas in ETH). Sources and the status of each value:
[RESEARCH.md](RESEARCH.md).

| | Robinhood Chain Testnet | Robinhood Chain |
|---|---|---|
| `CHAIN_ID` | `46630` (the default) | `4663` |
| Public RPC | `https://rpc.testnet.chain.robinhood.com` | `https://rpc.mainnet.chain.robinhood.com` (rate-limited: use a provider such as Alchemy, `https://robinhood-mainnet.g.alchemy.com/v2/<key>`) |
| Explorer (built in) | `https://explorer.testnet.chain.robinhood.com` | `https://robinhoodchain.blockscout.com` |
| Gas token | ETH (18 decimals) | ETH |
| Faucet | `https://faucet.testnet.chain.robinhood.com` (the official faucet, confirmed on docs.robinhood.com/chain/connecting; Alchemy's also works) | none: bridge ETH with the Arbitrum portal |

The server's RPC must serve `CHAIN_ID`: an RPC of another chain keeps the arenas off, and any other `CHAIN_ID`
refuses to start. The web asks the wallet to switch to (or add) exactly the chain the server reports, so moving
from testnet to mainnet is a server setting, not a rebuild.

**Wallets.** Any EVM browser wallet that announces itself with EIP-6963 (MetaMask, Rabby, Coinbase Wallet, OKX,
...). The owner wallet is the one you will keep: it owns the contracts. A hardware wallet behind MetaMask or
Rabby works. Get testnet ETH for it (and later for the server key) from the faucet.

## 1. The server

One Docker container runs the game server (`Dockerfile` at the repository root, image `elymum-app`, a name of the live
server kept from before the rename) behind Caddy on the VPS: deploy/vps/README.md installs it, keeps it up to date and
backs it up. The same container serves the website (`https://coinnibal.fun`, `SITE_DOMAIN`, `WEB_DIST=/app/web`);
`elymum.io`, the domain of before the rename, redirects every path to it (vercel.json). The settings
(`/opt/elymum/.env`; on the VPS the chain, RPC and access keys are the namespaced `COINNIBAL_*` ones, which
`docker-compose.yml` maps to the server's names and which a stale older `.env` cannot hold; their `ELYMUM_*` names of
before the rename still work: deploy/vps/README.md section 4):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_URL` (VPS: `SITE_DOMAIN` or `COINNIBAL_PUBLIC_URL`) | **required**: the site's address, `https://coinnibal.fun` (the SIWE domain and the base of the NFT metadata URLs). The server refuses to start without it unless `NODE_ENV=development`; it never derives the sign-in domain from `Host` / `X-Forwarded-Host`. On the VPS, `docker-compose.yml` sets it to `https://<SITE_DOMAIN>` (default `coinnibal.fun`) unless `COINNIBAL_PUBLIC_URL` is set, and ignores a `PUBLIC_URL` in `.env` (install.sh only checks that line is not empty) |
| `CHAIN_ID` (VPS: `COINNIBAL_CHAIN_ID`) | `46630` (Robinhood Chain Testnet, the default), later `4663` (Robinhood Chain) |
| `EVM_RPC_URLS` (VPS: `COINNIBAL_RPC_URLS`) | the server's RPCs in order: on the mainnet the Alchemy URL, then `https://rpc.mainnet.chain.robinhood.com` (a fallback; may hold an API key; never sent to browsers). Off the VPS, `EVM_RPC_URL` (one URL) still works; an empty one is unset |
| `RPC_MAX_RPS` (VPS: `COINNIBAL_RPC_MAX_RPS`) | calls per second per URL (`25,4`; default 4) |
| `PUBLIC_RPC_URL` | optional: an RPC for browsers, no secrets (default: the public Robinhood Chain RPC of the list, else the wallet's own RPC) |
| `EXPLORER_URL`, `GAS_FAUCET_URL` | optional overrides of the built-in explorer and testnet faucet link |
| `SERVER_PRIVATE_KEY` | `auto`: generated once into `/data/server-key.json` (mode 0600) and reused; its address is logged and published as `serverKey` |
| `ADMIN_WALLETS` | your owner wallet's 0x address (comma-separated for more). **No default**: unset, nobody is admin |
| `AUTH_SECRET` | `openssl rand -hex 32` (at least 32 bytes: the mainnet refuses to start with less), or empty for a generated one in the data volume |
| `CORS_ORIGIN` | `https://coinnibal.fun` |
| `PAYOUT_GUARD_MULTIPLE` | `100` (default): the payout guard of settlements without a round pool; see OPERATIONS.md, "The server key" |
| `MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_IP`, `MAX_CONNECTIONS_PER_SUBNET` | `1500`, `8`, `48` (defaults): WebSocket caps (total, guests per IP, guests per IPv4 /24 or IPv6 /64) |
| `GAME_WORKERS` | `5` on 8 vCPU |
| `LOAD_SHED` | on by default in production: new free games, then new sockets and arena seats wait while the server is overloaded |
| `MINT_USD_CENTS` | the mint's USD target in US cents (default `100`; an owner setting). No visitor page shows it, and `GET /api/site/mint` leaves it out while the mint page is closed (Settings → Mint page open); the admin panel always reads it |
| `NFT_COLLECTION_SIZE`, `NFT_ART_STYLE` | `3333` (= the NFT's max supply), `vector` (or `pixel`): the emblem collection (docs/NFT-DESIGN.md). Leave `NFT_COLLECTION_SEED` empty: the seed is generated and committed on first boot (`DATA_DIR/chains/<id>/nft-collection.json`, keep it in the backups) |
| `TOKEN_SYMBOL` | unset: amounts say `tokens` (display only) |
| `X_HANDLE` | the project's X handle by default (unset: `coinnibalfun`) |
| `GAME_ACCESS` (VPS: `COINNIBAL_GAME_ACCESS`) | unset (VPS: `site`): the `/admin` → Settings switch decides (a fresh server starts closed, `admins`); `public`, `holders`, `admins` or `maintenance` overrides that switch |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `BACKUP_RCLONE_REMOTE` | the alerts and the encrypted offsite backup (deploy/vps/README.md) |

Leave `ARENA_ADDRESS` and `NFT_ADDRESS` empty: the addresses come from the registry `/admin` writes. Never set
`DEV_FAKE_CHAIN` on a deployed server. The full list with comments: `apps/server/.env.example`.

The log shows `chain: ...` with the chain id, the RPCs and the server key address; `GET /api/config` shows the
same (`chain.serverKey`). `GET /api/health` answers 503 with its reasons when something needs a person
(OPERATIONS.md, "Monitoring"); `/api/health?live=1` is the container's liveness check. Deploys swap the container in
the break after an arena bell (no live stake then).

**Domain.** The site is wherever `PUBLIC_URL` says (`https://coinnibal.fun`; on the VPS `https://<SITE_DOMAIN>`; the
web build's `VITE_PUBLIC_URL`). Nothing in the code or the art names a domain; another domain is configuration only
(OPERATIONS.md, "The name: Coinnibal (formerly Elymum)"). Players sign in again on a new domain (SIWE binds the domain). NFT metadata URLs follow the NFT's base URI:
update it with `setBaseURI` (Mint tab) unless you froze it.

**Without Docker.** `pnpm install && pnpm -F @coinnibal/web build && pnpm -F @coinnibal/server build`, then run
`node apps/server/dist/index.js` with the variables above and `WEB_DIST=apps/web/dist`. The server does not read a
`.env` file itself: pass the variables through the environment.

## 2. Fund the server key

Send a little ETH to the `serverKey` address (on testnet from the faucet). It pays gas for the settlement
batches at each bell, the cancels of unplayed tickets and the loot burns; on an L2 that is cheap (an L2 execution
fee plus an L1 data fee), but keep a buffer. The server measures its spend over the last day: under 7 days of runway
it warns, under 2 days (or under 0.002 ETH) it alerts with `!!!`, `/api/health` answers 503 and `/admin` shows it in
red (OPERATIONS.md, "The server key and gas").

## 3. Deploy the contracts from `/admin`

Open `https://<your site>/admin`. Connect the **owner wallet** (the one in `ADMIN_WALLETS`), press **Sign in**
(a free SIWE signature, no transaction). The header shows a TESTNET or a red **MAINNET** pill. Every transaction
opens a preview (function, arguments, value, network, signer) before the wallet prompt, and a double click cannot
send twice. Open **Setup**; the wizard walks the steps and remembers where you are:

1. **Connect the owner wallet.** This wallet becomes the owner of both contracts. Every contract is a plain
   creation from the connected wallet (no factory, proxy or CREATE2 deployer), so the explorer shows your wallet as
   the deployer; the preview refuses a deploy whose owner is not the wallet signing it (a wallet switched after the
   preview).
2. **Check the chain.** The wallet must be on the chain the server reports; the panel asks the wallet to switch
   (or to add the chain) and blocks signing otherwise.
3. **Deploy CoinnibalArena (v3).** Constructor: admin = you, server authority = the server key (prefilled from
   `/api/config`), fee wallet = you (change it if you like; it receives the fee wallet's 5 % of every profit and
   half of every power-up payment). Defaults: 15 % of profit burned + 5 % to the fee wallet, burn mode 0
   (`0x…dEaD`), power-ups 50 % burned.
4. **Deploy CoinnibalNFT.** Defaults: max supply 3,333 (`NFT_SUPPLY`, the owner's fixed supply), price = the USD
   target `MINT_USD_CENTS` in ETH at today's ETH/USD, 1 allowlist and 2
   public mints per wallet, base URI `${PUBLIC_URL}/api/nft/`, treasury = you. Everything except the base URI
   once frozen can be changed later.
5. **Register both with the server.** `POST /api/admin/contracts` for each: the server checks that the code hash is
   the bundled one, that the owner is you and that the arena's server authority is its key, then stores the
   addresses in `/data/chains/<chainId>/contracts.json`. The server picks the arena up without a restart.
6. **Set the game token** (later, when the game token exists). On a testnet, confirm the registered TestToken once
   in the preview (Finish setup does it). The real game token cannot be registered with the server before the arena
   uses it (`POST /api/admin/contracts` accepts only the TestToken or the arena's own token), so on the mainnet enter
   it under **Advanced** in the game token card and type it twice. `TOKEN_ADDRESS` names it only on a server outside
   Docker: the VPS compose file sets it empty. It can be set **once**: a wrong address means deploying a new arena.
   Until it is set the arenas show "Opening soon" and only practice runs.
7. **Create the four arenas** (needs the token): the $1 / $3 / $5 / $10 tiers, created at 1,000 / 3,000 / 5,000 /
   10,000 tokens (the reference price $0.001 a token), 300 open tickets each; the $10 Room is for NFT holders.
   Then price them at the token's real USD price: Game → Arena prices → set the price, sync, sign (OPERATIONS.md,
   "Arena prices in US dollars"). The lobby opens them within about a minute.

**The testnet token.** On Robinhood Chain Testnet the wizard offers **Deploy TestToken** (an ERC20Burnable faucet
token: `faucet()` gives by default 1,000,000 per hour, 2x for NFT holders; only its owner mints). **Finish setup** sets it as
the arena's token, creates the four rooms, sets the holder perks (8 % + 2 %), makes the $10 Room holders-only, makes the
NFT the faucet's 2x and, on a testnet, calls `CoinnibalNFT.setPhase(public)`: the TEST mint opens to everyone. The
game token itself will be launched on Pons, which exists on mainnet only (RESEARCH.md), after the NFT mint. Remember
the token is final for an arena deployment.

## 4. The allowlist and the mint

1. **WL**: approve or reject applications in `/admin` → **WL**; approve communities and collect their wallet lists in
   **Collabs**. Wallets are EVM addresses (0x…); anything else is refused.
2. **Publish the allowlist root** (Mint tab): the server builds a snapshot of every approved WL wallet plus every
   wallet in a submitted collab list (checksummed, de-duplicated, sorted) and its Merkle root; you sign
   `setMerkleRoot`. The panel warns when approvals changed since the published root: publish again.
3. **Set the price to its USD target** (Mint → Sync; `MINT_USD_CENTS`): it reads ETH/USD and asks your wallet to
   call `setPrice`.
4. **Open the mint**: Mint → phase **Allowlist**. Leave "Activate the game for holders" unchecked (the default):
   ticked, it would also set who may play to `holders` (NFT holders plus admins) at mint time, but the game opens
   last, once the game token and the rooms are set (Game → Who may play; section 5). Later switch the phase to
   **Public**.
5. **Keep it at the target** (see OPERATIONS): press Sync now and then, or set the price bounds and make the server key the
   price keeper; the server then re-prices every 5 minutes when the price drifts more than 2 %, always inside your
   bounds.

## 5. Mainnet (Robinhood Chain)

The launch order is the NFT mint first, then the token, then the game.

1. Do the whole flow on Robinhood Chain Testnet first, including tickets, rounds, power-ups and the burn mode probe.
2. Set `COINNIBAL_CHAIN_ID=4663` and `COINNIBAL_RPC_URLS` (a provider RPC first; it may contain a key) in `/opt/elymum/.env`, optionally
   `PUBLIC_RPC_URL` (secret-free). Redeploy. The server opens a clean state for chain 4663; the testnet's records stay
   in `/data/chains/46630/`.
3. **New contracts.** Testnet addresses are not mainnet addresses. Fund the server key with ETH, redo section 3 on
   mainnet (the red MAINNET banner shows): deploy Arena and NFT, register, publish the root, sync the price, open the
   mint (section 4).
4. **The token.** Launch the game token on Pons (mainnet only), then set it on the arena, create the arenas and the
   holder perks, price the arenas and open the game. Keep burn mode 0 unless the probe shows the token's `burn()`
   works.
5. Start with small arenas; watch `/admin` → Network (the launch checklist) and the server log (`!!!` lines).

## The admin CLI (alternative)

Everything the panel does on chain is also in the CLI (Node, a key file or env key):

```bash
export EVM_RPC_URL=https://rpc.testnet.chain.robinhood.com
export ADMIN_PRIVATE_KEY=/path/to/owner.key     # 0x hex, or a file holding it
pnpm admin status
pnpm admin deploy-test-token                    # testnet only
pnpm admin deploy-arena --server <serverKey>
pnpm admin deploy-nft --max-supply 3333 --usd-cents 100 --base-uri https://<site>/api/nft/
pnpm admin set-token --token <addr> --confirm <addr>
pnpm admin create-arena --defaults
pnpm admin nft:root --file allowlist.txt && pnpm admin nft:phase allowlist
pnpm admin help
```

The CLI refuses an RPC of any chain but Robinhood Chain, previews and simulates every transaction, `--dry-run`
stops after the preview, and Robinhood Chain mainnet needs
`--mainnet` plus typing "mainnet". Contracts deployed with the CLI still have to be registered with the server: use
`/admin` (Setup → Advanced: manual controls → Register a contract that is already deployed), or, on a server outside
Docker only, set `ARENA_ADDRESS` / `NFT_ADDRESS` (the VPS compose file clears them).

## Local development

- `pnpm demo`: a fake chain, nothing to deploy.
- `pnpm demo:localnet`: `hardhat node` (chain 31337, a local stand-in for Robinhood Chain Testnet) + the
  contracts deployed with the SDK + the production server
  (`scripts/localnet.mjs`, `scripts/localnet-fund.mjs`; addresses in `.localnet/contracts.json`).
- `pnpm -F @coinnibal/server e2e`: the deploy order above, end to end against a fresh hardhat node.
