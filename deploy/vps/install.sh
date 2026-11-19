#!/usr/bin/env bash
# Coinnibal game server: one-command install on a fresh Ubuntu 22.04 / 24.04 VPS. Run as root:
#   bash install.sh                       asks for the domain, repository and branch (Enter = default)
#   bash install.sh --restore coinnibal-backup.tar.gz
#   bash install.sh --restore-url https://game.elymum.io      the data of a running server (it asks for the secrets)
#   bash install.sh --yes --from https://game.elymum.io       the whole move in one command: copies the old server's
#       settings (.env) AND its data. It needs the admin session token and a proof, a fresh signature of the admin
#       wallet of purpose "migration" (POST /api/admin/secret-proof, README "Moving"). Neither is ever an argument
#       (any local user can read a command line in ps): it asks for them at hidden prompts, or reads them from stdin,
#       one per line (the token, then the proof; /admin -> Network -> Backup & move copies the command with both).
# Options: --domain D, --repo SSH_URL, --branch B, --set KEY=VALUE (a .env setting; repeatable; it wins over a setting
#          --from copies),
#          --yes (no questions; defaults or the given values; the secrets of --from are still asked when not piped in).
# Safe to run again: every step checks what is already done. Full guide: deploy/vps/README.md.
set -euo pipefail

# the live server's game domain: a record under elymum.io, kept from before the rename (its DNS record and certificate
# exist; game.coinnibal.fun needs a new A record first, README "DNS")
DOMAIN_DEFAULT="game.elymum.io"
REPO_DEFAULT="https://github.com/furkan3152/Solagel.git"  # public repo: no deploy key needed (an SSH URL still works for a private one)
BRANCH_DEFAULT="main"
# The live server's installed names, kept from before the rename (Elymum, November 2026); changing them moves the
# data. The same literals as deploy/vps/lib.sh (this file runs before the checkout exists; it sources lib.sh after),
# and the host files below (journald, unattended-upgrades, fail2ban, sysctl, the deploy key and its ssh config block).
DIR="/opt/elymum"
STATE="/var/lib/elymum"
LOCK="/run/lock/elymum.lock"
KEY="/root/.ssh/elymum_deploy"
# GitHub's published SSH host key (docs.github.com → "GitHub's SSH key fingerprints")
GITHUB_ED25519_FP="SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"

domain=""
repo=""
branch=""
restore_file=""
restore_url=""
restore_token=""
restore_proof=""
from_url=""
sets=()
yes=0

# a persistent journal (survives reboots, 2 GB at most): Docker's journald log driver keeps the server log there,
# so it survives a redeploy (a new container) too. Idempotent.
host_journald() {
  mkdir -p /var/log/journal /etc/systemd/journald.conf.d
  local conf=/etc/systemd/journald.conf.d/elymum.conf want
  want=$'[Journal]\nStorage=persistent\nSystemMaxUse=2G\nMaxRetentionSec=1month'
  if [[ "$(cat "$conf" 2>/dev/null)" != "$want" ]]; then
    printf '%s\n' "$want" >"$conf"
    systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1 || true
    systemctl restart systemd-journald || true
  fi
}

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() {
  printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) domain="${2:?--domain needs a value}"; shift 2 ;;
    --repo) repo="${2:?--repo needs a value}"; shift 2 ;;
    --branch) branch="${2:?--branch needs a value}"; shift 2 ;;
    --restore) restore_file="$(readlink -f "${2:?--restore needs a file}")"; shift 2 ;;
    --restore-url) restore_url="${2:?--restore-url needs a value}"; shift 2 ;;
    --from) from_url="${2:?--from needs the old server URL}"; restore_url="$from_url"; shift 2 ;;
    --token | --proof) die "$1 is not taken on the command line (any local user can read it in ps): leave it out and paste the value at the prompt, or send the token and the proof on stdin, one per line (see --help)" ;;
    --set) [[ "${2:-}" =~ ^[A-Z][A-Z0-9_]*=[^[:space:]]*$ ]] || die "--set needs KEY=VALUE (no spaces)"; sets+=("$2"); shift 2 ;;
    --yes | -y) yes=1; shift ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || die "run this as root: sudo -i, then bash install.sh"
[[ -z "$restore_file" || -s "$restore_file" ]] || die "backup file not found: $restore_file"
[[ -z "$restore_file" || -z "$restore_url" ]] || die "use --restore or --restore-url, not both"
[[ -z "$restore_url" || "$restore_url" == https://* ]] || die "--from and --restore-url need an https:// URL (the token and the proof must not travel in clear): $restore_url"

# read_secret VAR "label": a secret (the admin session token, a signed proof) never comes from a command line, which
# any local user can read in ps: a hidden prompt on a terminal, else one line of stdin. Whitespace is dropped (the
# values hold none; a paste may add some). The same function as deploy/vps/lib.sh (not checked out yet here).
read_secret() {
  local __v=""
  if [[ -t 0 ]]; then
    read -rsp "$2: " __v || true
    echo >&2
  else
    IFS= read -r __v || true
  fi
  printf -v "$1" '%s' "${__v//[[:space:]]/}"
}
# both now, while someone is at the keyboard (the build takes minutes)
if [[ -n "$restore_url" ]]; then
  [[ -t 0 || "$yes" -eq 1 ]] || die "the token and the proof on stdin need --yes (the installer's other questions read the terminal)"
  read_secret restore_token "Admin session token"
  read_secret restore_proof "Signed proof (X-Coinnibal-Proof, purpose migration or backup)"
  [[ -n "$restore_token" && -n "$restore_proof" ]] || die "the admin session token and the proof are both needed (README \"Moving to another VPS\")"
fi

# shellcheck disable=SC1091
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" || ! "${VERSION_ID:-}" =~ ^(22\.04|24\.04)$ ]]; then
  note "warning: tested on Ubuntu 22.04 and 24.04; this is ${PRETTY_NAME:-unknown}"
fi

ask() { # ask VAR "question" default
  local __var="$1" __q="$2" __def="$3" __ans=""
  if [[ -n "${!__var}" ]]; then return 0; fi
  if [[ "$yes" -eq 1 ]]; then
    printf -v "$__var" '%s' "$__def"
    return 0
  fi
  read -rp "$__q [$__def]: " __ans
  printf -v "$__var" '%s' "${__ans:-$__def}"
}
ask domain "Game server domain" "$DOMAIN_DEFAULT"
ask repo "Repository (SSH URL)" "$REPO_DEFAULT"
ask branch "Branch to run" "$BRANCH_DEFAULT"
[[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || die "not a domain name: $domain"

mkdir -p "$STATE" "$(dirname "$LOCK")"
exec 9>"$LOCK"
flock -w 600 9 || die "another Coinnibal job (update or backup) is running; try again in a few minutes"
export COINNIBAL_LOCK_HELD=1

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
APT_OPTS=(-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

say "1/10 System update"
apt-get update -q
apt-get "${APT_OPTS[@]}" upgrade
apt-get "${APT_OPTS[@]}" install ca-certificates curl gnupg git ufw fail2ban python3-systemd unattended-upgrades nano openssh-client

say "2/10 Docker Engine (Docker's official apt repository)"
if ! docker compose version >/dev/null 2>&1 || ! dpkg -s docker-ce >/dev/null 2>&1; then
  for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
    if dpkg -s "$pkg" >/dev/null 2>&1; then apt-get "${APT_OPTS[@]}" remove "$pkg"; fi
  done
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get "${APT_OPTS[@]}" install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  note "already installed: $(docker --version)"
fi
if [[ ! -f /etc/docker/daemon.json ]]; then
  mkdir -p /etc/docker
  cat >/etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
JSON
  systemctl restart docker 2>/dev/null || true
fi
systemctl enable --now docker >/dev/null

say "3/10 Automatic security updates"
# Ubuntu's own origins only (the default Allowed-Origins): Docker's repository is left out on purpose, since an engine
# update restarts dockerd and every container mid-round; elymum-reboot.timer upgrades the engine in a round break
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
# a kernel update needs a reboot: never by unattended-upgrades itself (it would cut a round); elymum-reboot.timer
# reboots at 04:30 in the break after an arena bell, only when the update asks for it
cat >/etc/apt/apt.conf.d/52elymum-unattended <<'CONF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF
# the server log survives a redeploy (Docker's journald log driver) and a reboot (persistent journal)
host_journald
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

say "4/10 Firewall (SSH, HTTP, HTTPS)"
# every port sshd listens on (22 unless changed), so enabling the firewall never locks you out
mapfile -t ssh_ports < <(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' || true)
for p in 22 "${ssh_ports[@]}"; do ufw allow "$p/tcp" >/dev/null; done
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
note "$(ufw status | head -n 1)"

say "5/10 fail2ban for SSH"
cat >/etc/fail2ban/jail.d/elymum-sshd.local <<'CONF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
CONF
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban || note "warning: fail2ban did not start (check: journalctl -u fail2ban)"

say "6/10 Memory and network tuning"
mem_kb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
if [[ "$mem_kb" -lt 4000000 ]] && [[ -z "$(swapon --show --noheadings 2>/dev/null)" ]]; then
  note "RAM below 4 GB and no swap: adding a 2 GB swapfile"
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
else
  note "swap not needed (RAM $((mem_kb / 1024)) MB, or swap already on)"
fi
cat >/etc/sysctl.d/99-elymum.conf <<'CONF'
# Coinnibal: many concurrent WebSocket connections
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 8192
net.core.netdev_max_backlog = 16384
fs.file-max = 1048576
net.ipv4.ip_local_port_range = 10240 65535
net.ipv4.tcp_fin_timeout = 15
# notice dead connections (closed laptops, lost mobile signal) within a few minutes
net.ipv4.tcp_keepalive_time = 120
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 4
# SYN floods: answer with cookies once the backlog fills; drop spoofed sources
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
vm.swappiness = 10
CONF
sysctl --system >/dev/null

say "7/10 Deploy key and code ($branch)"
install -d -m 700 /root/.ssh
if [[ ! -f "$KEY" ]]; then
  ssh-keygen -q -t ed25519 -N "" -C "coinnibal-vps-$(hostname)" -f "$KEY"
fi
if ! grep -q 'elymum deploy key' /root/.ssh/config 2>/dev/null; then
  cat >>/root/.ssh/config <<CONF

# elymum deploy key (read-only)
Host github.com
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
CONF
  chmod 600 /root/.ssh/config
fi
if ! ssh-keygen -F github.com >/dev/null 2>&1; then
  scan="$(mktemp)"
  ssh-keyscan -t ed25519 github.com 2>/dev/null >"$scan"
  fp="$(ssh-keygen -lf "$scan" | awk '{ print $2 }')"
  [[ "$fp" == "$GITHUB_ED25519_FP" ]] || die "github.com's SSH key fingerprint is $fp, expected $GITHUB_ED25519_FP; refusing to trust it"
  cat "$scan" >>/root/.ssh/known_hosts
  rm -f "$scan"
fi
repo_path="$(sed -E 's#^(git@github\.com:|ssh://git@github\.com/|https://github\.com/)##; s#\.git$##' <<<"$repo")"
until git ls-remote --exit-code "$repo" "refs/heads/$branch" >/dev/null 2>&1; do
  [[ "$yes" -eq 0 ]] || die "the deploy key cannot read $repo (branch $branch). Add it on GitHub and run again"
  echo
  echo "------------------------------------------------------------------------------"
  echo " This server needs read access to the repository. Add this deploy key:"
  echo
  echo "   1. Open https://github.com/$repo_path/settings/keys"
  echo "      (GitHub → the repository → Settings → Deploy keys)"
  echo "   2. Click \"Add deploy key\". Title: coinnibal-vps"
  echo "   3. Key: paste the whole line below"
  echo "   4. Leave \"Allow write access\" UNCHECKED, then click \"Add key\""
  echo
  cat "$KEY.pub"
  echo "------------------------------------------------------------------------------"
  read -rp "Press Enter once the key is added (Ctrl+C to stop)... " _
  if ! git ls-remote --exit-code "$repo" "refs/heads/$branch" >/dev/null 2>&1; then
    echo "Still no access (or the branch \"$branch\" does not exist). Check the key and the branch name."
  fi
done
mkdir -p "$DIR"
cd "$DIR" || exit 1
if [[ ! -d .git ]]; then
  git init -q
  git remote add origin "$repo"
else
  git remote set-url origin "$repo"
fi
git fetch -q origin "$branch"
git checkout -q -B "$branch" "origin/$branch"
git reset -q --hard "origin/$branch"
echo "$branch" >"$STATE/branch"
chmod +x deploy/vps/*.sh
note "code at $(git log -1 --format='%h %s')"
# shellcheck source=lib.sh
. "$DIR/deploy/vps/lib.sh"

say "8/10 Settings ($COINNIBAL_ENV)"
if [[ ! -f "$COINNIBAL_ENV" ]]; then
  install -m 600 deploy/vps/env.example "$COINNIBAL_ENV"
  created=1
else
  created=0
fi
chmod 600 "$COINNIBAL_ENV"
env_set GAME_DOMAIN "$domain"
if [[ -n "$from_url" ]]; then
  note "copying the settings from $from_url"
  envjson="$(mktemp)"
  chmod 600 "$envjson"
  hdr="$(mktemp)"
  chmod 600 "$hdr"
  # the token and the proof stay off every command line (other users can read those in ps; printf is a shell
  # builtin): read above, they reach curl through this 0600 header file, and restore.sh through its stdin (step 9).
  # --proto: HTTPS only
  printf 'Authorization: Bearer %s\nX-Coinnibal-Proof: %s\n' "$restore_token" "$restore_proof" >"$hdr"
  curl -fsS --proto '=https' --max-time 30 -H @"$hdr" "${from_url%/}/api/admin/migration-env" -o "$envjson" \
    || { rm -f "$hdr"; die "could not read the settings from $from_url (expired token or proof? a proof opens it once, within 10 minutes)"; }
  rm -f "$hdr"
  # one KEY<TAB>VALUE line per setting; values never hold a newline (the server drops those). The chain settings go
  # to the COINNIBAL_* keys docker-compose.yml reads (it ignores CHAIN_ID, EVM_RPC_URL(S) and RPC_MAX_RPS in .env)
  old_single_rpc=""
  have_rpc_list=0
  while IFS=$'\t' read -r k v; do
    [[ "$k" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
    case "$k" in
      CHAIN_ID) env_set COINNIBAL_CHAIN_ID "$v" ;;
      EVM_RPC_URLS) env_set COINNIBAL_RPC_URLS "$v"; have_rpc_list=1 ;;
      EVM_RPC_URL) old_single_rpc="$v" ;;
      RPC_MAX_RPS) env_set COINNIBAL_RPC_MAX_RPS "$v" ;;
      # never the site's contract pins or its owner wallet (docker-compose.yml build args): they change only in this
      # shell, so a broken-into old server cannot pick what the new build trusts. The server never sends them (MIGRATED
      # in backup.ts)
      COINNIBAL_PIN_* | ELYMUM_PIN_* | COINNIBAL_OWNER_WALLET | VITE_*) continue ;;
      # Caddy's config (Caddyfile.cloudflare behind Cloudflare): only a file of this checkout's deploy/vps/caddy, by
      # its plain name (Caddy reads /etc/caddy/<it>; never a path out of that folder)
      CADDY_CONFIG)
        if [[ "$v" =~ ^Caddyfile(\.[A-Za-z0-9_-]+)?$ && -f "deploy/vps/caddy/$v" ]]; then
          env_set CADDY_CONFIG "$v"
        else
          note "the old server's CADDY_CONFIG is not a Caddy configuration of deploy/vps/caddy; not copied (Caddyfile stays)"
        fi ;;
      *) env_set "$k" "$v" ;;
    esac
  done < <(python3 -I -c 'import json,sys; [print(k + "\t" + str(v)) for k, v in json.load(open(sys.argv[1]))["env"].items()]' "$envjson")
  # an older server with one RPC only
  if [[ "$have_rpc_list" -eq 0 && -n "$old_single_rpc" ]]; then env_set COINNIBAL_RPC_URLS "$old_single_rpc"; fi
  direct="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("directUrl") or "")' "$envjson")"
  if [[ "$direct" =~ ^https://[A-Za-z0-9.-]+$ ]]; then
    restore_url="$direct"
    note "the backup comes straight from $direct"
  fi
  rm -f "$envjson"
  # this host's own values (never copied): the site's origin for CORS (the server always adds the brand's own sites)
  env_set CORS_ORIGIN "https://coinnibal.fun"
  note "settings copied ($(grep -c '=' "$COINNIBAL_ENV") lines in $COINNIBAL_ENV)"
fi
# --set last: the owner's own values win over the ones --from copied (--set CADDY_CONFIG=Caddyfile.cloudflare on a
# move behind Cloudflare, README section 9)
for kv in "${sets[@]}"; do
  env_set "${kv%%=*}" "${kv#*=}"
done
edit_env() {
  echo
  echo " The settings file opens in the nano editor. Fill in the values (deploy/vps/README.md section 4:"
  echo " ADMIN_WALLETS, AUTH_SECRET, COINNIBAL_CHAIN_ID, COINNIBAL_RPC_URLS, TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, ...)."
  echo " Save: Ctrl+O then Enter. Quit: Ctrl+X."
  read -rp " Press Enter to open it... " _
  nano "$COINNIBAL_ENV"
}
if [[ "$yes" -eq 0 ]]; then
  if [[ "$created" -eq 1 ]]; then
    edit_env
  else
    read -rp "Settings file exists. Edit it now? [y/N] " a
    if [[ "$a" =~ ^[Yy] ]]; then edit_env; fi
  fi
  while :; do
    missing=()
    # the chain (COINNIBAL_CHAIN_ID, COINNIBAL_RPC_URLS) has testnet defaults in docker-compose.yml: not asked for here
    for k in ADMIN_WALLETS PUBLIC_URL CORS_ORIGIN; do
      [[ -n "$(env_get "$k")" ]] || missing+=("$k")
    done
    if [[ "${#missing[@]}" -eq 0 ]]; then break; fi
    echo "Empty in .env: ${missing[*]}"
    read -rp "Edit again? [Y/n] " a
    if [[ "$a" =~ ^[Nn] ]]; then break; fi
    nano "$COINNIBAL_ENV"
  done
fi
chmod 600 "$COINNIBAL_ENV"
[[ -n "$(env_get PUBLIC_URL)" ]] || die "PUBLIC_URL is empty in $COINNIBAL_ENV (the server refuses to start without it)"

say "9/10 Build and start (the first build takes a few minutes)"
# --pull: the newest base image, whatever an earlier install left on this host
dc build --pull app
if [[ -n "$restore_file" ]]; then
  note "restoring $restore_file into the data volume before the first start"
  "$DIR/deploy/vps/restore.sh" --yes --no-start "$restore_file"
elif [[ -n "$restore_url" ]]; then
  note "downloading and restoring the backup from $restore_url before the first start"
  # the secrets on restore.sh's stdin, one per line (never its arguments)
  printf '%s\n%s\n' "$restore_token" "$restore_proof" | "$DIR/deploy/vps/restore.sh" --yes --no-start --url "$restore_url"
fi
dc up -d --remove-orphans
# the commit, the image it runs on (the weekly refresh rebuilds only that one) and the time
record_deployed "$(git rev-parse HEAD)"
rm -f "$STATE/failed" "$STATE/postponed"

say "10/10 Auto-deploy, daily backups, shortcuts"
install -m 644 deploy/vps/systemd/*.service deploy/vps/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now "$INSTALLED_UNIT_PREFIX-update.timer" "$INSTALLED_UNIT_PREFIX-backup.timer" "$INSTALLED_UNIT_PREFIX-alert.timer" "$INSTALLED_UNIT_PREFIX-reboot.timer" "$INSTALLED_UNIT_PREFIX-refresh.timer" >/dev/null
link_commands
note "commands: coinnibal-status, coinnibal-compose logs -f app, coinnibal-backup, coinnibal-restore, coinnibal-update"
grep -qxF 'backups/' .git/info/exclude 2>/dev/null || echo 'backups/' >>.git/info/exclude

echo
note "waiting for https://$domain/api/health (Caddy gets the certificate on the first request; up to 5 minutes)"
ok=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://$domain/api/health?live=1" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 5
done
if [[ "$ok" -eq 1 ]]; then
  printf '\n\033[1;32mCoinnibal is running at https://%s\033[0m\n' "$domain"
  curl -sS "https://$domain/api/health" || true
  echo
  note "Status any time: coinnibal-status. New commits on $branch deploy by themselves within 2 minutes."
else
  printf '\n\033[1;33mThe server is installed, but https://%s/api/health does not answer yet.\033[0m\n' "$domain"
  note "This server's addresses: $(hostname -I 2>/dev/null)"
  note "DNS for $domain: $(getent ahostsv4 "$domain" 2>/dev/null | awk 'NR == 1 { print $1 }')"
  note "The DNS A record must point at this server (and not through a CDN proxy). Logs:"
  dc ps || true
  dc logs --tail 30 caddy app || true
  note "Fix the cause, then run this installer again (it is safe to re-run)."
  exit 1
fi
if [[ -f /var/run/reboot-required ]]; then
  note "The system update wants a reboot; elymum-reboot.timer does it at 04:30 in a round break (or now: coinnibal-reboot)"
fi
