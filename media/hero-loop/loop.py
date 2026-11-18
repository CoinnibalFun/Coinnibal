#!/usr/bin/env python3
"""The hero loop from a render (render.mjs): crossfaded seam, rotated start, web encodes, poster, contact sheet.

The render covers the source span [a - fade, b]. The loop is [a, b): its last `fade` seconds are blended
(smoothstep) into the `fade` seconds just before a, so the frame after the loop's last one is exactly its
first. plan.mjs picks a and b where the box holds no coin at either seam, so the blend only touches the
floor and a few pellets. `--start` (seconds into the loop) or `--start-src` (a time of the take, looked up
in the render's frame times) rotates the cycle so the first frame, which is also the poster, shows the
action; the cycle stays seamless.

  python3 media/hero-loop/loop.py render.mkv --fade 0.5 --start 2.0 --out DIR
  python3 media/hero-loop/loop.py render.mkv --fade 0.5 --start-src 279.42 --out DIR
  python3 media/hero-loop/loop.py render.mkv --fade 0.6 --a 229.0 --b 238.2 --search 0.3 --start-src 231.7 --out DIR

`--a`/`--b` (times of the take) set the loop's ends instead of the render's first `fade` seconds and its end;
with `--search` the render must reach that far beyond both (render.mjs --from a-fade-search --to b+search) and
the ends move by up to that much each, to where the frames at both ends match best (the moving camera of the
school loop: the coins' faces and blinks run on the page clock, so a few frames either way can matter). The
match weighs the middle of the frame (the coin the camera follows) most.
Writes DIR/hero-loop.webm (VP9), hero-loop.mp4 (H.264 main, yuv420p, faststart), hero-loop-poster.webp
and contact-sheet.png (12 evenly spaced frames of the encoded mp4, with their times). Needs ffmpeg, numpy
and Pillow.
"""
import argparse
import json
import os
import shutil
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument('render')
ap.add_argument('--fade', type=float, default=0.5)
ap.add_argument('--start', type=float, default=0.0)
ap.add_argument('--start-src', type=float, default=None)
ap.add_argument('--fps', type=int, default=30)
ap.add_argument('--size', default='960x600')
ap.add_argument('--out', required=True)
ap.add_argument('--crf264', type=int, default=20)
ap.add_argument('--crf-vp9', type=int, default=32)
ap.add_argument('--poster-q', type=int, default=82)
ap.add_argument('--a', type=float, default=None)
ap.add_argument('--b', type=float, default=None)
ap.add_argument('--search', type=float, default=0.0)
a = ap.parse_args()
W, H = map(int, a.size.split('x'))
os.makedirs(a.out, exist_ok=True)
FF = os.environ.get('FFMPEG', 'ffmpeg')

# decode, downscaled (the render is 2x or 3x: an antialiased resample)
raw = subprocess.run([FF, '-v', 'error', '-i', a.render, '-vf', f'scale={W}:{H}:flags=lanczos', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                     check=True, stdout=subprocess.PIPE).stdout
S = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)
N = len(S)
F = round(a.fade * a.fps)
times = json.load(open(os.path.splitext(a.render)[0] + '.json'))['times'] if (a.start_src is not None or a.a is not None) else None
near = lambda t: min(range(N), key=lambda k: abs(times[k] - t))
# the loop is frames [iA, iB); its last F frames blend into the F before iA
iA, iB = (near(a.a), near(a.b) if a.b is not None else N) if a.a is not None else (F, N)
if a.search > 0:
    # small grey copies, weighted to the middle (the coin the camera follows)
    g = S[:, ::6, ::6, :].astype(np.float32).mean(axis=3)
    yy, xx = np.mgrid[0:g.shape[1], 0:g.shape[2]]
    wgt = 1 + 3 * np.exp(-(((xx - g.shape[2] / 2) / (g.shape[2] * 0.12)) ** 2 + ((yy - g.shape[1] / 2) / (g.shape[1] * 0.15)) ** 2))
    k = round(a.search * a.fps)
    best = None
    for da in range(-k, k + 1):
        for db in range(-k, k + 1):
            A, B = iA + da, iB + db
            if A - F < 0 or B + F // 2 > N:
                continue
            # the blend window and a little past the seam
            c = sum(float((np.abs(g[B + j] - g[A + j]) * wgt).mean()) for j in range(-F, F // 2))
            if best is None or c < best[0]:
                best = (c, A, B)
    c0 = sum(float((np.abs(g[iB + j] - g[iA + j]) * wgt).mean()) for j in range(-F, F // 2)) if iA - F >= 0 and iB + F // 2 <= N else float('nan')
    print(f'seam search: ends moved by {best[1] - iA:+d} / {best[2] - iB:+d} frames; mismatch {c0:.2f} -> {best[0]:.2f}')
    _, iA, iB = best
L = iB - iA
print(f'render: {N} frames; loop {L} frames ({L / a.fps:.2f} s) from frame {iA}, seam blend {F} frames')

def smooth(x):
    return x * x * (3 - 2 * x)

cycle = []
for x in range(L):
    if x < L - F:
        cycle.append(S[iA + x])
    else:
        j = x - (L - F)
        w = smooth((j + 1) / (F + 1))
        cycle.append(((1 - w) * S[iA + x].astype(np.float32) + w * S[iA - F + j].astype(np.float32) + 0.5).astype(np.uint8))
if a.start_src is not None:
    # the render's frame times (render.mjs writes them next to the video): the frame nearest that take time
    i = min(range(iA, iB), key=lambda k: abs(times[k] - a.start_src))
    p = (i - iA) % L
else:
    p = round(a.start * a.fps) % L
print(f'first frame: loop frame {p} ({p / a.fps:.2f} s into the loop)')
out = cycle[p:] + cycle[:p]

# lossless intermediate, then the web encodes (two passes for VP9)
tmp = tempfile.mkdtemp(prefix='hero-loop-')
master = os.path.join(tmp, 'master.mkv')
enc = subprocess.Popen([FF, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(a.fps), '-i', '-',
                        '-c:v', 'libx264rgb', '-preset', 'veryfast', '-qp', '0', master], stdin=subprocess.PIPE)
for f in out:
    enc.stdin.write(f.tobytes())
enc.stdin.close()
assert enc.wait() == 0

mp4 = os.path.join(a.out, 'hero-loop.mp4')
webm = os.path.join(a.out, 'hero-loop.webm')
common = ['-an', '-sn', '-map_metadata', '-1', '-r', str(a.fps)]
subprocess.run([FF, '-v', 'error', '-y', '-i', master, '-vf', 'format=yuv420p', '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'veryslow', '-tune', 'animation',
                '-crf', str(a.crf264), '-g', str(a.fps * 2), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', *common, mp4], check=True)
log = os.path.join(tmp, 'vp9')
for pss in (1, 2):
    subprocess.run([FF, '-v', 'error', '-y', '-i', master, '-vf', 'format=yuv420p', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', str(a.crf_vp9), '-row-mt', '1',
                    '-deadline', 'good', '-cpu-used', '1' if pss == 2 else '4', '-g', str(a.fps * 2), '-pass', str(pss), '-passlogfile', log, *common,
                    *(['-f', 'null', os.devnull] if pss == 1 else [webm])], check=True)

# poster: the first frame
poster = os.path.join(a.out, 'hero-loop-poster.webp')
Image.fromarray(out[0]).save(poster, 'WEBP', quality=a.poster_q, method=6)

# contact sheet from the encoded mp4 (what ships), 12 evenly spaced frames with their times
raw = subprocess.run([FF, '-v', 'error', '-i', mp4, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], check=True, stdout=subprocess.PIPE).stdout
D = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)
n = len(D)
idx = [round(i * n / 12) for i in range(12)]
tw, th, lab = W // 2, H // 2, 34
sheet = Image.new('RGB', (tw * 4 + 5 * 8, (th + lab) * 3 + 4 * 8), (24, 24, 24))
try:
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 20)
except OSError:
    font = ImageFont.load_default()
dr = ImageDraw.Draw(sheet)
for k, i in enumerate(idx):
    x = 8 + (k % 4) * (tw + 8)
    y = 8 + (k // 4) * (th + lab + 8)
    sheet.paste(Image.fromarray(D[i]).resize((tw, th), Image.LANCZOS), (x, y + lab))
    dr.text((x + 4, y + 6), f'#{i:03d}  t={i / a.fps:5.2f}s', fill=(235, 235, 235), font=font)
sheet.save(os.path.join(a.out, 'contact-sheet.png'))

# the seam, for a check (next to the render): the loop's last frame next to its first
seam = os.path.splitext(a.render)[0] + '-seam.png'
Image.fromarray(np.concatenate([D[-1], D[0]], axis=1)).save(seam)
shutil.rmtree(tmp)
for f in (webm, mp4, poster):
    print(f'{os.path.basename(f)}: {os.path.getsize(f) / 1024:.0f} KB')
print(f'{n} frames, {n / a.fps:.2f} s; seam check {seam}')
