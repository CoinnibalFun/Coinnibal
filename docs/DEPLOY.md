# Elymum: setup and deployment (Robinhood Chain Testnet → Robinhood Chain)

This is the whole path from an empty host to a running game with an open mint. The server goes up first;
then the owner deploys both contracts **from their own wallet in `/admin`** and the server registers them.
Nothing here needs a terminal on the chain side: the CLI (`pnpm admin`, at the end) is an alternative.

Moving the game server to your own VPS (Docker + Caddy, auto-deploy, daily backups, one-command install):
[deploy/vps/README.md](../deploy/vps/README.md). `/admin` → Network → **Backup & move** downloads the server's
whole data folder (`GET /api/admin/backup`, admin only).

Day-to-day running: [OPERATIONS.md](OPERATIONS.md) (with the step-by-step testnet deploy). How the money moves:
[ARCHITECTURE.md](ARCHITECTURE.md). The economy: [ECONOMY.md](ECONOMY.md). Chain facts: [RESEARCH.md](RESEARCH.md).
(The specs under `docs/specs/` are historical: they describe the earlier Elysium build.)

## The order

1. **Server** on a host with a persistent disk (Render below), `SERVER_PRIVATE_KEY=auto`, `ADMIN_WALLETS` = your
   owner wallet, `CHAIN_ID=46630` and `EVM_RPC_URL` = Robinhood Chain Testnet (later `4663` and a mainnet RPC).
2. **Fund the server key** with a little ETH (it pays gas for settlements, cancels and loot burns).
3. In `/admin` on the site, with the owner wallet on Robinhood Chain: **Deploy Arena → Deploy NFT → register both**
   (on the testnet also the TestToken).
4. **Set the `$ELYMUM` token** on the arena when the token exists (once and for good), then **create the four
   arenas**. On testnet you can deploy the `TestToken` first and use it.
5. **WL**: review applications in `/admin` → WL and Collabs → **publish the allowlist root**.
6. **Open the mint**: phase Allowlist (with "activate the game for holders" checked), later Public.
7. Keep the mint at **$1 in ETH**: the Sync button, or let the server's price keeper do it within your bounds.

`/admin` → **Launch** shows this checklist live, each line with a link to the tab that finishes it.

## 0. Robinhood Chain

Elymum runs on Robinhood Chain only (an Arbitrum Orbit L2, gas in ETH). Sources and the status of each value:
[RESEARCH.md](RESEARCH.md).

| | Robinhood Chain Testnet | Robinhood Chain |
|---|---|---|
| `CHAIN_ID` | `46630` (the default) | `4663` |
| Public RPC | `https://rpc.testnet.chain.robinhood.com` | `https://rpc.mainnet.chain.robinhood.com` (rate-limited: use a provider such as Alchemy, `https://robinhood-mainnet.g.alchemy.com/v2/<key>`) |
| Explorer (built in) | `https://explorer.testnet.chain.robinhood.com` | `https://robinhoodchain.blockscout.com` |
| Gas token | ETH (18 decimals) | ETH |
| Faucet | `https://faucet.testnet.chain.robinhood.com` (unconfirmed; Alchemy's faucet also works) | none: bridge ETH with the Arbitrum portal |

The server's RPC must serve `CHAIN_ID`: an RPC of another chain keeps the arenas off, and any other `CHAIN_ID`
refuses to start. The web asks the wallet to switch to (or add) exactly the chain the server reports, so moving
from testnet to mainnet is a server setting, not a rebuild.

**Wallets.** Any EVM browser wallet that announces itself with EIP-6963 (MetaMask, Rabby, Coinbase Wallet, OKX,
...). The owner wallet is the one you will keep: it owns the contracts. A hardware wallet behind MetaMask or
Rabby works. Get testnet ETH for it (and later for the server key) from the faucet.

## 1. The server on Render

One Docker container serves the game server and the web client on the same origin
(`Dockerfile` at the repository root; image name `elymum`).

1. **New → Web Service** from the repository, runtime **Docker** (the root `Dockerfile`), a region near your
   players, a paid plan (the free plan has no disk).
2. **Disk**: mount a persistent disk at **`/data`** (1 to 2 GB is plenty). It holds the money journal, the server
   key, the contracts registry, profiles, standings and the site data. The entrypoint makes it writable for the
   `node` user.
3. **Environment** (Render passes these to the Docker build as well, which `VITE_PUBLIC_URL` needs):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATA_DIR` | `/data` |
| `PUBLIC_URL` | **required**: the site's address, e.g. `https://<your current domain>` (the SIWE domain and the base of the NFT metadata URLs). The server refuses to start without it unless `NODE_ENV=development`; it never derives the sign-in domain from `Host` / `X-Forwarded-Host` |
| `VITE_PUBLIC_URL` | the same value (build time: absolute canonical and Open Graph URLs in `index.html`) |
| `CHAIN_ID` | `46630` (Robinhood Chain Testnet, the default), later `4663` (Robinhood Chain) |
| `EVM_RPC_URL` | `https://rpc.testnet.chain.robinhood.com` (testnet), later a mainnet provider RPC (may hold an API key; never sent to browsers) |
| `PUBLIC_RPC_URL` | optional: an RPC for browsers, no secrets (default: `EVM_RPC_URL` when it is a public Robinhood Chain RPC, else the wallet's own RPC) |
| `EXPLORER_URL`, `GAS_FAUCET_URL` | optional overrides of the built-in explorer and testnet faucet link |
| `SERVER_PRIVATE_KEY` | `auto`: generated once into `/data/server-key.json` (mode 0600) and reused; its address is logged and published as `serverKey` |
| `ADMIN_WALLETS` | your owner wallet's 0x address (comma-separated for more). **No default**: unset, nobody is admin |
| `AUTH_SECRET` | `openssl rand -hex 32` (otherwise players sign in again after each restart) |
| `TRUST_PROXY` | `1` (set by the image already): the client IP is the right-most `X-Forwarded-For` hop; with more than one proxy in front, set `TRUST_PROXY_HOPS` to their number (default 1) |
| `CORS_ORIGIN` | the site's origin(s), comma-separated, when the web is hosted elsewhere (e.g. `https://elymum.io`); `*` when the server serves the web itself |
| `PAYOUT_GUARD_MULTIPLE` | `100` (default): a payout above this many entry fees is held for an admin; see OPERATIONS.md, "The server key" |
| `MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_IP`, `MAX_CONNECTIONS_PER_SUBNET` | `600`, `8`, `48` (defaults): WebSocket caps (total, per IP, per IPv4 /24 or IPv6 /64) |
| `LOAD_SHED` | on by default in production: new free games, then new sockets and arena seats wait while the server is overloaded |
| `MINT_USD_CENTS` | `100` (the $1 target; default) |
| `NFT_COLLECTION_SIZE`, `NFT_ART_STYLE` | `5000` (= the NFT's max supply), `vector` (or `pixel`): the emblem collection (docs/NFT-DESIGN.md). Leave `NFT_COLLECTION_SEED` empty: the seed is generated and committed on first boot (`DATA_DIR/chains/<id>/nft-collection.json`, keep it in the backups) |
| `TOKEN_SYMBOL` | `$ELYMUM` (default; display only) |
| `GAME_ACCESS` | leave empty: the `/admin` setting decides (`public` on the testnet, `admins` on mainnet until you open the mint) |

Leave `ARENA_ADDRESS` and `NFT_ADDRESS` empty: the addresses come from the registry `/admin` writes. Never set
`DEV_FAKE_CHAIN` on a deployed server. The full list with comments: `apps/server/.env.example`.

4. Deploy. The health check is `GET /api/health`. The log shows `chain: ...` with the chain id and the server key
   address; `GET /api/config` shows the same (`chain.serverKey`). A disk-backed service restarts briefly on every
   deploy; the journal keeps every value, but players reconnect, so deploy at quiet hours.

**Domain.** The site is served at whatever `PUBLIC_URL` says, today your current domain. In Render → Settings →
Custom Domains add the domain (and `www`), then point the DNS at Render (`A @` to Render's address, `CNAME www` to
the service's `onrender.com` host); Render issues the certificates. To move to **elymum.io** later: add it in
Render, point its DNS, change `PUBLIC_URL` and `VITE_PUBLIC_URL` to `https://elymum.io` and redeploy. Nothing in
the code or the art names a domain. Players sign in again on the new domain (SIWE binds the domain). NFT metadata
URLs follow the NFT's base URI: update it with `setBaseURI` (Mint tab) unless you froze it.

**Without Docker.** `pnpm install && pnpm -F @elymum/web build && pnpm -F @elymum/server build`, then run
`node apps/server/dist/index.js` with the variables above and `WEB_DIST=apps/web/dist`. The server does not read a
`.env` file itself: pass the variables through the environment.

## 2. Fund the server key

Send a little ETH to the `serverKey` address (on testnet from the faucet). It pays gas for the settlement
batches at each bell, the cancels of unplayed tickets and the loot burns; on an L2 that is cheap (an L2 execution
fee plus an L1 data fee), but keep a buffer. Below 0.01 ETH the server logs a warning and `/admin` shows it in red.

## 3. Deploy the contracts from `/admin`

Open `https://<your site>/admin`. Connect the **owner wallet** (the one in `ADMIN_WALLETS`), press **Sign in**
(a free SIWE signature, no transaction). The header shows a TESTNET or a red **MAINNET** pill. Every transaction
opens a preview (function, arguments, value, network, signer) before the wallet prompt, and a double click cannot
send twice. Open **Setup**; the wizard walks the steps and remembers where you are:

1. **Connect the owner wallet.** This wallet becomes the owner of both contracts.
2. **Check the chain.** The wallet must be on the chain the server reports; the panel asks the wallet to switch
   (or to add the chain) and blocks signing otherwise.
3. **Deploy ElymumArena (v3).** Constructor: admin = you, server authority = the server key (prefilled from
   `/api/config`), fee wallet = you (change it if you like; it receives the fee wallet's 5 % of every profit and
   half of every power-up payment). Defaults: 15 % of profit burned + 5 % to the fee wallet, burn mode 0
   (`0x…dEaD`), power-ups 50 % burned.
4. **Deploy ElymumNFT.** Defaults: max supply 5,000, price = $1 in ETH at today's ETH/USD, 1 allowlist and 2
   public mints per wallet, base URI `${PUBLIC_URL}/api/nft/`, treasury = you. Everything except the base URI
   once frozen can be changed later.
5. **Register both with the server.** `POST /api/admin/contracts` for each: the server checks that the code hash is
   the bundled one, that the owner is you and that the arena's server authority is its key, then stores the
   addresses in `/data/chains/<chainId>/contracts.json`. The server picks the arena up without a restart.
6. **Set the game token** (later, when `$ELYMUM` exists). Type the token address twice. It can be set **once**: a
   wrong address means deploying a new arena. Until it is set the arenas show "Opening soon" and only practice
   runs.
7. **Create the four arenas** (needs the token): Asphodel Meadow 1,000, Lethe Shore 10,000, Golden Bough 50,000,
   Isles of the Blessed 250,000 tokens, 300 open tickets each. The lobby opens them within about a minute.

**The testnet token.** On Robinhood Chain Testnet the wizard offers **Deploy TestToken** (an ERC20Burnable faucet
token: `faucet()` gives 1,000,000 per hour, 2x for emblem holders; only its owner mints). **Finish setup** sets it as
the arena's token, creates the four arenas and the holder perks in one go. The game token itself is launched on Pons,
which exists on mainnet only (RESEARCH.md). Remember the token is final for an arena deployment.

## 4. The allowlist and the mint

1. **WL**: approve or reject applications in `/admin` → **WL**; approve communities and collect their wallet lists in
   **Collabs**. Wallets are EVM addresses (0x…); anything else is refused.
2. **Publish the allowlist root** (Mint tab): the server builds a snapshot of every approved WL wallet plus every
   wallet in a submitted collab list (checksummed, de-duplicated, sorted) and its Merkle root; you sign
   `setMerkleRoot`. The panel warns when approvals changed since the published root: publish again.
3. **Set the price to $1** (Mint → Sync to $1): it reads ETH/USD and asks your wallet to call `setPrice`.
4. **Open the mint**: Mint → phase **Allowlist**. "Activate the game for holders" is offered checked: it sets who
   may play to `holders` (NFT holders plus admins). Later switch the phase to **Public**.
5. **Keep it at $1** (see OPERATIONS): press Sync now and then, or set the price bounds and make the server key the
   price keeper; the server then re-prices every 5 minutes when the price drifts more than 2 %, always inside your
   bounds.

## 5. Mainnet (Robinhood Chain)

1. Do the whole flow on Robinhood Chain Testnet first, including tickets, rounds, power-ups and the burn mode probe.
2. Launch the game token on Pons (mainnet only).
3. Set `CHAIN_ID=4663` and `EVM_RPC_URL` (a provider RPC; it may contain a key) on the host, optionally
   `PUBLIC_RPC_URL` (secret-free). Redeploy. The server opens a clean state for chain 4663; the testnet's records stay
   in `/data/chains/46630/`.
4. **New contracts.** Testnet addresses are not mainnet addresses. Fund the server key with ETH, redo section 3 on
   mainnet (the red MAINNET banner shows): deploy Arena and NFT, register, set the token, create the arenas, the
   holder perks, publish the root, sync the price. Keep burn mode 0 unless the probe shows the token's `burn()` works.
5. Start with small arenas; watch `/admin` → Launch and the server log (`!!!` lines).

## The admin CLI (alternative)

Everything the panel does on chain is also in the CLI (Node, a key file or env key):

```bash
export EVM_RPC_URL=https://rpc.testnet.chain.robinhood.com
export ADMIN_PRIVATE_KEY=/path/to/owner.key     # 0x hex, or a file holding it
pnpm admin status
pnpm admin deploy-test-token                    # testnet only
pnpm admin deploy-arena --server <serverKey>
pnpm admin deploy-nft --max-supply 5000 --usd-cents 100 --base-uri https://<site>/api/nft/
pnpm admin set-token --token <addr> --confirm <addr>
pnpm admin create-arena --defaults
pnpm admin nft:root --file allowlist.txt && pnpm admin nft:phase allowlist
pnpm admin help
```

The CLI refuses an RPC of any chain but Robinhood Chain, previews and simulates every transaction, `--dry-run`
stops after the preview, and Robinhood Chain mainnet needs
`--mainnet` plus typing "mainnet". Contracts deployed with the CLI still have to be registered with the server: use
`/admin` (Setup → Register) or set `ARENA_ADDRESS` / `NFT_ADDRESS`.

## Local development

- `pnpm demo`: a fake chain, nothing to deploy.
- `pnpm demo:localnet`: `hardhat node` (chain 31337, a local stand-in for Robinhood Chain Testnet) + the
  contracts deployed with the SDK + the production server
  (`scripts/localnet.mjs`, `scripts/localnet-fund.mjs`; addresses in `.localnet/contracts.json`).
- `pnpm -F @elymum/server e2e`: the deploy order above, end to end against a fresh hardhat node.
