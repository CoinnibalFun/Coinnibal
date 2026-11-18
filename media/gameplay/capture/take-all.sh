#!/usr/bin/env bash
# Records every take the videos use, one after another. Each take is a journal (capture/journal.mjs):
# no pixels are captured live; capture/replay.mjs renders the frames the edits need afterwards.
# Needs `pnpm demo` running (fake chain, the default 5-minute rounds; the demo opens the game to everyone). Logs go to
# media/gameplay/cache/<take>.log. The round takes wait for the right moment of a round:
#   arena  waits for a round to open, then plays it to the bell (about 6 min);
#   spill  waits for a fresh round (joins open), is eaten (the old take: by a house bot), buys back in;
#   held   waits for the final minute of a round, buys a held ticket, joins the next round.
# $1 Room rounds are wall-clock aligned, so the whole run takes about 25-35 minutes.
set -u
cd "$(dirname "$0")/../../.."
C=media/gameplay/capture
L=media/gameplay/cache
nice -n -10 node $C/take-arena.mjs --name arena "$@" > $L/arena.log 2>&1
nice -n -10 node $C/take-spill.mjs --name spill > $L/spill.log 2>&1
nice -n -10 node $C/take-held.mjs --name held > $L/held.log 2>&1
nice -n -10 node $C/take-practice.mjs --name practice > $L/practice.log 2>&1
nice -n -10 node $C/take-lobby.mjs --name lobby --fresh > $L/lobby.log 2>&1
