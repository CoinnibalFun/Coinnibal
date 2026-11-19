#!/usr/bin/env bash
# Coinnibal: load a backup (.tar.gz of DATA_DIR) into the elymum-data volume.
#   restore.sh <file.tar.gz>                       a file on this server
#   restore.sh --url <server>                      download it from the running server first (<server> e.g.
#                                                  https://game.elymum.io, or the full .../api/admin/backup URL).
#                                                  It asks for the admin session token and a fresh signature of
#                                                  the admin wallet of purpose backup or migration (README
#                                                  "Moving") at hidden prompts, or reads them from stdin, one per
#                                                  line; never from the command line (any local user can read
#                                                  that in ps)
# Options: --yes (no questions), --no-start (leave the app stopped afterwards).
# The archive is checked first (complete gzip, readable tar, no absolute or '..' paths). If the volume
# already holds data, a safety backup of it is written to /opt/elymum/backups before it is replaced. Before that
# it asks (Type RESTORE) unless --yes: with the secrets on stdin the question reads the terminal, and with no
# terminal --yes is needed (refused before anything is downloaded: a proof opens the backup once).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root

file=""
url=""
token=""
proof=""
yes=0
start=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) url="${2:?--url needs a value}"; shift 2 ;;
    --token | --proof) die "$1 is not taken on the command line (any local user can read it in ps): leave it out and paste the value at the prompt, or send the token and the proof on stdin, one per line" ;;
    --yes | -y) yes=1; shift ;;
    --no-start) start=0; shift ;;
    -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) file="$1"; shift ;;
  esac
done

# where the answer to "Type RESTORE" comes from: stdin, or the terminal when stdin carries the secrets
answer_in=/dev/stdin
if [[ -n "$url" ]]; then
  [[ "$url" == https://* ]] || die "--url must start with https:// (the token and the proof must not travel in clear): $url"
  if [[ ! -t 0 && "$yes" -ne 1 ]]; then
    answer_in=/dev/tty
    { : </dev/tty; } 2>/dev/null || die "the token and the proof on stdin with no terminal need --yes (the question before the volume is replaced reads the terminal); nothing was downloaded"
  fi
  read_secret token "Admin session token"
  [[ -n "$token" ]] || die "a token is needed to download the backup"
  read_secret proof "Signed proof (X-Coinnibal-Proof)"
  [[ -n "$proof" ]] || die "a proof (a fresh signature of the admin wallet) is needed to download the backup"
  url="${url%/}"
  [[ "$url" == */api/admin/backup ]] || url="$url/api/admin/backup"
  mkdir -p "$COINNIBAL_BACKUPS"
  chmod 700 "$COINNIBAL_BACKUPS"
  file="$COINNIBAL_BACKUPS/migrated-$(date -u +%Y%m%d-%H%M%S).tar.gz"
  log "downloading the backup from ${url%%/api/*}"
  umask 077
  # the token and the proof reach curl through a 0600 header file (umask above), never a command line (other users
  # can read those in ps; printf is a shell builtin); --proto: HTTPS only
  hdr="$(mktemp)"
  trap 'rm -f "$hdr"' EXIT
  printf 'Authorization: Bearer %s\nX-Coinnibal-Proof: %s\n' "$token" "$proof" >"$hdr"
  # no --retry: a proof opens the backup once
  curl -fsS --proto '=https' -H @"$hdr" "$url" -o "$file" || die "download failed (expired token or proof? wrong URL? on the mainnet ADMIN_SECRET_EXPORT=1 must be set)"
  log "downloaded $(du -h "$file" | cut -f1)"
fi
[[ -n "$file" ]] || die "give a backup file, or --url (see --help)"
file="$(readlink -f "$file")"
log "checking $file"
verify_backup "$file"
log "archive OK: $(tar tzf "$file" | wc -l) entries"

image="$COINNIBAL_IMAGE"
docker image inspect "$image" >/dev/null 2>&1 || image="debian:bookworm-slim"

if ! docker volume inspect "$COINNIBAL_VOLUME" >/dev/null 2>&1; then
  # labelled as compose's own volume, so `docker compose up` uses it without a warning
  docker volume create --label "com.docker.compose.project=$INSTALLED_PROJECT" --label "com.docker.compose.volume=$COINNIBAL_VOLUME" "$COINNIBAL_VOLUME" >/dev/null
fi

was_running=0
if [[ -f "$COINNIBAL_COMPOSE" && -f "$COINNIBAL_ENV" ]] && [[ -n "$(dc ps --status running -q app 2>/dev/null)" ]]; then
  was_running=1
fi

nonempty="$(docker run --rm --network none --user 0 --entrypoint sh -v "$COINNIBAL_VOLUME":/data "$image" -c 'ls -A /data | head -n 1')"
if [[ -n "$nonempty" || "$was_running" -eq 1 ]]; then
  echo
  if [[ "$was_running" -eq 1 ]]; then
    echo "The game server is running on volume $COINNIBAL_VOLUME; it will be stopped."
  fi
  echo "The volume $COINNIBAL_VOLUME already holds data or is in use."
  echo "It will be backed up to $COINNIBAL_BACKUPS first, then REPLACED by $file."
  if [[ "$yes" -ne 1 ]]; then
    answer=""
    read -rp "Type RESTORE to continue: " answer <"$answer_in" || [[ -n "$answer" ]] || die "no answer (the input ended): nothing was replaced; --yes skips the question"
    [[ "$answer" == "RESTORE" ]] || die "cancelled: nothing was replaced"
  fi
fi

# no auto-deploy may restart the app while the volume is replaced
if [[ "$COINNIBAL_LOCK_HELD" != "1" ]]; then # (install.sh already holds it)
  mkdir -p "$(dirname "$COINNIBAL_LOCK")"
  exec 9>"$COINNIBAL_LOCK"
  flock -w 1800 9 || die "another Coinnibal job held the lock for 30 minutes; try again later"
  export COINNIBAL_LOCK_HELD=1
fi

if [[ "$was_running" -eq 1 ]]; then
  log "stopping the game server (it pays out live stake players first)"
  dc stop -t 45 app
fi
if [[ -n "$nonempty" ]]; then
  log "safety backup of the current data"
  "$COINNIBAL_DIR/deploy/vps/backup.sh"
fi

log "restoring into volume $COINNIBAL_VOLUME"
# shellcheck disable=SC2016 # $1 is expanded by the container's shell
docker run --rm --network none --user 0 --entrypoint sh \
  -v "$COINNIBAL_VOLUME":/data \
  -v "$(dirname "$file")":/restore:ro \
  "$image" -c 'find /data -mindepth 1 -delete && tar xzf "/restore/$1" -C /data --no-same-owner && chown -R 1000:1000 /data' sh "$(basename "$file")"
log "restore done"

if [[ "$start" -eq 1 && -f "$COINNIBAL_ENV" ]] && docker image inspect "$COINNIBAL_IMAGE" >/dev/null 2>&1; then
  log "starting the stack"
  dc up -d
fi
