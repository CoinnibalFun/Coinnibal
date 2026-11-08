#!/usr/bin/env bash
# Elymum: the reboot a system update asks for, in the break after an arena bell (elymum-reboot.timer, 04:30; safe
# to run by hand: elymum-reboot). unattended-upgrades installs security updates by itself but never reboots
# (52elymum-unattended): a reboot at a fixed minute would cash every arena player out mid-round. Here the app is
# stopped in the break (no live stake), then the machine reboots; the stack comes back by itself (restart policy).
#   reboot.sh            only when /var/run/reboot-required exists
#   reboot.sh --force    in the next break, whatever
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root

if [[ "${1:-}" != "--force" && ! -f /var/run/reboot-required ]]; then
  log "no reboot required"
  exit 0
fi
exec 9>"$ELYMUM_LOCK"
flock -w 1800 9 || die "another Elymum job held the lock for 30 minutes; no reboot now"
log "a reboot is due ($(tr '\n' ' ' </var/run/reboot-required.pkgs 2>/dev/null | cut -c1-120)); waiting for the round break"
wait_for_round_break
dc stop -t 45 app || true
notify "rebooting for a system update (in the round break); back in about a minute"
systemctl reboot
