#!/usr/bin/env bash
# Coinnibal alert job (elymum-alert.timer, every minute; safe to run by hand). Posts to the owner's Telegram
# (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env; without them the alerts only go to the journal) when:
#   - the server logged a line starting with "!!!" (an unreadable journal, a vault short, no gas, a wrong server key...)
#   - /api/health answers 503 (its reasons: the journal cannot be written, settlements backed up or stuck, the RPC
#     unreachable, the server key's gas runway under 2 days, the books guard, the clock off the chain's)
#   - the gas runway is under 7 days (a warning)
#   - a disk is more than 80 % full
#   - the app container is not running, or its liveness check failed ("unhealthy")
#   - the Caddy container (HTTPS in front of the app) is not running, or restarted since the last run (a crash loop)
# Each alert repeats at most every 30 minutes while it lasts (a "!!!" line: once per distinct line an hour), and an
# "ok again" follows when it clears.
#
# Autoheal: a container whose liveness check (/api/health?live=1, the process answers at all) failed on 3 runs in a
# row is restarted. A server that only waits on the RPC, or whose disk is full, stays live: a restart fixes neither.
# Output goes to journald: journalctl -u elymum-alert -n 50
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root

STATE_DIR="$COINNIBAL_STATE/alerts"
mkdir -p "$STATE_DIR"
now="$(date +%s)"
REPEAT_S=1800

# raise KEY TEXT: alerts once, then at most every REPEAT_S while the condition lasts
raise() {
  local key="$1" text="$2" f="$STATE_DIR/$1"
  if [[ -f "$f" ]] && ((now - $(stat -c %Y "$f") < REPEAT_S)); then return 0; fi
  touch "$f"
  notify "$text"
}
# clear KEY TEXT: the condition is gone (says so once)
clear_alert() {
  local key="$1" text="$2" f="$STATE_DIR/$1"
  [[ -f "$f" ]] || return 0
  rm -f "$f"
  notify "ok again: $text"
}

cid="$(dc ps -q app 2>/dev/null || true)"

# --- the container: running, live
if [[ -z "$cid" ]] || [[ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" != "true" ]]; then
  raise app-down "the app container is not running (coinnibal-status; journalctl -u $INSTALLED_UNIT_PREFIX-update -n 50)"
  echo 0 >"$STATE_DIR/unhealthy-runs"
else
  clear_alert app-down "the app container runs"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo unknown)"
  runs="$(cat "$STATE_DIR/unhealthy-runs" 2>/dev/null || echo 0)"
  if [[ "$health" == "unhealthy" ]]; then
    runs=$((runs + 1))
    echo "$runs" >"$STATE_DIR/unhealthy-runs"
    if ((runs >= 3)); then
      notify "the app does not answer its liveness check for 3 minutes: restarting it (autoheal)"
      dc restart -t 45 app || notify "autoheal: restart failed"
      echo 0 >"$STATE_DIR/unhealthy-runs"
    else
      raise app-unhealthy "the app's liveness check fails ($runs/3 before an automatic restart)"
    fi
  else
    echo 0 >"$STATE_DIR/unhealthy-runs"
    clear_alert app-unhealthy "the app's liveness check passes"
  fi

  # --- /api/health with its reasons (inside the container: the app port is not published)
  out="$(docker exec "$cid" node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(async r=>{process.stdout.write(r.status+'\n'+await r.text())}).catch(e=>{process.stdout.write('000\n'+e.message)})" 2>/dev/null || echo "000")"
  code="$(head -n 1 <<<"$out")"
  body="$(tail -n +2 <<<"$out")"
  if [[ "$code" == "200" ]]; then
    clear_alert health "/api/health is ok"
  else
    reasons="$(python3 -I -c 'import json,sys
try: print("; ".join(json.loads(sys.stdin.read()).get("reasons", [])) or "no answer")
except Exception: print("no answer")' <<<"$body")"
    raise health "/api/health $code: $reasons"
  fi
  # --- gas runway: a warning under 7 days (under 2 the health check above already alerts)
  level="$(python3 -I -c 'import json,sys
try: g=json.loads(sys.stdin.read()).get("gas") or {}; print(g.get("level","") + " " + str(g.get("days")))
except Exception: print("")' <<<"$body")"
  if [[ "$level" == warn* ]]; then
    raise gas-warn "the server key's gas runway is under 7 days (${level#warn } days at the last day's spend): top it up"
  elif [[ "$level" == ok* ]]; then
    clear_alert gas-warn "the server key's gas runway is over 7 days"
  fi

  # --- "!!!" lines since the last run (each distinct line at most once an hour)
  since="$(cat "$STATE_DIR/log-since" 2>/dev/null || echo $((now - 70)))"
  echo "$now" >"$STATE_DIR/log-since"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    msg="${line#*!!! }"
    key="log-$(printf '%s' "${msg:0:120}" | sed -E 's/[0-9a-fA-Fx]{8,}//g; s/[0-9]+/N/g' | md5sum | cut -c1-16)"
    f="$STATE_DIR/$key"
    if [[ -f "$f" ]] && ((now - $(stat -c %Y "$f") < 3600)); then continue; fi
    touch "$f"
    notify "server: !!! ${msg:0:400}"
  done < <(docker logs --since "$since" "$cid" 2>&1 | grep -F '!!!' | tail -n 20)
fi

# --- Caddy: without it nothing reaches the app (the site, the game, the sign-ins). It must run and keep its restart
# count from one run to the next: under restart: unless-stopped a crash-looping Caddy is "running" between restarts
ccid="$(dc ps -a -q caddy 2>/dev/null || true)"
cstatus=""
crestarts=""
if [[ -n "$ccid" ]]; then
  cstatus="$(docker inspect -f '{{.State.Status}}' "$ccid" 2>/dev/null || true)"
  crestarts="$(docker inspect -f '{{.RestartCount}}' "$ccid" 2>/dev/null || true)"
fi
clast="$(cat "$STATE_DIR/caddy-restarts" 2>/dev/null || true)"
printf '%s %s\n' "$ccid" "$crestarts" >"$STATE_DIR/caddy-restarts"
if [[ "$cstatus" != "running" ]]; then
  raise caddy-down "the Caddy container is ${cstatus:-missing}: the site and the game cannot be reached (coinnibal-compose logs --tail 50 caddy; coinnibal-compose up -d caddy)"
elif [[ -n "$clast" && "${clast%% *}" == "$ccid" && "${clast#* }" != "$crestarts" ]]; then
  raise caddy-down "the Caddy container restarted since the last check (restart count ${clast#* } -> $crestarts): a crash loop takes the site and the game down (coinnibal-compose logs --tail 50 caddy)"
else
  clear_alert caddy-down "the Caddy container runs"
fi

# --- disks: the root filesystem and Docker's
while read -r pct mount; do
  pct="${pct%\%}"
  [[ "$pct" =~ ^[0-9]+$ ]] || continue
  key="disk-$(printf '%s' "$mount" | md5sum | cut -c1-8)"
  if ((pct > 80)); then
    raise "$key" "disk $mount is ${pct} % full: free space (docker system prune, old backups); at 100 % the server stops seating arena tickets"
  else
    clear_alert "$key" "disk $mount is ${pct} % full"
  fi
done < <(df --output=pcent,target / /var/lib/docker 2>/dev/null | tail -n +2 | sort -u -k2)

# old "!!!" markers go
find "$STATE_DIR" -maxdepth 1 -name 'log-*' -type f -mmin +180 -delete 2>/dev/null || true
