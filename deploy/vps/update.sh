#!/usr/bin/env bash
# Coinnibal auto-deploy (run by elymum-update.timer every 2 minutes; safe to run by hand).
# When the tracked branch moved on GitHub: reset to it, build the new image while the old container keeps
# serving, then swap the container in the break after an arena bell (the server pays out live stake players on
# SIGTERM; in the break there are none). A commit whose build fails is not retried until a newer commit arrives;
# the old container keeps running meanwhile. A commit is recorded as deployed only once its app container runs:
# one that needs an image this host does not have and cannot pull now (a Caddy tag Dependabot bumped, the registry
# down) waits, the old version serving, and every check tries it again.
#
# Only commits CI passed: when the CI marker tag ci-green-<branch> exists (CI pushes it after every green run on
# the branch, .github/workflows/ci.yml), the newest commit it marks is deployed, never a newer untested one.
# COINNIBAL_REQUIRE_CI=1 in .env (ELYMUM_REQUIRE_CI=1 of before the rename still counts) refuses to deploy at all
# without the marker (a private repository's CI status is not readable from here without a GitHub token; the marker
# comes through the same git fetch as the code).
#
# Rollback: before a deploy's build the running image is tagged elymum-app:previous (its commit in
# /var/lib/elymum/previous); when the new container is not healthy (the liveness check, /api/health?live=1) within
# 60 s, the previous image and commit are put back at once. The weekly refresh has a rollback image of its own
# (elymum-app:refresh-rollback, the build it replaces, removed once the new one is healthy) and never moves :previous,
# which so stays the version before the last deploy (README "Rollback": the way back by hand).
# Caddy: after every swap its container must run with a steady restart count and, when it answered before, answer
# through HTTPS again. Otherwise its image of before is put back (the new build is tried again at the next pull), and
# when that does not bring it up either, the whole deploy is rolled back as above. An alert goes out either way.
#
# Security fixes of the images: every build pulls the newest base image (--pull: node:22-bookworm-slim, its Debian
# and Node patches) and the Caddy image of docker-compose.yml (a pinned patch version; Dependabot proposes newer ones,
# .github/dependabot.yml). `update.sh --refresh` does the same without a new commit: it rebuilds the deployed commit,
# never a newer one (it fetches nothing: new code comes only through this check), and swaps the app and/or Caddy in
# the round break, only when an image changed. elymum-refresh.timer runs it weekly with --scheduled: then it is
# skipped while auto-deploy is paused (elymum-update.timer stopped); by hand it always runs. It rebuilds only the image
# a deploy put in (recorded with the commit, /var/lib/elymum/deployed-image): an image put back by hand (README
# "Rollback") stays until the next deploy, and the refresh says so instead.
# Output goes to journald: journalctl -u elymum-update -n 100 (the refresh: -u elymum-refresh)
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root

refresh=0
scheduled=0
for arg in "$@"; do
  case "$arg" in
    --refresh) refresh=1 ;;
    --scheduled) scheduled=1 ;;
    *) die "unknown argument: $arg (update.sh, or update.sh --refresh)" ;;
  esac
done
[[ "$scheduled" -eq 0 || "$refresh" -eq 1 ]] || die "--scheduled goes with --refresh (elymum-refresh.service)"

mkdir -p "$COINNIBAL_STATE" "$(dirname "$COINNIBAL_LOCK")"
exec 9>"$COINNIBAL_LOCK"
if [[ "$refresh" -eq 1 ]]; then
  # the weekly refresh waits its turn (skipped, it would wait a whole week)
  flock -w 7200 9 || die "another Coinnibal job held the lock for 2 hours; no refresh now"
elif ! flock -n 9; then
  log "another Coinnibal job (update, backup or install) is running; skipping this check"
  exit 0
fi

cd "$COINNIBAL_DIR" || exit 1
# the coinnibal-* commands next to the installed elymum-* ones (a server installed before the rename gets them here)
link_commands
branch="$(cat "$COINNIBAL_STATE/branch" 2>/dev/null || git rev-parse --abbrev-ref HEAD)"
[[ -n "$branch" && "$branch" != "HEAD" ]] || die "no branch recorded in $COINNIBAL_STATE/branch"
PREVIOUS_IMAGE="${COINNIBAL_IMAGE%:*}:previous"
# the weekly refresh's rollback target: the build it replaces (never :previous, the way back past the last deploy)
REFRESH_ROLLBACK_IMAGE="${COINNIBAL_IMAGE%:*}:refresh-rollback"
HEALTHY_WITHIN_S=60
# Caddy is up once its restart count held over this many checks a second apart (a crash loop under restart:
# unless-stopped restarts it sooner), within CADDY_UP_WITHIN_S checks (caddy_up)
CADDY_STEADY_CHECKS=5
CADDY_UP_WITHIN_S=30

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

# the running Caddy container and its restart count ("<id>:<count>"; empty while none runs, between two restarts too)
caddy_state() {
  local cid
  cid="$(dc ps --status running -q caddy 2>/dev/null || true)"
  [[ -n "$cid" ]] || return 0
  printf '%s:%s' "$cid" "$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || echo '?')"
}

# a request through Caddy on this host (HTTPS on 443, as players come in) reaches the app's liveness check. The
# certificate is not checked: this tests that Caddy serves, not the certificate (the request never leaves the host)
caddy_serves() {
  local domain
  domain="$(env_get GAME_DOMAIN)"
  [[ -n "$domain" ]] || return 1
  curl -fsS -k -o /dev/null --max-time 5 --resolve "$domain:443:127.0.0.1" "https://$domain/api/health?live=1" >/dev/null 2>&1
}

# Caddy is up: its container runs with the same restart count over CADDY_STEADY_CHECKS checks and, when $1 is 1 (it
# answered before the swap), a request through it answers. Gives up after CADDY_UP_WITHIN_S checks, or twice as many
# seconds (a probe that hangs)
caddy_up() {
  local served="$1" seen="" now steady=0 deadline=$((SECONDS + 2 * CADDY_UP_WITHIN_S))
  for _ in $(seq 1 "$CADDY_UP_WITHIN_S"); do
    ((SECONDS < deadline)) || break
    now="$(caddy_state)"
    if [[ -n "$now" && "$now" == "$seen" ]]; then
      steady=$((steady + 1))
    else
      steady=0
      seen="$now"
    fi
    if ((steady >= CADDY_STEADY_CHECKS)) && { [[ "$served" -eq 0 ]] || caddy_serves; }; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# the Caddy image docker-compose.yml of the checkout names (caddy:<patch version>)
caddy_ref() {
  local ref
  ref="$(dc config --images caddy 2>/dev/null | grep -m 1 '^caddy:' || true)"
  [[ -n "$ref" ]] || ref="$(sed -n 's/^[[:space:]]*image:[[:space:]]*["'\'']\{0,1\}\(caddy:[^"'\''[:space:]]*\).*$/\1/p' "$COINNIBAL_COMPOSE" | head -n 1)"
  printf '%s' "$ref"
}

# the refresh's rollback image is done with (a deploy drops one an interrupted refresh left too). Only that tag goes:
# an image that holds another one as well (elymum-app:latest, :previous) stays
drop_refresh_rollback() {
  docker image rm "$REFRESH_ROLLBACK_IMAGE" >/dev/null 2>&1 || true
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
  for timer in "$INSTALLED_UNIT_PREFIX-alert.timer" "$INSTALLED_UNIT_PREFIX-reboot.timer" "$INSTALLED_UNIT_PREFIX-refresh.timer"; do
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

deployed="$(cat "$COINNIBAL_STATE/deployed" 2>/dev/null || true)"
failed="$(cat "$COINNIBAL_STATE/failed" 2>/dev/null || true)"

# same=1: the refresh, of the deployed commit only. A newer commit, CI-green or not, is this check's alone, so a paused
# auto-deploy keeps it off the server: the refresh fetches nothing and builds what runs now.
same=0
if [[ "$refresh" -eq 1 ]]; then
  [[ -n "$deployed" ]] || {
    log "nothing deployed yet; no refresh"
    exit 0
  }
  # the lock is held: a reboot.sh that paused the timers for an engine upgrade has started them again
  if [[ "$scheduled" -eq 1 ]] && ! systemctl is-active --quiet "$INSTALLED_UNIT_PREFIX-update.timer" 2>/dev/null; then
    log "auto-deploy is paused ($INSTALLED_UNIT_PREFIX-update.timer stopped), and the weekly rebuild with it; by hand: coinnibal-update --refresh"
    exit 0
  fi
  # only the image a deploy put in for the commit is rebuilt. Another one (a rollback by hand: README "Rollback") is
  # left as it is: rebuilding the deployed commit would put back the version the owner took off
  deployed_image="$(cat "$COINNIBAL_STATE/deployed-image" 2>/dev/null || true)"
  if [[ -z "$deployed_image" ]]; then
    log "no record yet of the image deployed for ${deployed:0:12} (every deploy writes it, and the first check after one); no refresh"
    exit 0
  fi
  running_image="$(app_image)"
  if [[ "$(image_id "$COINNIBAL_IMAGE")" != "$deployed_image" || (-n "$running_image" && "$running_image" != "$deployed_image") ]]; then
    notify "weekly rebuild skipped: the app image is not the one deployed for ${deployed:0:12} (put back by hand?); it stays until the next deploy"
    exit 0
  fi
  remote="$deployed"
  same=1
else
  # The working repository moves to CoinnibalFun/coinnibal-core (private) and CoinnibalFun/Coinnibal becomes a public
  # copy with its own history: once coinnibal-core answers, origin (any earlier name of the repository) points there
  # for good.
  origin_url="$(git remote get-url origin 2>/dev/null || true)"
  origin_lc="${origin_url,,}"
  if [[ "$origin_lc" =~ [:/](coinnibalfun/coinnibal|furkan3152/solagel)(\.git)?/?$ ]] && timeout 60 git ls-remote --exit-code --heads git@github.com:CoinnibalFun/coinnibal-core.git "$branch" >/dev/null 2>&1; then
    git remote set-url origin git@github.com:CoinnibalFun/coinnibal-core.git
    log "origin moved: $origin_url -> git@github.com:CoinnibalFun/coinnibal-core.git"
  fi
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
fi
# a commit that does not descend from the deployed one (a rewritten history, or a remote that is not this server's
# repository) is never deployed on its own: COINNIBAL_ALLOW_UNRELATED=1 in .env lets one through by hand
if [[ "$same" -eq 0 && -n "$deployed" && "$remote" != "$deployed" ]] && git cat-file -e "$deployed^{commit}" 2>/dev/null \
  && ! git merge-base --is-ancestor "$deployed" "$remote" 2>/dev/null && [[ "$(env_get_renamed ALLOW_UNRELATED)" != "1" ]]; then
  if [[ "$(cat "$COINNIBAL_STATE/unrelated" 2>/dev/null)" != "$remote" ]]; then
    echo "$remote" >"$COINNIBAL_STATE/unrelated"
    notify "not deploying ${remote:0:12}: it does not descend from the deployed ${deployed:0:12} (rewritten history or wrong remote?); set COINNIBAL_ALLOW_UNRELATED=1 to deploy it"
  fi
  log "${remote:0:12} does not descend from the deployed ${deployed:0:12}: not deploying"
  exit 0
fi
# the refresh of the deployed commit never marks it failed (a newer failed commit stays marked)
mark_failed() {
  [[ "$same" -eq 1 ]] && return 0
  echo "$remote" >"$COINNIBAL_STATE/failed"
  rm -f "$COINNIBAL_STATE/postponed"
}
# the images docker-compose.yml names that are not on this host, the app's own aside (it is built here). docker
# compose up pulls a missing one first and, with the registry unreachable, fails before it swaps anything
missing_images() {
  local images img out=""
  images="$(dc config --images 2>/dev/null || true)"
  # a compose without that flag: the image: lines of the file (literal names)
  [[ -n "$images" ]] || images="$(sed -n 's/^[[:space:]]*image:[[:space:]]*//p' "$COINNIBAL_COMPOSE" | tr -d "\"'")"
  for img in $images; do
    [[ "$img" == "$COINNIBAL_IMAGE" ]] && continue
    docker image inspect "$img" >/dev/null 2>&1 || out+="${out:+ }$img"
  done
  printf '%s' "$out"
}
# $1 (an image this deploy needs) is not on this host and cannot be pulled now: the checkout goes back to the deployed
# commit (whose images are here) and the commit is not marked failed, so every check tries it again (one alert per
# commit). The refresh just stops (retried next week)
postpone() {
  if [[ -n "$deployed" ]]; then git reset --hard --quiet "$deployed"; fi
  if [[ "$same" -eq 1 ]]; then
    notify "the weekly refresh of ${remote:0:12} stopped: $1 is not on this host and could not be pulled; the running version keeps serving (retried next week)"
    exit 0
  fi
  log "$1 is not on this host and could not be pulled (registry unreachable?): ${remote:0:12} waits for a later check; ${deployed:0:12} keeps serving"
  if [[ "$(cat "$COINNIBAL_STATE/postponed" 2>/dev/null)" != "$remote" ]]; then
    echo "$remote" >"$COINNIBAL_STATE/postponed"
    notify "deploy of ${remote:0:12} waits: $1 is not on this host and could not be pulled (registry unreachable?); ${deployed:0:12} keeps serving, and every check tries again"
  fi
  exit 0
}
# the running Caddy container is on an older image than the one its tag names now (after `dc pull caddy`)
caddy_stale() {
  local cid
  cid="$(dc ps -q caddy 2>/dev/null)"
  [[ -n "$cid" ]] || return 0
  [[ "$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null)" != "$(image_id "$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null)")" ]]
}
# the app image on the newest base image (--pull); a deploy whose pull fails (the registry down) builds once more
# with the base images on this host, so an outage there never blocks a fix
build_app() {
  dc build --pull app && return 0
  [[ "$same" -eq 0 ]] || return 1
  log "the build with --pull failed (registry unreachable?); building with the base images on this host"
  dc build app
}

if [[ "$same" -eq 0 && "$remote" == "$deployed" ]]; then
  [[ "$head" != "$remote" ]] && [[ ! -f "$COINNIBAL_STATE/waiting-ci" || "$(cat "$COINNIBAL_STATE/waiting-ci")" != "$head" ]] && {
    echo "$head" >"$COINNIBAL_STATE/waiting-ci"
    log "${head:0:12} on $branch waits for CI (deployed: the last green commit ${remote:0:12})"
  }
  # nothing new; make sure the stack is up (self-healing after a manual stop or a crash loop)
  if ! app_running; then
    log "app container is not running; starting the stack"
    dc up -d || log "docker compose up failed"
  fi
  # the image deployed for the commit, on a server whose last deploy ran an update.sh of before that record (the
  # weekly refresh needs it): what runs now, when the tag names it too and its container is the one that deploy
  # started (created before deployed-at; a container put in by hand later stays unrecorded, and so unrefreshed)
  if [[ ! -s "$COINNIBAL_STATE/deployed-image" ]]; then
    running_image="$(app_image)"
    created="$(docker inspect -f '{{.Created}}' "$(dc ps -q app 2>/dev/null)" 2>/dev/null || true)"
    deployed_at="$(cat "$COINNIBAL_STATE/deployed-at" 2>/dev/null || true)"
    created_s="" deployed_s=""
    [[ -z "$created" ]] || created_s="$(date -d "$created" +%s 2>/dev/null || true)"
    [[ -z "$deployed_at" ]] || deployed_s="$(date -d "$deployed_at" +%s 2>/dev/null || true)"
    if [[ -n "$running_image" && "$running_image" == "$(image_id "$COINNIBAL_IMAGE")" ]] &&
      [[ "$created_s" =~ ^[0-9]+$ && "$deployed_s" =~ ^[0-9]+$ ]] && ((created_s <= deployed_s)); then
      echo "$running_image" >"$COINNIBAL_STATE/deployed-image"
    fi
  fi
  # once per deployed commit, its units installed and its timers on: the deploy that brought a new one ran the
  # update.sh of before it (so a server installed earlier gets the weekly refresh timer here)
  if [[ "$(cat "$COINNIBAL_STATE/units-synced" 2>/dev/null)" != "$deployed" ]]; then
    sync_units
    echo "$deployed" >"$COINNIBAL_STATE/units-synced"
  fi
  exit 0
fi
if [[ "$same" -eq 0 && "$remote" == "$failed" ]]; then
  exit 0
fi

if [[ "$same" -eq 1 ]]; then
  log "weekly refresh of ${remote:0:12}: rebuilding on the newest base image and pulling Caddy"
else
  log "new commit on $branch: ${deployed:0:12} -> ${remote:0:12} ($(git log -1 --format=%s "$remote" | cut -c1-80))"
fi
git reset --hard --quiet "$remote"

# Caddy as it runs before the pull: its image and the tag it was made from (put back when the swap breaks it), and its
# restart count (the same after the build: it was up, and must be up after the swap)
caddy_before="" caddy_before_ref=""
caddy_before_state="$(caddy_state)"
if [[ -n "$caddy_before_state" ]]; then
  caddy_before="$(docker inspect -f '{{.Image}}' "${caddy_before_state%%:*}" 2>/dev/null || true)"
  caddy_before_ref="$(docker inspect -f '{{.Config.Image}}' "${caddy_before_state%%:*}" 2>/dev/null || true)"
fi
# Caddy: the newest build of its pinned tag (the swap below recreates it, in the break, when the image changed). A tag
# new to this host (a Dependabot bump) must be here before anything is built or swapped
dc pull --quiet caddy || log "could not pull the Caddy image; the one on this host stays"
missing="$(missing_images)"
[[ -z "$missing" ]] || postpone "$missing"

# the image now serving becomes the rollback target: a deploy's elymum-app:previous (with its commit), the refresh's
# own elymum-app:refresh-rollback (tagged below, once its build changed the image), so :previous keeps the commit
# before the last deploy
before="$(image_id "$COINNIBAL_IMAGE")"
if [[ "$same" -eq 0 && -n "$before" ]]; then
  docker tag "$COINNIBAL_IMAGE" "$PREVIOUS_IMAGE"
  [[ -n "$deployed" ]] && echo "$deployed" >"$COINNIBAL_STATE/previous"
fi
rollback_image="$PREVIOUS_IMAGE"
[[ "$same" -eq 0 ]] || rollback_image="$REFRESH_ROLLBACK_IMAGE"

log "building the new image (the old container keeps serving)"
if ! build_app; then
  if [[ "$same" -eq 1 ]]; then
    notify "the weekly rebuild of ${remote:0:12} failed; the running version keeps serving (journalctl -u $INSTALLED_UNIT_PREFIX-refresh)"
    exit 0
  fi
  mark_failed
  [[ -n "$deployed" ]] && git reset --hard --quiet "$deployed"
  log "BUILD FAILED for ${remote:0:12}; the previous version keeps running. It is retried when a newer commit arrives."
  notify "build failed for ${remote:0:12} ($(git log -1 --format=%s "$remote" 2>/dev/null | cut -c1-60)); the previous version keeps running"
  exit 0
fi

app_changed=1
if [[ "$same" -eq 1 ]]; then
  [[ "$(image_id "$COINNIBAL_IMAGE")" != "$before" ]] || app_changed=0
  if [[ "$app_changed" -eq 0 ]] && ! caddy_stale; then
    log "weekly refresh: the app image and Caddy are already the newest; nothing to swap"
    exit 0
  fi
  if [[ "$app_changed" -eq 1 && -n "$before" ]]; then
    docker tag "$before" "$REFRESH_ROLLBACK_IMAGE"
  fi
fi

# Caddy was up all along (the same container and restart count as before the pull), and whether a request through
# it answers: the swap must leave it so (an older fault is alert.sh's, not this deploy's)
caddy_was_up=0
caddy_served=0
if [[ -n "$caddy_before_state" && "$(caddy_state)" == "$caddy_before_state" ]]; then
  caddy_was_up=1
  if caddy_serves; then caddy_served=1; fi
fi

wait_for_round_break

log "swapping the app container (players reconnect in a few seconds)"
up_failed=0
if ! dc up -d --remove-orphans; then
  up_failed=1
  log "docker compose up failed for ${remote:0:12}"
fi
# The app container runs another image than the one just built: compose stopped before it swapped the app (an image
# it could not pull, an error of the daemon). The old container serves on. Its image goes back to the tag and its
# commit to the checkout (a later compose up, the self-heal of the 2-minute check or a restore, starts what runs), and
# the new commit is not recorded as deployed: retried at every check when an image was missing, else when a newer
# commit arrives (as a failed build)
running_image="$(app_image)"
if [[ -n "$running_image" && "$running_image" != "$(image_id "$COINNIBAL_IMAGE")" ]]; then
  if [[ -n "$before" ]]; then docker tag "$before" "$COINNIBAL_IMAGE"; fi
  [[ "$same" -eq 0 ]] || drop_refresh_rollback
  missing="$(missing_images)"
  [[ -z "$missing" ]] || postpone "$missing"
  if [[ -n "$deployed" ]]; then git reset --hard --quiet "$deployed"; fi
  if [[ "$same" -eq 1 ]]; then
    notify "the weekly rebuild of ${remote:0:12} was not swapped in (docker compose up failed); the running version keeps serving (retried next week)"
  else
    mark_failed
    notify "deploy of ${remote:0:12} failed: docker compose up did not swap the app in; ${deployed:0:12} keeps serving. It is retried when a newer commit arrives (journalctl -u $INSTALLED_UNIT_PREFIX-update)"
  fi
  exit 0
fi

status="$(wait_healthy "$HEALTHY_WITHIN_S")"
if [[ "$status" != "healthy" ]]; then
  # the new version does not come up: the previous image and commit go back at once (no round-break wait: the arenas
  # are down anyway)
  mark_failed
  if [[ "$app_changed" -eq 0 ]]; then
    # only Caddy was refreshed: the app's image is the one that ran before, nothing to roll back
    notify "after the weekly Caddy refresh the app is $status (its image did not change)"
  elif docker image inspect "$rollback_image" >/dev/null 2>&1 && [[ -n "$deployed" ]]; then
    log "ROLLBACK: ${remote:0:12} is $status after ${HEALTHY_WITHIN_S} s; putting ${deployed:0:12} back"
    # the record of the deployed commit's image stays as it is: this puts that image back (or the one a rollback by
    # hand had put in, which stays unrecorded, so the weekly refresh keeps leaving it alone). The refresh puts back
    # the build it replaced, from its own tag: elymum-app:previous stays the commit before the last deploy
    git reset --hard --quiet "$deployed"
    docker tag "$rollback_image" "$COINNIBAL_IMAGE"
    dc up -d --remove-orphans || log "docker compose up of the previous version failed"
    status="$(wait_healthy "$HEALTHY_WITHIN_S")"
    if [[ "$same" -eq 1 ]]; then
      notify "the weekly rebuild of ${remote:0:12} was not healthy within ${HEALTHY_WITHIN_S} s and was rolled back; the image of before is $status again (retried next week)"
    else
      notify "deploy of ${remote:0:12} rolled back (it was not healthy within ${HEALTHY_WITHIN_S} s); ${deployed:0:12} is $status again"
    fi
  else
    notify "deploy of ${remote:0:12} is $status after ${HEALTHY_WITHIN_S} s and there is no previous image to roll back to"
  fi
  [[ "$same" -eq 0 ]] || drop_refresh_rollback
  exit 0
fi

# Caddy after the swap (a new build of its tag, a new tag, a new compose file): docker compose up returns once the
# container started, and a Caddy that then exits or crash-loops (restart: unless-stopped) takes the whole site and the
# game down. First its image of before goes back (under the tag the checkout names: a new build that is broken is
# tried again at the next pull), and if Caddy is still not up, the whole deploy is rolled back: the app's image of
# before and its commit (with its compose file and Caddyfile) and Caddy's image of before
if [[ "$caddy_was_up" -eq 1 ]] && ! caddy_up "$caddy_served"; then
  caddy_new_ref="$(caddy_ref)"
  caddy_new="$(image_id "$caddy_new_ref")"
  log "CADDY DOWN after the swap (${caddy_new_ref:-?} ${caddy_new:0:19}): it does not run steadily$([[ "$caddy_served" -eq 1 ]] && echo ' or does not answer through HTTPS')"
  caddy_fixed=0
  if [[ -n "$caddy_before" && -n "$caddy_new_ref" && "$caddy_new" != "$caddy_before" ]]; then
    log "putting Caddy's image of before back (${caddy_before:0:19} as $caddy_new_ref)"
    docker tag "$caddy_before" "$caddy_new_ref"
    dc up -d caddy || log "docker compose up of Caddy's image of before failed"
    if caddy_up "$caddy_served"; then
      caddy_fixed=1
      notify "Caddy's new image ($caddy_new_ref ${caddy_new:0:19}) did not come up after the $([[ "$same" -eq 1 ]] && echo 'weekly refresh' || echo "deploy of ${remote:0:12}"); its image of before runs again, and the new one is tried again at the next pull (coinnibal-compose logs --tail 50 caddy)"
    fi
  fi
  if [[ "$caddy_fixed" -eq 0 ]]; then
    # still down: everything of before goes back
    mark_failed
    if [[ -n "$deployed" ]]; then git reset --hard --quiet "$deployed"; fi
    if [[ "$app_changed" -eq 1 ]] && docker image inspect "$rollback_image" >/dev/null 2>&1; then
      docker tag "$rollback_image" "$COINNIBAL_IMAGE"
    fi
    if [[ -n "$caddy_before" && -n "$caddy_before_ref" ]]; then docker tag "$caddy_before" "$caddy_before_ref"; fi
    log "ROLLBACK: Caddy does not come up with ${remote:0:12}; putting ${deployed:0:12} back with Caddy's image of before"
    dc up -d --remove-orphans || log "docker compose up of the previous version failed"
    status="$(wait_healthy "$HEALTHY_WITHIN_S")"
    caddy_now="still down"
    if caddy_up "$caddy_served"; then caddy_now="up"; fi
    if [[ "$same" -eq 1 ]]; then
      notify "the weekly refresh of ${remote:0:12} was rolled back: Caddy did not come up after the swap; with the images of before the app is $status and Caddy is $caddy_now (retried next week; coinnibal-compose logs --tail 50 caddy)"
    else
      notify "deploy of ${remote:0:12} rolled back: Caddy did not come up after the swap; ${deployed:0:12} is back, the app is $status and Caddy is $caddy_now. It is retried when a newer commit arrives (coinnibal-compose logs --tail 50 caddy)"
    fi
    [[ "$same" -eq 0 ]] || drop_refresh_rollback
    exit 0
  fi
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

# the commit and the image now serving it (the next weekly refresh rebuilds that one only)
record_deployed "$remote"
[[ "$same" -eq 1 ]] || rm -f "$COINNIBAL_STATE/failed" "$COINNIBAL_STATE/waiting-ci" "$COINNIBAL_STATE/postponed"
log "$([[ "$same" -eq 1 ]] && echo refreshed || echo deployed) ${remote:0:12}; app is $status"
if [[ "$up_failed" -eq 1 ]]; then
  notify "$([[ "$same" -eq 1 ]] && echo refreshed || echo deployed) ${remote:0:12}: the app is $status, but docker compose up reported an error (Caddy? coinnibal-status, journalctl -u $INSTALLED_UNIT_PREFIX-$([[ "$same" -eq 1 ]] && echo refresh || echo update))"
fi

# keep the disk clean: the refresh's rollback image (the new build is healthy), dangling images of earlier builds and
# Caddy pulls, build cache older than a week (elymum-app:previous stays: the commit before the last deploy)
drop_refresh_rollback
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
