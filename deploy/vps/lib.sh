# shellcheck shell=bash
# Shared settings of the Elymum VPS scripts (sourced, not run).

ELYMUM_DIR="${ELYMUM_DIR:-/opt/elymum}"
ELYMUM_ENV="${ELYMUM_ENV:-$ELYMUM_DIR/.env}"
ELYMUM_COMPOSE="$ELYMUM_DIR/deploy/vps/docker-compose.yml"
ELYMUM_BACKUPS="${ELYMUM_BACKUPS:-$ELYMUM_DIR/backups}"
ELYMUM_STATE="/var/lib/elymum"
ELYMUM_LOCK="/run/lock/elymum.lock"
ELYMUM_VOLUME="elymum-data"
ELYMUM_IMAGE="elymum-app:latest"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# docker compose with the project's file and .env (for ${GAME_DOMAIN})
dc() {
  docker compose -f "$ELYMUM_COMPOSE" --env-file "$ELYMUM_ENV" "$@"
}

# value of KEY in the .env file (empty when unset)
env_get() {
  local key="$1"
  [[ -f "$ELYMUM_ENV" ]] || return 0
  sed -n "s/^${key}=//p" "$ELYMUM_ENV" | tail -n 1 | sed -e "s/^['\"]//" -e "s/['\"]$//"
}

# sets KEY=VALUE in the .env file (replaces the line, or appends it)
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "$ELYMUM_ENV.XXXXXX")"
  if grep -q "^${key}=" "$ELYMUM_ENV" 2>/dev/null; then
    awk -v k="$key" -v v="$value" 'BEGIN { FS = OFS = "=" } $1 == k { print k "=" v; next } { print }' "$ELYMUM_ENV" >"$tmp"
  else
    cat "$ELYMUM_ENV" >"$tmp" 2>/dev/null || true
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ELYMUM_ENV"
}

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

# Waits for the break after an arena bell. Rounds are aligned to Unix time: one cycle is ROUND_SECONDS of play
# (default 300) plus the ROUND_BREAK_SECONDS break after its bell (default 30; unset, at most a tenth of the play;
# set, at most the play), so the slots are [n x cycle, (n + 1) x cycle) and each starts with the break: the bell
# rings at a multiple of the cycle and the floor reopens ROUND_BREAK_SECONDS later (apps/server/src/config.ts
# parseRoundConfig, packages/shared/src/rounds.ts roundAt). Stopping the server there finds no live stake (every
# ticket was just settled at the bell); anywhere else SIGTERM cashes every arena player out mid-round.
# ELYMUM_DEPLOY_NOW=1 skips the wait (an urgent fix).
wait_for_round_break() {
  [[ "${ELYMUM_DEPLOY_NOW:-0}" == "1" ]] && return 0
  local round brk cycle s last
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

need_root() {
  [[ "$(id -u)" -eq 0 ]] || die "run this as root (sudo -i first)"
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
    log "warning: $file does not look like an Elymum data directory (no server-key.json, chains/, site/ ...)"
}
