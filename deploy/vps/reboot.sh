#!/usr/bin/env bash
# Coinnibal: the reboot a system update asks for, and the Docker Engine's updates, in the break after an arena bell
# (elymum-reboot.timer, 04:30; safe to run by hand: coinnibal-reboot). unattended-upgrades installs Ubuntu's
# security updates by itself but never reboots (52elymum-unattended): a reboot at a fixed minute would cash every
# arena player out mid-round. Docker's own repository (docker-ce, containerd.io with runc, the CLI and the compose and
# buildx plugins) is not among unattended-upgrades' origins for the same reason: an update of docker-ce or
# containerd.io restarts dockerd and with it every container. Both happen here: in the break the app is stopped (no
# live stake), the engine is upgraded when Docker's repository has a newer one, then the machine reboots if an update
# asks for it; otherwise the stack starts again on the new engine. An update of the CLI or the plugins alone restarts
# nothing and is installed at once. What is due is read with the lock held, and only the packages found then are
# installed: package lists that change meanwhile (apt's daily job) never bring docker-ce or containerd.io in outside
# the break. The stack comes back by itself after a reboot (restart policy).
#   reboot.sh            only when /var/run/reboot-required exists or Docker's packages have an update
#   reboot.sh --force    reboot in the next break, whatever (Docker's packages are upgraded first when they have one)
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
DOCKER_PKGS=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)

# "Inst <package> ..." of a simulated `apt-get install --only-upgrade <packages>`: what it would upgrade, dependencies
# included (a package not installed is skipped)
upgrades_of() {
  apt-get -s install --only-upgrade "$@" 2>/dev/null | awk '/^Inst / { print $2 }' | tr '\n' ' ' || true
}
# an update of docker-ce or containerd.io restarts dockerd, and with it every container
restarts_engine() {
  [[ " $1 " == *" docker-ce "* || " $1 " == *" containerd.io "* ]]
}

exec 9>"$COINNIBAL_LOCK"
flock -w 7200 9 || die "another Coinnibal job held the lock for 2 hours; no maintenance now"
reboot_due=0
[[ "${1:-}" == "--force" || -f /var/run/reboot-required ]] && reboot_due=1
# the package lists (apt's daily job refreshes them too; a failure here only means yesterday's lists)
apt-get update -q >/dev/null 2>&1 || log "apt-get update failed; checking the Docker Engine against the lists as they are"
engine_new="$(upgrades_of "${DOCKER_PKGS[@]}")"
# the packages found now: the only ones installed below, whatever the lists hold by then
read -ra engine_pkgs <<<"$engine_new"
engine_due=0
[[ "${#engine_pkgs[@]}" -eq 0 ]] || engine_due=1
if [[ "$reboot_due" -eq 0 && "$engine_due" -eq 0 ]]; then
  log "no reboot required, and the Docker Engine is up to date"
  exit 0
fi
# the stop in the round break: for a reboot, and for an update that restarts dockerd (docker-ce, containerd.io)
stop=$reboot_due
restarts_engine "$engine_new" && stop=1
if [[ "$engine_due" -eq 1 ]]; then
  log "a Docker update is due: ${engine_pkgs[*]}"
  # downloaded now, while the server plays, so the stop in the break lasts only the install
  apt-get install -y -q -d -o DPkg::Lock::Timeout=120 --only-upgrade "${engine_pkgs[@]}" >/dev/null || log "downloading the Docker update failed; the install below tries again"
  # the CLI or the plugins alone go in at once, unless the lists changed meanwhile and their install would now
  # upgrade the engine as well (a newer CLI that needs a newer engine): then in the break, with the app stopped
  if [[ "$stop" -eq 0 ]] && restarts_engine "$(upgrades_of "${engine_pkgs[@]}")"; then
    log "installing ${engine_pkgs[*]} now upgrades the engine too; in the round break"
    stop=1
  fi
fi
[[ "$reboot_due" -eq 1 ]] && log "a reboot is due ($(tr '\n' ' ' 2>/dev/null </var/run/reboot-required.pkgs | cut -c1-120))"

if [[ "$stop" -eq 1 ]]; then
  log "waiting for the round break"
  wait_for_round_break
  dc stop -t 45 app || true
  # no job may start a docker command while the engine is replaced (the alert job runs every minute): the timers that
  # run are paused, and only those start again at the end (a paused auto-deploy stays paused), or with the reboot
  paused=()
  for t in alert update refresh; do
    if systemctl is-active --quiet "$INSTALLED_UNIT_PREFIX-$t.timer" 2>/dev/null; then
      systemctl stop "$INSTALLED_UNIT_PREFIX-$t.timer" && paused+=("$INSTALLED_UNIT_PREFIX-$t.timer")
    fi
  done
  trap '[[ ${#paused[@]} -eq 0 ]] || systemctl start "${paused[@]}" 2>/dev/null || true' EXIT
fi

if [[ "$engine_due" -eq 1 ]]; then
  if apt-get install -y -q -o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
    --only-upgrade "${engine_pkgs[@]}"; then
    log "Docker upgraded: engine $(dpkg-query -W -f '${Version}' docker-ce 2>/dev/null || echo '?')"
  else
    notify "the Docker upgrade failed (journalctl -u $INSTALLED_UNIT_PREFIX-reboot -n 100); the server goes on with what is installed"
  fi
  systemctl start docker >/dev/null 2>&1 || true
fi

if [[ "$reboot_due" -eq 1 ]]; then
  notify "rebooting for a system update (in the round break); back in about a minute"
  systemctl reboot
  exit 0
fi
if [[ "$stop" -eq 1 ]]; then
  log "starting the stack again"
  dc up -d || notify "the stack did not start again after the Docker Engine upgrade (coinnibal-status)"
fi
