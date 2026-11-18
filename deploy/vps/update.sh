#!/usr/bin/env bash
# Coinnibal auto-deploy (run by elymum-update.timer every 2 minutes; safe to run by hand).
# When the tracked branch moved on GitHub: reset to it, build the new image while the old container keeps
# serving, then swap the container in the break after an arena bell (the server pays out live stake players on
# SIGTERM; in the break there are none). A commit whose build fails is not retried until a newer commit arrives;
# the old container keeps running meanwhile.
#
# Only commits CI passed: when the CI marker tag ci-green-<branch> exists (CI pushes it after every green run on
# the branch, .github/workflows/ci.yml), the newest commit it marks is deployed, never a newer untested one.
# COINNIBAL_REQUIRE_CI=1 in .env (ELYMUM_REQUIRE_CI=1 of before the rename still counts) refuses to deploy at all
# without the marker (a private repository's CI status is not readable from here without a GitHub token; the marker
# comes through the same git fetch as the code).
#
# Rollback: the running image is tagged elymum-app:previous before the build; when the new container is not
# healthy (the liveness check, /api/health?live=1) within 60 s, the previous image and commit are put back at once.
# Output goes to journald: journalctl -u elymum-update -n 100
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root

mkdir -p "$COINNIBAL_STATE" "$(dirname "$COINNIBAL_LOCK")"
exec 9>"$COINNIBAL_LOCK"
if ! flock -n 9; then
  log "another Coinnibal job (update, backup or install) is running; skipping this check"
  exit 0
fi

cd "$COINNIBAL_DIR" || exit 1
# the coinnibal-* commands next to the installed elymum-* ones (a server installed before the rename gets them here)
link_commands
branch="$(cat "$COINNIBAL_STATE/branch" 2>/dev/null || git rev-parse --abbrev-ref HEAD)"
[[ -n "$branch" && "$branch" != "HEAD" ]] || die "no branch recorded in $COINNIBAL_STATE/branch"
PREVIOUS_IMAGE="${COINNIBAL_IMAGE%:*}:previous"
HEALTHY_WITHIN_S=60

app_running() {
  [[ -n "$(dc ps --status running -q app 2>/dev/null)" ]]
}

app_health() {
  local cid
  cid="$(dc ps -q app 2>/dev/null)"
  [[ -n "$cid" ]] || {
    echo "missing"
    return 0
  }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo "unknown"
}

# waits up to $1 seconds for the app container's liveness check; prints the last status
wait_healthy() {
  local status="starting" t
  for t in $(seq 1 "$1"); do
    status="$(app_health)"
    [[ "$status" == "healthy" ]] && break
    sleep 1
  done
  echo "$status"
}

# installs the systemd units of this checkout when they differ from the installed ones, and enables new timers
sync_units() {
  local changed=0 unit
  for unit in "$COINNIBAL_DIR"/deploy/vps/systemd/*.service "$COINNIBAL_DIR"/deploy/vps/systemd/*.timer; do
    if ! cmp -s "$unit" "/etc/systemd/system/$(basename "$unit")"; then
      install -m 644 "$unit" /etc/systemd/system/
      changed=1
    fi
  done
  if [[ "$changed" -eq 1 ]]; then
    systemctl daemon-reload
    log "systemd units updated"
  fi
  for timer in "$INSTALLED_UNIT_PREFIX-alert.timer" "$INSTALLED_UNIT_PREFIX-reboot.timer"; do
    [[ -f "/etc/systemd/system/$timer" ]] && ! systemctl is-enabled --quiet "$timer" 2>/dev/null && systemctl enable --now "$timer" >/dev/null 2>&1 && log "$timer enabled"
  done
  return 0
}

# the host settings later versions rely on (idempotent): no automatic reboot by unattended-upgrades (coinnibal-reboot
# does it in a round break), a persistent journal for Docker's journald log driver
host_upgrade() {
  local conf="$INSTALLED_APT_CONF"
  if grep -q 'Automatic-Reboot "true"' "$conf" 2>/dev/null; then
    printf '%s\n' 'Unattended-Upgrade::Automatic-Reboot "false";' 'Unattended-Upgrade::Remove-Unused-Dependencies "true";' >"$conf"
    log "unattended-upgrades no longer reboots by itself ($INSTALLED_UNIT_PREFIX-reboot.timer does, in a round break)"
  fi
  host_journald
}

if ! timeout 120 git fetch --quiet origin "$branch" "+refs/tags/ci-green-$branch:refs/tags/ci-green-$branch" 2>/dev/null; then
  if ! timeout 120 git fetch --quiet origin "$branch"; then
    log "git fetch failed (network or deploy key); will retry at the next check"
    exit 0
  fi
fi
head="$(git rev-parse "origin/$branch")"
remote="$head"
if green="$(git rev-parse -q --verify "refs/tags/ci-green-$branch^{commit}" 2>/dev/null)"; then
  # the newest commit CI passed on the branch (the marker can be ahead of a fetch race: then the head is green)
  if git merge-base --is-ancestor "$green" "$head" 2>/dev/null; then
    remote="$green"
  elif git merge-base --is-ancestor "$head" "$green" 2>/dev/null; then
    remote="$head"
  else
    log "the CI marker ci-green-$branch is not on $branch; nothing is deployed until CI passes on it"
    exit 0
  fi
elif [[ "$(env_get_renamed REQUIRE_CI)" == "1" ]]; then
  log "COINNIBAL_REQUIRE_CI=1 and no CI marker ci-green-$branch: not deploying ${head:0:12} (see README \"Deploys\")"
  exit 0
fi
deployed="$(cat "$COINNIBAL_STATE/deployed" 2>/dev/null || true)"
failed="$(cat "$COINNIBAL_STATE/failed" 2>/dev/null || true)"

if [[ "$remote" == "$deployed" ]]; then
  [[ "$head" != "$remote" ]] && [[ ! -f "$COINNIBAL_STATE/waiting-ci" || "$(cat "$COINNIBAL_STATE/waiting-ci")" != "$head" ]] && {
    echo "$head" >"$COINNIBAL_STATE/waiting-ci"
    log "${head:0:12} on $branch waits for CI (deployed: the last green commit ${remote:0:12})"
  }
  # nothing new; make sure the stack is up (self-healing after a manual stop or a crash loop)
  if ! app_running; then
    log "app container is not running; starting the stack"
    dc up -d || log "docker compose up failed"
  fi
  exit 0
fi
if [[ "$remote" == "$failed" ]]; then
  exit 0
fi

log "new commit on $branch: ${deployed:0:12} -> ${remote:0:12} ($(git log -1 --format=%s "$remote" | cut -c1-80))"
git reset --hard --quiet "$remote"

# the image now serving becomes the rollback target
if docker image inspect "$COINNIBAL_IMAGE" >/dev/null 2>&1; then
  docker tag "$COINNIBAL_IMAGE" "$PREVIOUS_IMAGE"
  [[ -n "$deployed" ]] && echo "$deployed" >"$COINNIBAL_STATE/previous"
fi

log "building the new image (the old container keeps serving)"
if ! dc build app; then
  echo "$remote" >"$COINNIBAL_STATE/failed"
  [[ -n "$deployed" ]] && git reset --hard --quiet "$deployed"
  log "BUILD FAILED for ${remote:0:12}; the previous version keeps running. It is retried when a newer commit arrives."
  notify "build failed for ${remote:0:12} ($(git log -1 --format=%s "$remote" 2>/dev/null | cut -c1-60)); the previous version keeps running"
  exit 0
fi

wait_for_round_break

log "swapping the app container (players reconnect in a few seconds)"
if ! dc up -d --remove-orphans; then
  echo "$remote" >"$COINNIBAL_STATE/failed"
  log "docker compose up failed for ${remote:0:12}"
fi

status="$(wait_healthy "$HEALTHY_WITHIN_S")"
if [[ "$status" != "healthy" ]]; then
  # the new version does not come up: the previous image and commit go back at once (no round-break wait: the arenas
  # are down anyway)
  echo "$remote" >"$COINNIBAL_STATE/failed"
  if docker image inspect "$PREVIOUS_IMAGE" >/dev/null 2>&1 && [[ -n "$deployed" ]]; then
    log "ROLLBACK: ${remote:0:12} is $status after ${HEALTHY_WITHIN_S} s; putting ${deployed:0:12} back"
    git reset --hard --quiet "$deployed"
    docker tag "$PREVIOUS_IMAGE" "$COINNIBAL_IMAGE"
    dc up -d --remove-orphans || log "docker compose up of the previous version failed"
    status="$(wait_healthy "$HEALTHY_WITHIN_S")"
    notify "deploy of ${remote:0:12} rolled back (it was not healthy within ${HEALTHY_WITHIN_S} s); ${deployed:0:12} is $status again"
  else
    notify "deploy of ${remote:0:12} is $status after ${HEALTHY_WITHIN_S} s and there is no previous image to roll back to"
  fi
  exit 0
fi

# the Caddyfile changed: reload Caddy (no restart, certificates kept)
if [[ -z "$deployed" ]] || ! git diff --quiet "$deployed" "$remote" -- deploy/vps/caddy 2>/dev/null; then
  caddy_config="$(env_get CADDY_CONFIG)"
  if dc exec -T caddy caddy reload --config "/etc/caddy/${caddy_config:-Caddyfile}" >/dev/null 2>&1; then
    log "Caddy configuration reloaded"
  fi
fi
sync_units
host_upgrade

echo "$remote" >"$COINNIBAL_STATE/deployed"
rm -f "$COINNIBAL_STATE/failed" "$COINNIBAL_STATE/waiting-ci"
date -u +%FT%TZ >"$COINNIBAL_STATE/deployed-at"
log "deployed ${remote:0:12}; app is $status"

# keep the disk clean: dangling images of earlier builds, build cache older than a week (elymum-app:previous stays)
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
