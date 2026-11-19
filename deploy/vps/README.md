# Coinnibal game server on a VPS

The website and the game server are one: the VPS serves the site at **https://coinnibal.fun** (`SITE_DOMAIN`,
www redirects to it) and the game on the same origin, plus the game server's own domain (`GAME_DOMAIN`). There is
no Vercel: the app serves the web client it was built with (`WEB_DIST=/app/web`, with a strict CSP), and
`PUBLIC_URL` defaults to `https://<SITE_DOMAIN>` (`COINNIBAL_PUBLIC_URL` in `.env` overrides it). Every player
reaches the server with their own IP address, so the per-IP limits work. Everything is one command, and it looks after itself afterwards:

| What | How |
|---|---|
| HTTPS certificate | Caddy gets and renews it by itself |
| New code | a commit CI passed is built and deployed within 2 minutes (`elymum-update.timer`), swapped in the break after an arena bell |
| A broken commit | a failed build keeps the old version; a new container not healthy within 60 s is rolled back to the previous image at once |
| Crashes | containers restart by themselves (`restart: unless-stopped`); a hung app is restarted by the alert job after 3 minutes (autoheal) |
| Alerts | every minute: `!!!` log lines, `/api/health` 503, gas runway, disk over 80 %, the container down, to Telegram (`elymum-alert.timer`) |
| Backups | every day at 04:00, the newest 14 kept in `/opt/elymum/backups`; optional encrypted offsite copy (rclone crypt) |
| Security updates | installed automatically; a reboot they need happens at 04:30 **in a round break** (`elymum-reboot.timer`) |
| Logs | Docker's journald driver and a persistent journal: they survive redeploys and reboots |
| Firewall, SSH brute force | ufw (only 22, 80, 443 open) and fail2ban |

Files here: `install.sh` (the installer), `docker-compose.yml` (the app and Caddy), `caddy/`, `env.example` (every
setting, with comments), `update.sh`, `alert.sh`, `reboot.sh`, `backup.sh`, `restore.sh`, `status.sh`, `compose.sh`,
`lib.sh`, `systemd/` (the timers).

---

## 1. The VPS

**8 vCPU, 16 GB RAM**, Ubuntu 24.04, close to most players (Frankfurt, Amsterdam, Gravelines). The rooms run on
`GAME_WORKERS` cores (5 on 8 vCPU: the main thread keeps the sockets, HTTP, the chain and the journal, and two cores
stay free for Caddy, Docker and the alert job); 500 players use about 1.7 cores (docs/ARCHITECTURE.md, "Capacity").
`MAX_CONNECTIONS=1500` fits the 16 GB (about 1 MB per connection) with a wide margin.

Add your SSH public key when you order (`ssh-keygen -t ed25519` if you have none) and test `ssh <user>@<IP>`.

## 2. DNS

The game server's own domain (`GAME_DOMAIN`): the live server's is `game.elymum.io`, a record under the old domain
kept from before the rename (its DNS record and certificate exist; `game.coinnibal.fun` needs its own `A` record
first). Where the DNS of that domain is managed, add an `A` record `game` → the VPS IPv4 address, **DNS only** (no CDN
proxy until "Cloudflare in front" below). `nslookup <GAME_DOMAIN>` must answer the VPS address before step 3: Caddy
needs it for the certificate.

The site (`SITE_DOMAIN`, default `coinnibal.fun`, DNS on Cloudflare): `A` records for `@` and `www` → the same VPS
address, **DNS only**, so Caddy can get their certificates too.

## 3. Install

Copy the installer to the server (`scp deploy/vps/install.sh <user>@<IP>:`), then as root:

```bash
sudo -i
bash /home/<user>/install.sh
```

It asks for the domain (`GAME_DOMAIN`, section 2), the repository (an SSH URL for the private repository: it makes a
read-only **deploy key** and shows the steps to add it on GitHub) and the branch. Then it updates Ubuntu, installs
Docker, automatic security updates (no automatic reboot), the firewall, fail2ban, a persistent journal, network
tuning, downloads the code to `/opt/elymum`, opens `/opt/elymum/.env` in nano (section 4), builds and starts the
server, installs the timers and the commands (section 10) and waits for `https://<GAME_DOMAIN>/api/health?live=1`.
Running it again is safe.

## 4. Settings (`/opt/elymum/.env`)

`env.example` lists every setting with its default. What the owner sets (never commit this file):

| Key | What |
|---|---|
| `GAME_DOMAIN` | the game server's domain (section 2; the live server's is `game.elymum.io`) |
| `SITE_DOMAIN` | optional: the site (default `coinnibal.fun`). The server's `PUBLIC_URL` (the site's origin: SIWE sign-ins are bound to it, the NFT metadata links start with it) is `https://<SITE_DOMAIN>`; `COINNIBAL_PUBLIC_URL` overrides it. `install.sh` still wants a non-empty `PUBLIC_URL` line in `.env`, whose value `docker-compose.yml` ignores |
| `CORS_ORIGIN` | `https://coinnibal.fun` |
| `ADMIN_WALLETS` | the owner's 0x address(es) |
| `AUTH_SECRET` | `openssl rand -hex 32` (at least 32 bytes; the mainnet refuses to start with less), or empty for the generated `DATA_DIR/auth-secret` |
| `SERVER_PRIVATE_KEY` | `auto` (kept in the data volume and the backups) |
| `COINNIBAL_CHAIN_ID` | optional: `46630` (testnet, the default when unset) or `4663` (mainnet) |
| `COINNIBAL_RPC_URLS` | optional: the RPCs in order, comma-separated: the Alchemy URL first, the public RPC as fallback (section 5). Unset: `https://rpc.testnet.chain.robinhood.com` |
| `COINNIBAL_RPC_MAX_RPS` | optional: calls per second per URL, one per `COINNIBAL_RPC_URLS` entry (`25,4`); default 4 |
| `COINNIBAL_GAME_ACCESS` | optional: `site` (the default when unset: the `/admin` → Settings switch decides), or `public`, `holders`, `admins`, `maintenance` to override that switch |
| `COINNIBAL_PIN_ARENA`, `COINNIBAL_PIN_NFT` | after the owner's deploy: the registered CoinnibalArena and CoinnibalNFT, the contracts the site trusts (below). Empty: the site signs no ticket and no mint |
| `COINNIBAL_PIN_TOKEN` | once the game token is set on the arena: that token (empty: the site does not check the arena's token against a pin) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | alerts to Telegram (optional; section 7) |
| `BACKUP_RCLONE_REMOTE` | the encrypted offsite remote, e.g. `elymum-offsite:` (optional; section 8; the name given before the rename) |
| `GAME_WORKERS` | `5` on 8 vCPU |
| `MAX_CONNECTIONS` | `1500` |

`docker-compose.yml` maps the `COINNIBAL_*` keys to the server's `CHAIN_ID`, `EVM_RPC_URLS`, `RPC_MAX_RPS` and
`GAME_ACCESS`, and always overrides those names (and `EVM_RPC_URL`, forced empty) whatever `.env` says: this `.env`
was first filled from an older Elysium / Render setup, and a stale `CHAIN_ID`, `EVM_RPC_URL` or `GAME_ACCESS` in it
must never move the live server to another chain or override who may play. Unset `COINNIBAL_*` keys mean the live testnet
values (46630, the testnet's public RPC) and `site`: the owner opens and closes the game, the mint page, WL and collab
applications in `/admin` → Settings (a fresh server starts with all four closed). After a change: `coinnibal-compose up -d app`. Check what the app
gets with `coinnibal-compose config | grep -E 'CHAIN_ID|EVM_RPC|RPC_MAX_RPS|GAME_ACCESS'`.

**Renamed keys (Elymum → Coinnibal, November 2026).** The `.env` keys are `COINNIBAL_CHAIN_ID`, `COINNIBAL_RPC_URLS`,
`COINNIBAL_RPC_MAX_RPS`, `COINNIBAL_GAME_ACCESS`, `COINNIBAL_PUBLIC_URL`, `COINNIBAL_WEB_DIST` and
`COINNIBAL_REQUIRE_CI`; on the command line `COINNIBAL_DEPLOY_NOW=1`, and the scripts' overrides `COINNIBAL_DIR`,
`COINNIBAL_ENV` and `COINNIBAL_BACKUPS`. Each one still accepts its `ELYMUM_*` name of before the rename, so a `.env`
written then keeps working unchanged; when both names are set, the `COINNIBAL_*` one wins. `docker-compose.yml` reads
them with nested interpolation (`${COINNIBAL_CHAIN_ID:-${ELYMUM_CHAIN_ID:-46630}}`), the scripts through
`env_get_renamed` and `${COINNIBAL_X:-${ELYMUM_X:-default}}` in `lib.sh`. Renaming the keys in `.env` is optional:
`coinnibal-compose config` shows the same values either way.

**Contract pins (the site build).** The site is built with the contracts it trusts (`apps/web/src/wallet/pinned.ts`):
`docker-compose.yml` passes `COINNIBAL_PIN_ARENA`, `COINNIBAL_PIN_NFT` and `COINNIBAL_PIN_TOKEN` to the image build as
`VITE_ARENA_ADDRESS`, `VITE_NFT_ADDRESS` and `VITE_TOKEN_ADDRESS`, for the chain of `COINNIBAL_CHAIN_ID` (as
`VITE_CHAIN_ID`). Wallets approve, pay and mint only there, whatever the server announces: a stolen admin login, or a
server API that names other contracts, cannot point them at another contract, because a pin changes only with shell
access to this VPS and a rebuild. The pins do not guard against someone who has that shell: the site is built and
served on this VPS, so they could rebuild it with other pins. No chain has default pins. After the owner deploys and
registers the contracts in `/admin` (and again once the game token is set on the arena), `/admin` → Setup → **Site
pins** shows the lines with the registered addresses: check each one against the deploy transaction in your own wallet
(the panel's addresses come from the server, which is what the pins guard against), set them here, then rebuild and
restart the app:

```bash
coinnibal-compose up -d --build app
```

`update.sh` rebuilds only when the tracked branch moves, so a `.env` change alone needs this command; later builds keep
the pins (they are read from `.env` every time). It swaps the container as soon as the image is built, which takes
minutes, longer than the break after a bell. Once players are in the arenas, build first and swap in the break
(section 6): `coinnibal-compose build app`, then `coinnibal-compose up -d app` in the break after a bell. Check what
the build gets with `coinnibal-compose config | grep VITE_`.
The same applies when moving to the mainnet: the server follows `COINNIBAL_CHAIN_ID` after `coinnibal-compose up -d
app`, the site signs nothing there until it is rebuilt with the mainnet pins.

**Names kept from before the rename.** The server was installed under the old name, and these stay exactly as they
are (`lib.sh` lists them): changing them moves the data. A new Docker project name means a new, empty volume (the
game's data would seem lost) and a port clash with the running container. They are the install directory
`/opt/elymum`, the compose project `elymum`, the volume `elymum-data` (and `elymum-caddy-data`, `elymum-caddy-config`),
the image `elymum-app:latest` (and `:previous`), the container `elymum-app-1` and its log tag, `/var/lib/elymum`,
`/run/lock/elymum.lock`, the host files `install.sh` wrote (journald, unattended-upgrades, fail2ban, sysctl, the deploy
key), the systemd units `elymum-*.service` / `.timer`, the commands `/usr/local/bin/elymum-*`, the backups
`elymum-data-*.tar.gz` here and offsite (`restore.sh` and `status.sh` still find the old ones) and the CI tag
`ci-green-<branch>`. The commands also exist as `coinnibal-*` (the same scripts; `install.sh` and `update.sh` add them),
which this README uses.

## 5. RPC: Alchemy first, the public RPC as fallback

The server reads the chain and sends settlements through `EVM_RPC_URLS`, a viem fallback in order: a URL that keeps
answering 429 or is down hands the call to the next one after two tries, and every new call starts with the first
URL again. Each URL has its own request budget (`COINNIBAL_RPC_MAX_RPS`, one rate per URL). Every URL must serve the chain
(one that does not is left out, logged with `!!!`). The browser never sees these URLs (`PUBLIC_RPC_URL`, or the
public one in the list).

1. Alchemy → Create app → network **Robinhood Chain** (Mainnet; Testnet for the testnet). Copy the HTTPS URL
   (`https://robinhood-mainnet.g.alchemy.com/v2/<key>`; the testnet's is `robinhood-testnet.g.alchemy.com`).
2. In `.env` (mainnet):
   ```bash
   COINNIBAL_CHAIN_ID=4663
   COINNIBAL_RPC_URLS=https://robinhood-mainnet.g.alchemy.com/v2/<key>,https://rpc.mainnet.chain.robinhood.com
   COINNIBAL_RPC_MAX_RPS=25,4
   ```
   25 calls a second is well inside Alchemy's free plan (its compute units; raise it on a paid plan); the public RPC
   allows about 4. `coinnibal-compose up -d app`.
3. Check: the log says `chain: 2 RPCs (fallback in this order)` and how reads are merged (`Multicall3 found`, or a
   deployless multicall on a chain without it). `coinnibal-compose logs app | grep 'rpc:'` shows the calls per minute.

A bell of 200 tickets reads its sessions in about 24 `eth_call`s (multicall) instead of 216, and at 4 calls a second
pays its last ticket in about 17 s instead of 65 s (`scripts/bench/bell-burst.ts`).

## 6. Deploys

- **Only commits CI passed.** After every green run on a branch, CI moves the tag `ci-green-<branch>` to the commit
  (`.github/workflows/ci.yml`, job `mark-green`). `update.sh` fetches it with the code (the deploy key is enough; the
  CI status of a private repository is not readable from the VPS without a GitHub token, so the marker travels
  through git) and deploys the newest commit it marks. A commit pushed while CI runs waits (`journalctl -u
  elymum-update` says so). Without the tag (CI never ran the job yet) the branch head is deployed as before;
  `COINNIBAL_REQUIRE_CI=1` in `.env` refuses that.
- **In the round break.** The new image is built while the old container serves; the swap waits for the break after
  an arena bell (no live stake then: SIGTERM mid-round would cash every arena player out). `COINNIBAL_DEPLOY_NOW=1
  coinnibal-update` skips the wait for an urgent fix.
- **Rollback.** The running image is tagged `elymum-app:previous` before every build. When the new container is not
  healthy (the liveness check) within 60 s, `update.sh` puts the previous image and commit back at once and alerts;
  that commit is not retried until a newer one arrives. By hand: `docker tag elymum-app:previous elymum-app:latest
  && coinnibal-compose up -d app`.
- **Caddy** reloads when its file changed (`stream_close_delay 10m` keeps the game sockets open across a reload).

## 7. Alerts and autoheal

`elymum-alert.timer` runs `alert.sh` every minute. It posts to Telegram when the server logs a `!!!` line, when
`/api/health` answers 503 (with the reasons: the journal cannot be written, settlements backed up or stuck, the RPC
unreachable, the server key's gas runway under 2 days, the books guard, the server clock more than 30 s off the
chain, a room worker down), when the gas runway is under 7 days, when a disk is over 80 % full, and when the app
container is down. Each alert repeats at most every 30 minutes while it lasts and says "ok again" when it clears.

Telegram: talk to **@BotFather** → `/newbot` → copy the token; send your bot a message, then open
`https://api.telegram.org/bot<token>/getUpdates` and copy `chat.id`. In `.env`: `TELEGRAM_BOT_TOKEN=<token>`,
`TELEGRAM_CHAT_ID=<id>`. Test: `coinnibal-alert` (it reads them on every run). Without them alerts go to the journal
only (`journalctl -u elymum-alert`).

**Autoheal.** The container's health check is liveness only (`/api/health?live=1`: the process answers). When it fails
on 3 runs in a row the alert job restarts the app. A server that waits on the RPC, or whose disk is full, answers its
liveness check and is not restarted: a restart fixes neither (and would cash out live coins).

## 8. Backups

`elymum-backup.timer` writes `/opt/elymum/backups/elymum-data-YYYYmmdd-HHMM.tar.gz` at 04:00 (the newest 14). The
file holds the **server key**: treat it like a private key.

**Offsite (optional, encrypted).** `apt-get install -y rclone`, then `rclone config`: first a remote for the storage
(Backblaze B2, S3, Cloudflare R2: e.g. `b2raw`, bucket `elymum-backups`), then a remote of type **crypt** over it
(e.g. `elymum-offsite`, remote `b2raw:elymum-backups`, a generated password and salt). **Keep the crypt passwords
outside the VPS** (a password manager): without them the copies cannot be read. In `.env`:
`BACKUP_RCLONE_REMOTE=elymum-offsite:` (and `BACKUP_RCLONE_KEEP_DAYS=30`). Every backup is then copied there; a
remote that is not `crypt` is refused; a failed copy is alerted. Test: `coinnibal-backup`, then `rclone ls elymum-offsite:`.
The example names (`elymum-backups`, `elymum-offsite`) are the ones this README gave before the rename: a remote set
up then keeps them, and any name works.

## 9. Moving to another VPS, or the VPS died

**The old server still runs (a planned move).** The new server copies the settings and the data from the old one in
one command. The exports hand out the server key, so they need a fresh signature of the admin wallet, single use,
for 10 minutes (and on the mainnet `ADMIN_SECRET_EXPORT=1` on the old server for the time of the move):

1. Close the game (`/admin` → Settings → who may play: Admins) and wait for the bell.
2. The proof: `/admin` → Network → Backup & move asks the wallet to sign (purpose `migration`) where the panel offers it; by hand: with an
   admin session token, `POST /api/admin/secret-proof {"purpose":"migration"}`, sign the returned `message` with the
   admin wallet (`personal_sign`), and base64url-encode `{"message":"...","signature":"0x..."}`: that is the proof.
3. On the new VPS (sections 1 to 3; the installer takes the old server's settings itself):
   ```bash
   bash install.sh --from https://<old GAME_DOMAIN> --token '<admin session token>' --proof '<proof>' --yes
   ```
   It reads the settings once (`/api/admin/migration-env`) and the backup once (`/api/admin/backup`), restores the
   data before the first start, and starts. **It does not copy the site's contract pins** (section 4: a pin changes
   only in this shell, never from another server's answer), so the moved site signs no ticket, refund, shop payment
   or mint until they are back: set the `COINNIBAL_PIN_ARENA` and `COINNIBAL_PIN_NFT` lines (and `COINNIBAL_PIN_TOKEN`
   once the game token is set) in `/opt/elymum/.env`, from your password manager or `/admin` → Setup → **Site pins**,
   checking each address against the deploy transaction in your own wallet, then run
   `coinnibal-compose up -d --build app`.
4. **Stop the old server before the new one starts settling** (`coinnibal-compose down` there): two servers must never
   run with the same server key. Then point DNS at the new VPS; remove `ADMIN_SECRET_EXPORT`.

**The VPS died (no way to reach it).**

1. Pause the arena if the key may be exposed (`/admin` → Game → Pause); otherwise tickets stay safe on chain: unplayed
   ones are refunded in full by the next server, settled ones are paid, and a player can refund any ticket after 24 h.
2. A new VPS (sections 1 to 3); stop at the settings step and put the old `.env` values back (from your password
   manager: `ADMIN_WALLETS`, `AUTH_SECRET`, `COINNIBAL_CHAIN_ID`, `COINNIBAL_RPC_URLS`, the site's pins
   `COINNIBAL_PIN_ARENA`, `COINNIBAL_PIN_NFT` and `COINNIBAL_PIN_TOKEN`, ...). Without the pins the new site signs no
   ticket, refund, shop payment or mint (section 4).
3. The newest backup: from the offsite copy (`rclone copy elymum-offsite:elymum-data-<newest>.tar.gz /root/`), then
   `coinnibal-restore /root/elymum-data-<newest>.tar.gz`. It carries the server key, the journal (pending settlements go
   out), the contracts registry and the site data. What happened after that backup is lost: tickets settled since are
   simply closed on chain already; live ones of that day are settled at their last saved value or refunded.
4. DNS → the new IP. `/api/health` and `coinnibal-status`. If the key may have leaked: rotate it (docs/OPERATIONS.md
   "Rotating the server key") and unpause.

## 10. Day to day

All commands as root on the VPS (`sudo -i`).

| Task | Command |
|---|---|
| Everything at a glance (health and its reasons, deployed commit, rollback image, alerts, backups, disk) | `coinnibal-status` |
| Live server log | `coinnibal-compose logs -f --tail 200 app` (or `journalctl -f CONTAINER_NAME=elymum-app-1`) |
| Caddy (HTTPS) log | `coinnibal-compose logs --tail 100 caddy` |
| Auto-deploy log | `journalctl -u elymum-update -n 100` |
| Alerts log | `journalctl -u elymum-alert -n 50` |
| Deploy now instead of waiting 2 minutes | `coinnibal-update` |
| Restart the game server (in a round break) | `coinnibal-compose restart app` (any time it cashes the arenas out: prefer a break) |
| Change a setting | `nano /opt/elymum/.env`, then `coinnibal-compose up -d app` |
| Change a site pin (`COINNIBAL_PIN_*`) | `nano /opt/elymum/.env`, then `coinnibal-compose up -d --build app` (section 4; with players in the arenas: build first, swap in the break) |
| Backup now / log | `coinnibal-backup` / `journalctl -u elymum-backup -n 50` |
| Restore a backup | `coinnibal-restore /opt/elymum/backups/elymum-data-YYYYmmdd-HHMM.tar.gz` |
| Pause auto-deploy | `systemctl stop elymum-update.timer` (`start` to resume) |
| Reboot for an update now, in the next round break | `coinnibal-reboot --force` |

## Cloudflare in front (recommended for DDoS protection)

The server and Caddy cut slow, oversized and abusive traffic (per-IP and per-subnet connection caps, sockets
that never say hello, message floods, slowloris, HTTP rate limits, load shedding; `pnpm -F @coinnibal/server`
`node --import tsx scripts/bench/flood.ts` shows each). A volumetric attack fills the VPS's link before any of that
runs: only a network in front absorbs it. Cloudflare's free plan proxies WebSockets and is enough.

What to click (about 20 minutes; do it at a quiet hour):

1. **Cloudflare → Add a site → the game domain's zone** (`elymum.io` for the live `game.elymum.io`; Free plan). Cloudflare lists the domain's DNS records; check that
   `game` (A record to the VPS) and the Vercel records are there. At your registrar, replace the nameservers with
   the two Cloudflare names it shows. Wait until Cloudflare says the site is active.
2. **DNS:** the `game` A record **Proxied** (orange cloud). Leave the Vercel records (`@`, `www`) **DNS only** (grey
   cloud): Vercel has its own edge, and a proxied Vercel record needs extra Vercel settings.
3. **SSL/TLS → Overview: Full (strict)** (Caddy keeps its own certificate; Cloudflare checks it). SSL/TLS → Edge
   Certificates: minimum TLS 1.2; leave **Always Use HTTPS off** (Caddy redirects to HTTPS itself, and its
   certificate renewals answer Let's Encrypt on plain HTTP through Cloudflare).
4. **Network:** WebSockets **on** (the default). **Security → Settings:** Security level Medium; Bot Fight Mode **off**
   (it challenges the game's WebSocket and API calls, which cannot answer a challenge).
5. **Caching → Configuration:** Standard; no "cache everything" rule (`/api/*` is answered with `no-store` or short
   `max-age` by the server itself).
6. **Security → WAF → Rate limiting rules** (the free plan has one rule): path starts with `/api/auth/` → 30 requests
   per 10 s per IP → Block for 10 s. Optional; the server limits it too.
7. **On the VPS:** switch Caddy to the Cloudflare config (it trusts `CF-Connecting-IP` only from Cloudflare's ranges,
   so per-IP limits keep seeing players):
   ```bash
   echo 'CADDY_CONFIG=Caddyfile.cloudflare' >> /opt/elymum/.env
   coinnibal-compose up -d caddy
   ```
8. **Close the back door** so attackers cannot hit the VPS address directly (Docker publishes 80/443 past ufw, so the
   rule goes into Docker's own `DOCKER-USER` chain). As root:
   ```bash
   apt-get install -y iptables-persistent
   for r in $(curl -fsS https://www.cloudflare.com/ips-v4); do iptables -I DOCKER-USER -p tcp -m multiport --dports 80,443 -s "$r" -j RETURN; done
   iptables -A DOCKER-USER -p tcp -m multiport --dports 80,443 -j DROP
   for r in $(curl -fsS https://www.cloudflare.com/ips-v6); do ip6tables -I DOCKER-USER -p tcp -m multiport --dports 80,443 -s "$r" -j RETURN; done
   ip6tables -A DOCKER-USER -p tcp -m multiport --dports 80,443 -j DROP
   netfilter-persistent save
   ```
   Check from your laptop: `curl -sS https://<GAME_DOMAIN>/api/health` works, `curl -k https://<VPS IP>/api/health`
   times out. Certificate renewals keep working (Let's Encrypt reaches Caddy through Cloudflare on port 80).
9. **Check:** `curl -sS -D - -o /dev/null https://<GAME_DOMAIN>/api/health` answers through Cloudflare (its headers
   carry a `cf-ray` line). The per-IP limits now see each player's own address, because Caddy passes
   `CF-Connecting-IP` on as the one `X-Forwarded-For` hop. `/admin` shows no IP addresses: Safety keeps only hashes
   of them, keyed with the server's secret.

To undo: the `game` record back to DNS only, `CADDY_CONFIG` removed (`coinnibal-compose up -d caddy`), and
`iptables -F DOCKER-USER && ip6tables -F DOCKER-USER && netfilter-persistent save`.

## Notes

- **Client IPs.** Caddy sets `X-Forwarded-For` itself and ignores the header when a client sends it (no
  `trusted_proxies` configured), so the app sees exactly one hop, the player's address. `docker-compose.yml`
  sets `TRUST_PROXY=1` and `TRUST_PROXY_HOPS=1` for it. Behind Cloudflare, `Caddyfile.cloudflare` keeps that single
  hop (above); do not put any other proxy in front without a config of its own.
- **Ports.** Only Caddy publishes ports (80, 443, 443/udp for HTTP/3). The app listens on 8787 inside the
  Docker network only. Docker opens its published ports itself; ufw covers everything else.
- **Shutdown.** On a restart or deploy the server gets SIGTERM and pays out every live stake player before it
  exits; compose waits up to 45 s for that (`stop_grace_period`).
- **The `$` in settings.** docker compose expands `$NAME` in `.env` values: write a value containing `$` in
  single quotes.
- **Branch.** The installer records the branch in `/var/lib/elymum/branch`; to follow another branch, run the
  installer again with `--branch <name>`.
