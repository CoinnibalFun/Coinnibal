#!/usr/bin/env bash
# Muxes cache/video.mp4 + cache/audio/final.wav into the deliverable:
#   out/videos/coinnibal-promo.mp4   H.264 High (two-pass, about 30 MB), AAC 192k, yuv420p, faststart
# The sound is finished first with the gameplay kit's finalize.py: -16 LUFS, true peak at or below
# -1.2 dBTP measured after AAC encoding.
#   PY=<python with numpy, scipy, soundfile, pyloudnorm> render/mux.sh
set -euo pipefail
cd "$(dirname "$0")/.."
FFMPEG=${FFMPEG:-/usr/bin/ffmpeg}
PY=${PY:-../gameplay/cache/venv/bin/python}
OUT=../../out/videos
NAME=${NAME:-coinnibal-promo}
V=${V:-cache/video.mp4}
MB=${MB:-30}
mkdir -p "$OUT" cache/pass
"$PY" ../gameplay/render/finalize.py cache/audio/final.wav cache/audio/final-tp.wav --lufs -16 --tp -1.2
A=cache/audio/final-tp.wav
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$V")
VB=$(python3 -c "print(int(($MB*0.92*8*1048576/$DUR - 192000*1.02)/1000))")
common=(-pix_fmt yuv420p -r 60 -profile:v high -level 4.2 -g 120 -bf 3 -color_primaries bt709 -color_trc bt709 -colorspace bt709)
"$FFMPEG" -v error -y -i "$V" -an -c:v libx264 -preset slow -b:v ${VB}k -maxrate $((VB*8/5))k -bufsize $((VB*2))k "${common[@]}" \
  -pass 1 -passlogfile cache/pass/x264 -f mp4 /dev/null
"$FFMPEG" -v error -y -i "$V" -i "$A" -map 0:v -map 1:a -c:v libx264 -preset slow -b:v ${VB}k -maxrate $((VB*8/5))k -bufsize $((VB*2))k "${common[@]}" \
  -pass 2 -passlogfile cache/pass/x264 -c:a aac -b:a 192k -ar 48000 -shortest -movflags +faststart "$OUT/$NAME.mp4"
rm -rf cache/pass
ls -la "$OUT/$NAME.mp4"
