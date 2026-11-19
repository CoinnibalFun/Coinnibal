#!/usr/bin/env bash
# Coinnibal at a glance: containers and health, CPU / memory, the deployed commit, the last backup, disk.
#   coinnibal-status (the same script as elymum-status and deploy/vps/status.sh)
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root

section() { printf '\n== %s ==\n' "$1"; }

domain="$(env_get GAME_DOMAIN)"
section "Containers"
dc ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' 2>/dev/null || dc ps

section "CPU / memory"
mapfile -t ids < <(dc ps -q 2>/dev/null)
if [[ "${#ids[@]}" -gt 0 ]]; then
  docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}' "${ids[@]}"
else
  echo "no containers running"
fi

section "Public health check"
if [[ -n "$domain" ]]; then
  # 200: fine; 503: something needs a person (the reasons are in the answer: journal, settlements, RPC, gas, books)
  if out="$(curl -sS --max-time 8 -w '\nHTTP %{http_code}' "https://$domain/api/health" 2>&1)"; then
    echo "https://$domain/api/health -> $out"
  else
    echo "https://$domain/api/health FAILED: $out"
  fi
else
  echo "GAME_DOMAIN is not set in $COINNIBAL_ENV"
fi

section "Deploy"
cd "$COINNIBAL_DIR" || exit 1
echo "branch:   $(cat "$COINNIBAL_STATE/branch" 2>/dev/null || git rev-parse --abbrev-ref HEAD)"
deployed="$(cat "$COINNIBAL_STATE/deployed" 2>/dev/null || true)"
if [[ -n "$deployed" ]]; then
  echo "deployed: $(git log -1 --format='%h %s (%cr)' "$deployed" 2>/dev/null || echo "$deployed") at $(cat "$COINNIBAL_STATE/deployed-at" 2>/dev/null || echo '?')"
else
  echo "deployed: (nothing recorded yet)"
fi
if [[ -s "$COINNIBAL_STATE/failed" ]]; then
  echo "LAST BUILD FAILED for $(cut -c1-12 "$COINNIBAL_STATE/failed"): journalctl -u $INSTALLED_UNIT_PREFIX-update -n 200"
fi
echo "auto-deploy: $(systemctl is-active "$INSTALLED_UNIT_PREFIX-update.timer" 2>/dev/null || true) (next: $(systemctl show "$INSTALLED_UNIT_PREFIX-update.timer" -p NextElapseUSecRealtime --value 2>/dev/null || echo '?'))"
echo "rollback image: $(docker image inspect -f '{{.Created}}' "${COINNIBAL_IMAGE%:*}:previous" 2>/dev/null || echo none) (commit $(cut -c1-12 "$COINNIBAL_STATE/previous" 2>/dev/null || echo '?'))"
echo "alerts: $(systemctl is-active "$INSTALLED_UNIT_PREFIX-alert.timer" 2>/dev/null || true); Telegram $([[ -n "$(env_get TELEGRAM_BOT_TOKEN)" && -n "$(env_get TELEGRAM_CHAT_ID)" ]] && echo on || echo 'off (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set)')"
echo "reboots, Docker Engine updates: $(systemctl is-active "$INSTALLED_UNIT_PREFIX-reboot.timer" 2>/dev/null || true) (in a round break at 04:30 when due; $([[ -f /var/run/reboot-required ]] && echo 'a reboot is due' || echo 'no reboot due'); engine $(docker version -f '{{.Server.Version}}' 2>/dev/null || echo '?'))"
echo "weekly image rebuild: $(systemctl is-active "$INSTALLED_UNIT_PREFIX-refresh.timer" 2>/dev/null || true) (next: $(systemctl show "$INSTALLED_UNIT_PREFIX-refresh.timer" -p NextElapseUSecRealtime --value 2>/dev/null || echo '?')$(systemctl is-active --quiet "$INSTALLED_UNIT_PREFIX-update.timer" 2>/dev/null || echo '; skipped while auto-deploy is paused'))"

section "Backups"
last="$(find "$COINNIBAL_BACKUPS" -maxdepth 1 -type f -name "$INSTALLED_BACKUP_GLOB" -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2-)"
if [[ -n "$last" ]]; then
  echo "last:  $(basename "$last") ($(du -h "$last" | cut -f1), $(date -r "$last" '+%F %R'))"
else
  echo "last:  none yet"
fi
echo "count: $(find "$COINNIBAL_BACKUPS" -maxdepth 1 -type f -name "$INSTALLED_BACKUP_GLOB" 2>/dev/null | wc -l)"
echo "timer: $(systemctl is-active "$INSTALLED_UNIT_PREFIX-backup.timer" 2>/dev/null || true)"

section "Disk"
df -h / | tail -n 1 | awk '{ print "root: " $3 " used of " $2 " (" $5 ")" }'
docker system df 2>/dev/null || true

section "Recent server log (last 15 lines)"
dc logs --no-color --tail 15 app 2>/dev/null || true
