#!/usr/bin/env bash
# docker compose for the Coinnibal stack, with the right file, project and .env. Examples:
#   coinnibal-compose ps                        (the same script as elymum-compose and deploy/vps/compose.sh)
#   coinnibal-compose logs -f --tail 200 app
#   coinnibal-compose restart app
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
dc "$@"
