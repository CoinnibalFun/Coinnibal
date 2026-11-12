# Coinnibal game server on a VPS

The website is on Vercel at **https://elymum.io**; the game server runs on a VPS at **https://game.elymum.io**,
and the website talks to it directly (every player reaches the server with their own IP address, so the per-IP
limits work). Everything is one command, and it looks after itself afterwards:

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

Where the DNS of `elymum.io` is managed, add an `A` record `game` → the VPS IPv4 address, **DNS only** (no CDN proxy
until "Cloudflare in front" below). `nslookup game.elymum.io` must answer the VPS address before step 3: Caddy needs
it for the certificate.

## 3. Install

Copy the installer to the server (`scp deploy/vps/install.sh <user>@<IP>:`), then as root:

```bash
sudo -i
bash /home/<user>/install.sh
```

It asks for the domain (`game.elymum.io`), the repository (an SSH URL for the private repository: it makes a
read-only **deploy key** and shows the steps to add it on GitHub) and the branch. Then it updates Ubuntu, installs
Docker, automatic security updates (no automatic reboot), the firewall, fail2ban, a persistent journal, network
tuning, downloads the code to `/opt/elymum`, opens `/opt/elymum/.env` in nano (section 4), builds and starts the
server, installs the timers and waits for `https://game.elymum.io/api/health?live=1`. Running it again is safe.

## 4. Settings (`/opt/elymum/.env`)

`env.example` lists every setting with its default. What the owner sets (never commit this file):

| Key | What |
|---|---|
| `GAME_DOMAIN` | `game.elymum.io` |
| `PUBLIC_URL`, `CORS_ORIGIN` | `https://elymum.io` (the site's origin: SIWE sign-ins are bound to it) |
| `ADMIN_WALLETS` | the owner's 0x address(es) |
| `AUTH_SECRET` | `openssl rand -hex 32` (at least 32 bytes; the mainnet refuses to start with less), or empty for the generated `DATA_DIR/auth-secret` |
| `SERVER_PRIVATE_KEY` | `auto` (kept in the data volume and the backups) |
| `ELYMUM_CHAIN_ID` | optional: `46630` (testnet, the default when unset) or `4663` (mainnet) |
| `ELYMUM_RPC_URLS` | optional: the RPCs in order, comma-separated: the Alchemy URL first, the public RPC as fallback (section 5). Unset: `https://rpc.testnet.chain.robinhood.com` |
| `ELYMUM_RPC_MAX_RPS` | optional: calls per second per URL, one per `ELYMUM_RPC_URLS` entry (`25,4`); default 4 |
| `ELYMUM_GAME_ACCESS` | optional: `public` (the default when unset), `holders`, `admins`, `maintenance`, or `site` (the `/admin` setting decides) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | alerts to Telegram (optional; section 7) |
| `BACKUP_RCLONE_REMOTE` | the encrypted offsite remote, e.g. `elymum-offsite:` (optional; section 8) |
| `GAME_WORKERS` | `5` on 8 vCPU |
| `MAX_CONNECTIONS` | `1500` |

`docker-compose.yml` maps the `ELYMUM_*` keys to the server's `CHAIN_ID`, `EVM_RPC_URLS`, `RPC_MAX_RPS` and
`GAME_ACCESS`, and always overrides those names (and `EVM_RPC_URL`, forced empty) whatever `.env` says: this `.env`
was first filled from an older Elysium / Render setup, and a stale `CHAIN_ID`, `EVM_RPC_URL` or `GAME_ACCESS` in it
must never move the live server to another chain or close the game. Unset `ELYMUM_*` keys mean the live testnet
values (46630, the testnet's public RPC, `public`). After a change: `elymum-compose up -d app`. Check what the app
gets with `elymum-compose config | grep -E 'CHAIN_ID|EVM_RPC|RPC_MAX_RPS|GAME_ACCESS'`.

## 5. RPC: Alchemy first, the public RPC as fallback

The server reads the chain and sends settlements through `EVM_RPC_URLS`, a viem fallback in order: a URL that keeps
answering 429 or is down hands the call to the next one after two tries, and every new call starts with the first
URL again. Each URL has its own request budget (`ELYMUM_RPC_MAX_RPS`, one rate per URL). Every URL must serve the chain
(one that does not is left out, logged with `!!!`). The browser never sees these URLs (`PUBLIC_RPC_URL`, or the
public one in the list).

1. Alchemy → Create app → network **Robinhood Chain** (Mainnet; Testnet for the testnet). Copy the HTTPS URL
   (`https://robinhood-mainnet.g.alchemy.com/v2/<key>`; the testnet's is `robinhood-testnet.g.alchemy.com`).
2. In `.env` (mainnet):
   ```bash
   ELYMUM_CHAIN_ID=4663
   ELYMUM_RPC_URLS=https://robinhood-mainnet.g.alchemy.com/v2/<key>,https://rpc.mainnet.chain.robinhood.com
   ELYMUM_RPC_MAX_RPS=25,4
   ```
   25 calls a second is well inside Alchemy's free plan (its compute units; raise it on a paid plan); the public RPC
   allows about 4. `elymum-compose up -d app`.
3. Check: the log says `chain: 2 RPCs (fallback in this order)` and how reads are merged (`Multicall3 found`, or a
   deployless multicall on a chain without it). `elymum-compose logs app | grep 'rpc:'` shows the calls per minute.

A bell of 200 tickets reads its sessions in about 24 `eth_call`s (multicall) instead of 216, and at 4 calls a second
pays its last ticket in about 17 s instead of 65 s (`scripts/bench/bell-burst.ts`).

## 6. Deploys

- **Only commits CI passed.** After every green run on a branch, CI moves the tag `ci-green-<branch>` to the commit
  (`.github/workflows/ci.yml`, job `mark-green`). `update.sh` fetches it with the code (the deploy key is enough; the
  CI status of a private repository is not readable from the VPS without a GitHub token, so the marker travels
  through git) and deploys the newest commit it marks. A commit pushed while CI runs waits (`journalctl -u
  elymum-update` says so). Without the tag (CI never ran the job yet) the branch head is deployed as before;
  `ELYMUM_REQUIRE_CI=1` in `.env` refuses that.
- **In the round break.** The new image is built while the old container serves; the swap waits for the break after
  an arena bell (no live stake then: SIGTERM mid-round would cash every arena player out). `ELYMUM_DEPLOY_NOW=1
  elymum-update` skips the wait for an urgent fix.
- **Rollback.** The running image is tagged `elymum-app:previous` before every build. When the new container is not
  healthy (the liveness check) within 60 s, `update.sh` puts the previous image and commit back at once and alerts;
  that commit is not retried until a newer one arrives. By hand: `docker tag elymum-app:previous elymum-app:latest
  && elymum-compose up -d app`.
- **Caddy** reloads when its file changed (`stream_close_delay 10m` keeps the game sockets open across a reload).

## 7. Alerts and autoheal

`elymum-alert.timer` runs `alert.sh` every minute. It posts to Telegram when the server logs a `!!!` line, when
`/api/health` answers 503 (with the reasons: the journal cannot be written, settlements backed up or stuck, the RPC
unreachable, the server key's gas runway under 2 days, the books guard, the server clock more than 30 s off the
chain, a room worker down), when the gas runway is under 7 days, when a disk is over 80 % full, and when the app
container is down. Each alert repeats at most every 30 minutes while it lasts and says "ok again" when it clears.

Telegram: talk to **@BotFather** → `/newbot` → copy the token; send your bot a message, then open
`https://api.telegram.org/bot<token>/getUpdates` and copy `chat.id`. In `.env`: `TELEGRAM_BOT_TOKEN=<token>`,
`TELEGRAM_CHAT_ID=<id>`. Test: `elymum-alert` (it reads them on every run). Without them alerts go to the journal
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
remote that is not `crypt` is refused; a failed copy is alerted. Test: `elymum-backup`, then `rclone ls elymum-offsite:`.

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
   bash install.sh --from https://game.elymum.io --token '<admin session token>' --proof '<proof>' --yes
   ```
   It reads the settings once (`/api/admin/migration-env`) and the backup once (`/api/admin/backup`), restores the
   data before the first start, and starts.
4. **Stop the old server before the new one starts settling** (`elymum-compose down` there): two servers must never
   run with the same server key. Then point DNS at the new VPS; remove `ADMIN_SECRET_EXPORT`.

**The VPS died (no way to reach it).**

1. Pause the arena if the key may be exposed (`/admin` → Game → Pause); otherwise tickets stay safe on chain: unplayed
   ones are refunded in full by the next server, settled ones are paid, and a player can refund any ticket after 24 h.
2. A new VPS (sections 1 to 3); stop at the settings step and put the old `.env` values back (from your password
   manager: `ADMIN_WALLETS`, `AUTH_SECRET`, `ELYMUM_CHAIN_ID`, `ELYMUM_RPC_URLS`, ...).
3. The newest backup: from the offsite copy (`rclone copy elymum-offsite:elymum-data-<newest>.tar.gz /root/`), then
   `elymum-restore /root/elymum-data-<newest>.tar.gz`. It carries the server key, the journal (pending settlements go
   out), the contracts registry and the site data. What happened after that backup is lost: tickets settled since are
   simply closed on chain already; live ones of that day are settled at their last saved value or refunded.
4. DNS → the new IP. `/api/health` and `elymum-status`. If the key may have leaked: rotate it (docs/OPERATIONS.md
   "Rotating the server key") and unpause.

## 10. Day to day

All commands as root on the VPS (`sudo -i`).

| Task | Command |
|---|---|
| Everything at a glance (health and its reasons, deployed commit, rollback image, alerts, backups, disk) | `elymum-status` |
| Live server log | `elymum-compose logs -f --tail 200 app` (or `journalctl -f CONTAINER_NAME=elymum-app-1`) |
| Caddy (HTTPS) log | `elymum-compose logs --tail 100 caddy` |
| Auto-deploy log | `journalctl -u elymum-update -n 100` |
| Alerts log | `journalctl -u elymum-alert -n 50` |
| Deploy now instead of waiting 2 minutes | `elymum-update` |
| Restart the game server (in a round break) | `elymum-compose restart app` (any time it cashes the arenas out: prefer a break) |
| Change a setting | `nano /opt/elymum/.env`, then `elymum-compose up -d app` |
| Backup now / log | `elymum-backup` / `journalctl -u elymum-backup -n 50` |
| Restore a backup | `elymum-restore /opt/elymum/backups/elymum-data-YYYYmmdd-HHMM.tar.gz` |
| Pause auto-deploy | `systemctl stop elymum-update.timer` (`start` to resume) |
| Reboot for an update now, in the next round break | `elymum-reboot --force` |

## Cloudflare in front (recommended for DDoS protection)

The server and Caddy cut slow, oversized and abusive traffic (per-IP and per-subnet connection caps, sockets
that never say hello, message floods, slowloris, HTTP rate limits, load shedding; `pnpm -F @elymum/server`
`node --import tsx scripts/bench/flood.ts` shows each). A volumetric attack fills the VPS's link before any of that
runs: only a network in front absorbs it. Cloudflare's free plan proxies WebSockets and is enough.

What to click (about 20 minutes; do it at a quiet hour):

1. **Cloudflare → Add a site → elymum.io** (Free plan). Cloudflare lists the domain's DNS records; check that
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
   elymum-compose up -d caddy
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
   Check from your laptop: `curl -sS https://game.elymum.io/api/health` works, `curl -k https://<VPS IP>/api/health`
   times out. Certificate renewals keep working (Let's Encrypt reaches Caddy through Cloudflare on port 80).
9. **Check:** play a practice round; `/admin` → Network shows players' own addresses in the integrity tab, not
   Cloudflare's.

To undo: the `game` record back to DNS only, `CADDY_CONFIG` removed (`elymum-compose up -d caddy`), and
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
