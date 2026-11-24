# shellcheck shell=bash
# Shared settings of the Coinnibal VPS scripts (sourced, not run).

# The live server's installed names, kept from before the rename (Elymum, November 2026); changing them moves the
# data. A new Docker project name would mean a new, empty volume (the game's data would seem lost) and a port clash
# with the running container; the units, the lock, the state directory, the backups and the commands were installed
# under these names. docker-compose.yml (name, image, volumes, log tag) and systemd/*.service|timer (the file names
# and their ExecStart paths) use the same literals.
INSTALLED_DIR="/opt/elymum"
INSTALLED_PROJECT="elymum"
INSTALLED_STATE="/var/lib/elymum"
INSTALLED_LOCK="/run/lock/elymum.lock"
INSTALLED_VOLUME="elymum-data"
INSTALLED_IMAGE="elymum-app:latest"
# systemd units elymum-<job>.service|timer and the commands /usr/local/bin/elymum-<job> (coinnibal-<job> links too)
INSTALLED_UNIT_PREFIX="elymum"
# backups: elymum-data-YYYYmmdd-HHMM.tar.gz here and offsite (restore.sh and status.sh find the old ones by it)
INSTALLED_BACKUP_GLOB="elymum-data-*.tar.gz"
INSTALLED_BACKUP_PREFIX="elymum-data-"
# host settings install.sh wrote (update.sh rewrites them in place); install.sh, which runs before this checkout
# exists, carries the same literals
INSTALLED_JOURNALD_CONF="/etc/systemd/journald.conf.d/elymum.conf"
INSTALLED_APT_CONF="/etc/apt/apt.conf.d/52elymum-unattended"

# Overrides from the environment: the COINNIBAL_* name wins, the ELYMUM_* name of before the rename still works.
COINNIBAL_DIR="${COINNIBAL_DIR:-${ELYMUM_DIR:-$INSTALLED_DIR}}"
COINNIBAL_ENV="${COINNIBAL_ENV:-${ELYMUM_ENV:-$COINNIBAL_DIR/.env}}"
COINNIBAL_COMPOSE="$COINNIBAL_DIR/deploy/vps/docker-compose.yml"
COINNIBAL_BACKUPS="${COINNIBAL_BACKUPS:-${ELYMUM_BACKUPS:-$COINNIBAL_DIR/backups}}"
COINNIBAL_STATE="$INSTALLED_STATE"
COINNIBAL_LOCK="$INSTALLED_LOCK"
COINNIBAL_VOLUME="$INSTALLED_VOLUME"
COINNIBAL_IMAGE="$INSTALLED_IMAGE"
# set by a job that already holds the lock for the scripts it runs (install.sh, restore.sh)
COINNIBAL_LOCK_HELD="${COINNIBAL_LOCK_HELD:-${ELYMUM_LOCK_HELD:-0}}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# docker compose with the project's file and .env (for ${GAME_DOMAIN}, and the COINNIBAL_* keys, which
# docker-compose.yml reads with the ELYMUM_* key of before the rename as the fallback)
dc() {
  docker compose -f "$COINNIBAL_COMPOSE" --env-file "$COINNIBAL_ENV" "$@"
}

# the ID of an image (empty when it is not on this host)
image_id() {
  docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true
}

# the image ID the app container runs (empty: no app container running), as image_id gives it, so the two compare
app_image() {
  local cid img id
  cid="$(dc ps -q app 2>/dev/null)"
  [[ -n "$cid" ]] || return 0
  img="$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true)"
  [[ -n "$img" ]] || return 0
  id="$(image_id "$img")"
  printf '%s\n' "${id:-$img}"
}

# records COMMIT as deployed, with the image put in for it (deployed-image: the one elymum-app:latest names now). The
# weekly refresh rebuilds only that image, so one put back by hand (README "Rollback") stays until the next deploy
record_deployed() {
  echo "$1" >"$COINNIBAL_STATE/deployed"
  image_id "$COINNIBAL_IMAGE" >"$COINNIBAL_STATE/deployed-image"
  date -u +%FT%TZ >"$COINNIBAL_STATE/deployed-at"
}

# value of KEY in the .env file (empty when unset)
env_get() {
  local key="$1"
  [[ -f "$COINNIBAL_ENV" ]] || return 0
  sed -n "s/^${key}=//p" "$COINNIBAL_ENV" | tail -n 1 | sed -e "s/^['\"]//" -e "s/['\"]$//"
}

# value of the renamed .env key COINNIBAL_<NAME>; when it is unset or empty, the ELYMUM_<NAME> key of before the
# rename (a live .env keeps working unchanged)
env_get_renamed() {
  local v
  v="$(env_get "COINNIBAL_$1")"
  [[ -n "$v" ]] || v="$(env_get "ELYMUM_$1")"
  printf '%s' "$v"
}

# sets KEY=VALUE in the .env file (replaces the line, or appends it)
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "$COINNIBAL_ENV.XXXXXX")"
  if grep -q "^${key}=" "$COINNIBAL_ENV" 2>/dev/null; then
    awk -v k="$key" -v v="$value" 'BEGIN { FS = OFS = "=" } $1 == k { print k "=" v; next } { print }' "$COINNIBAL_ENV" >"$tmp"
  else
    cat "$COINNIBAL_ENV" >"$tmp" 2>/dev/null || true
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$COINNIBAL_ENV"
}

# a persistent journal (survives reboots, 2 GB at most): Docker's journald log driver keeps the server log there,
# so it survives a redeploy (a new container) too. Idempotent.
host_journald() {
  mkdir -p /var/log/journal /etc/systemd/journald.conf.d
  local conf="$INSTALLED_JOURNALD_CONF" want
  want=$'[Journal]\nStorage=persistent\nSystemMaxUse=2G\nMaxRetentionSec=1month'
  if [[ "$(cat "$conf" 2>/dev/null)" != "$want" ]]; then
    printf '%s\n' "$want" >"$conf"
    systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1 || true
    systemctl restart systemd-journald || true
  fi
}

# how long a deploy or reboot waits at most for the open paid ticket rooms to end (wait_for_round_break): 70 min, a
# room of the longest duration (60 min) opened just before plus its close. The units' TimeoutStartSec and the other
# jobs' lock waits leave room for it
PAID_ROOM_WAIT_S="${PAID_ROOM_WAIT_S:-4200}"

# the end (Unix ms) of the last paid ticket room open in the running app (/api/health `paidRooms.endsAt`, asked inside
# the container: the app port is not published); empty when none is open or the app does not answer
paid_rooms_until() {
  local cid
  cid="$(dc ps -q app 2>/dev/null || true)"
  [[ -n "$cid" ]] || return 0
  docker exec "$cid" node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>r.json()).then(j=>process.stdout.write(String(j.paidRooms&&j.paidRooms.endsAt||''))).catch(()=>{})" 2>/dev/null || true
}

# Waits for the break after an arena bell. Rounds are aligned to Unix time: one cycle is ROUND_SECONDS of play
# (default 300) plus the ROUND_BREAK_SECONDS break after its bell (default 30; unset, at most a tenth of the play;
# set, at most the play), so the slots are [n x cycle, (n + 1) x cycle) and each starts with the break: the bell
# rings at a multiple of the cycle and the floor reopens ROUND_BREAK_SECONDS later (apps/server/src/config.ts
# parseRoundConfig, packages/shared/src/rounds.ts roundAt). Stopping the server there finds no live stake (every
# ticket was just settled at the bell; first the open paid ticket rooms, on their own clock, are waited out);
# anywhere else SIGTERM cashes every arena player out mid-round.
# COINNIBAL_DEPLOY_NOW=1 skips the wait (an urgent fix; ELYMUM_DEPLOY_NOW=1 of before the rename too).
wait_for_round_break() {
  [[ "${COINNIBAL_DEPLOY_NOW:-${ELYMUM_DEPLOY_NOW:-0}}" == "1" ]] && return 0
  local round brk cycle s last until_ms deadline=$((SECONDS + PAID_ROOM_WAIT_S))
  # a paid ticket room plays ONE game on its own clock (up to an hour): an arena break is no break for it, and SIGTERM
  # would cash its players out mid-game. Wait until the last open one has ended (its own bell settles its tickets), at
  # most PAID_ROOM_WAIT_S, then for the arena break as usual
  while until_ms="$(paid_rooms_until)" && [[ "$until_ms" =~ ^[0-9]+$ ]] && ((until_ms + 15000 > $(date +%s) * 1000)); do
    if ((SECONDS >= deadline)); then
      log "a paid ticket room still plays after $((PAID_ROOM_WAIT_S / 60)) min of waiting; going on (its players are paid their current value)"
      break
    fi
    log "a paid ticket room plays until $(date -u -d "@$((until_ms / 1000))" +%T 2>/dev/null || echo "$until_ms") UTC; waiting for its end"
    sleep 15
  done
  round="$(env_get ROUND_SECONDS)"
  [[ "$round" =~ ^[0-9]+$ ]] || round=300
  ((round < 2)) && round=2
  brk="$(env_get ROUND_BREAK_SECONDS)"
  if [[ "$brk" =~ ^[0-9]+$ ]]; then
    ((brk > round)) && brk=$round
  else
    brk=30
    ((brk > round / 10)) && brk=$((round / 10))
  fi
  cycle=$((round + brk))
  # the swap must fit in the break with a margin; otherwise go right after the bell
  last=$((brk - 8))
  ((last < 2)) && last=2
  for _ in $(seq 1 $((cycle * 2 + 10))); do
    s=$(($(date +%s) % cycle))
    if ((s >= 2 && s <= last)); then
      log "in the break after the bell (${s} s into the ${cycle} s round cycle)"
      return 0
    fi
    sleep 0.5
  done
  log "no round break found in time; going on anyway"
}

# Sends a message to the owner's Telegram (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env; both optional: without
# them the message only goes to the journal). The token never appears on a command line (curl reads it from stdin).
notify() {
  local text="$1" token chat
  log "ALERT: $text"
  token="$(env_get TELEGRAM_BOT_TOKEN)"
  chat="$(env_get TELEGRAM_CHAT_ID)"
  [[ -n "$token" && -n "$chat" ]] || return 0
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
    curl -sS --max-time 15 -K - --data-urlencode "chat_id=$chat" --data-urlencode "text=[$(hostname -s)] $text" \
      --data-urlencode "disable_web_page_preview=true" -o /dev/null || log "telegram: sending failed"
}

# the commands /usr/local/bin/elymum-<job> (the installed names) and coinnibal-<job> next to them: the same scripts
link_commands() {
  local s target
  for s in status compose backup restore update alert reboot; do
    target="$COINNIBAL_DIR/deploy/vps/$s.sh"
    # a link that cannot be written never stops a deploy (the scripts run by their path too)
    [[ "$(readlink "/usr/local/bin/$INSTALLED_UNIT_PREFIX-$s" 2>/dev/null)" == "$target" ]] || ln -sf "$target" "/usr/local/bin/$INSTALLED_UNIT_PREFIX-$s" 2>/dev/null || true
    [[ "$(readlink "/usr/local/bin/coinnibal-$s" 2>/dev/null)" == "$target" ]] || ln -sf "$target" "/usr/local/bin/coinnibal-$s" 2>/dev/null || true
  done
}

need_root() {
  [[ "$(id -u)" -eq 0 ]] || die "run this as root (sudo -i first)"
}

# read_secret VAR "label": a secret (the admin session token, a signed proof) never comes from a command line, which
# any local user can read in ps: a hidden prompt on a terminal, else one line of stdin (install.sh pipes them in).
# Whitespace is dropped (the values hold none; a paste may add some). install.sh carries the same function.
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

# checks that a .tar.gz is complete and holds only relative paths inside the archive
verify_backup() {
  local file="$1" listing
  [[ -s "$file" ]] || die "backup file $file is missing or empty"
  gzip -t "$file" 2>/dev/null || die "$file is not a complete gzip file (truncated download?)"
  listing="$(tar tzf "$file" 2>/dev/null)" || die "$file is not a readable tar archive"
  if grep -Eq '^/|(^|/)\.\.(/|$)' <<<"$listing"; then
    die "$file contains absolute or '..' paths; refusing it"
  fi
  grep -Eq '^(\./)?(server-key\.json|auth-secret|chains/|site/|profiles|leaderboards)' <<<"$listing" ||
    log "warning: $file does not look like a Coinnibal data directory (no server-key.json, chains/, site/ ...)"
}
