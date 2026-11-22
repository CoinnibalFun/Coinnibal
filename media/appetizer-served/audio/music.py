"""Score for "Appetizers are served": 120 BPM (a beat is 0.5 s), bright and bouncy, synthesised with the promo's
instruments (media/promo/audio/music.py), so it sounds like the rest of the family.

  0.0  ORDER UP     a soft pad and a pluck pick-up; the two desk-bell dings (sfx) on 0.5 and 0.75 sit on A6
  2.0  THE DEAL     kick, clap and bass come in with the first card; hats double on 4.0 as the deal speeds up,
                    chord stabs on 5.0; a snare roll and a riser into the sweep
  6.0  THE CLOCHE   a crash on the sweep, then the groove drops to the pad and a ticking hat (the suspense);
                    7.0 the lid comes off: a rising bell arpeggio; 8.0 the stamp: impact, crash, the groove back
  9.5  END CARD     a reverse crash into 10.0: the sting, a held chord, an airy pluck tail to 13.0

  python music.py OUT.wav
"""
import json
import os
import sys

import numpy as np
from scipy import signal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "promo", "audio"))
import music as M  # noqa: E402

SR = M.SR
TL = json.load(open(os.path.join(HERE, "..", "timeline.json")))
DUR = TL["duration"] + 0.5
N = int(DUR * SR)
BEAT, BAR = 0.5, 2.0
PROG = M.PROG
place = M.place


def build():
    drums, bass, keys, lead, fx = (np.zeros((2, N)) for _ in range(5))
    motif = [72, 76, 79, 81, 79, 76, 74, 77]
    # the pad under the opening and the deal
    for b in range(3):
        place(keys, M.pad(PROG[b % 4][0], 2.0, 0.5, 900 + b * 300), b * BAR, 0.5)
    # opening pick-up: a few plucks around the dings
    for i, (t, m) in enumerate(((0.0, 72), (1.0, 76), (1.25, 79), (1.5, 81), (1.75, 84))):
        place(lead, M.pluck(m, 0.4), t, 1.0, -0.2 + 0.1 * i)
    # the deal: 2.0 to 6.0
    for bi in range(int(2.0 / BEAT), int(6.0 / BEAT)):
        t = bi * BEAT
        ch, root = PROG[int(t // BAR) % 4]
        place(drums, M.kick(0.95), t)
        if bi % 2 == 1:
            place(drums, M.clap(0.7), t, 1.0, 0.05)
        hats = 2 if t >= 4.0 else 1
        for s in range(hats):
            place(drums, M.hat(False, 0.32 if s == 0 else 0.22), t + (0.25 if hats == 1 else s * 0.25), 1.0, 0.3)
        if t >= 5.0:
            place(drums, M.shaker(0.25), t + 0.125, 1.0, -0.3)
            place(keys, M.chord_stab(ch, 0.12, 0.65, 2600), t + 0.25)
        place(bass, M.bass_note(root, 0.22, 0.9), t)
        place(bass, M.bass_note(root + 12, 0.12, 0.45), t + 0.25)
    for i in range(int(4.0 / 0.25)):
        t = 2.0 + i * 0.25
        place(lead, M.pluck(motif[i % 8] - (0 if (i // 8) % 2 == 0 else 2), 0.5 if i % 2 == 0 else 0.32), t, 1.0, -0.3 + 0.6 * (i % 2))
    # the build into the sweep
    for k in range(8):
        place(drums, M.clap(0.18 + k * 0.07), 5.5 + k * 0.0625, 1.0, (k % 2) * 0.3 - 0.15)
    place(fx, M.noise_riser(0.5, 0.8, 600, 9000), 5.45)
    place(drums, M.crash(0.75, 1.6), 6.0, 1.0, 0.2)
    place(drums, M.kick(1.0), 6.0)
    place(bass, M.bass_note(41, 0.6, 0.9), 6.0)
    # the suspense: a pad and a ticking hat under the cloche
    place(keys, M.pad(PROG[2][0], 1.0, 0.45, 1100), 6.0, 0.4)
    for k in range(8):
        place(drums, M.hat(False, 0.14 + k * 0.02), 6.5 + k * 0.0625, 1.0, 0.25)
    # the lid comes off: a rising bell arpeggio
    for i, m in enumerate([72, 76, 79, 84, 88]):
        place(lead, M.bell(m, 1.4, 0.7 - i * 0.06), 7.0 + i * 0.06, 1.0, -0.4 + i * 0.2)
    place(keys, M.pad(PROG[0][0] + [72], 1.0, 0.5, 1800), 7.0, 0.5)
    place(bass, M.bass_note(41, 0.4, 0.7), 7.0)
    place(drums, M.reverse_crash(0.3, 0.5), 7.7)
    # the stamp: impact and the groove back until the end card
    place(drums, M.impact(1.0), 8.0)
    place(drums, M.crash(0.85, 1.8), 8.0, 1.0, -0.15)
    for bi in range(int(8.0 / BEAT), int(9.5 / BEAT)):
        t = bi * BEAT
        ch, root = PROG[int((t - 8.0) // BAR) % 4]
        place(drums, M.kick(0.9), t)
        if bi % 2 == 1:
            place(drums, M.clap(0.65), t, 1.0, 0.05)
        for s in range(2):
            place(drums, M.hat(False, 0.3 if s == 0 else 0.2), t + s * 0.25, 1.0, 0.3)
        place(bass, M.bass_note(root, 0.22, 0.9), t)
        place(bass, M.bass_note(root + 12, 0.12, 0.45), t + 0.25)
        place(keys, M.chord_stab(ch, 0.12, 0.6, 2600), t + 0.25)
    for i in range(6):
        place(lead, M.pluck(motif[i] + 12, 0.32 if i % 2 == 0 else 0.22), 8.0 + i * 0.25, 1.0, -0.3 + 0.6 * (i % 2))
    place(drums, M.reverse_crash(0.5, 0.7), 9.5)
    # the end card
    place(drums, M.kick(1.0), 10.0)
    place(drums, M.crash(0.7, 2.6), 10.0)
    for i, m in enumerate([65, 69, 72, 76, 79]):
        place(lead, M.bell(m, 2.6, 0.7), 10.0 + i * 0.04, 1.0, -0.4 + i * 0.2)
    place(keys, M.chord_stab(PROG[0][0], 1.2, 0.85, 2400), 10.0)
    place(bass, M.bass_note(41, 1.4, 1.0), 10.0)
    place(keys, M.pad(PROG[0][0] + [72], 3.0, 0.55, 1400), 10.0, 0.5)
    for k in range(10):
        place(lead, M.pluck(motif[k % 8] + 12, 0.16 - k * 0.012), 10.5 + k * 0.25, 1.0, -0.3 + 0.6 * (k % 2))
    return drums, bass, keys, lead, fx


def main():
    out = sys.argv[1]
    drums, bass, keys, lead, fx = build()
    ir_l, ir_r = M.reverb_ir(seed=7), M.reverb_ir(seed=8)

    def verb(x, wet):
        l = signal.fftconvolve(x[0], ir_l)[: x.shape[1]]
        r = signal.fftconvolve(x[1], ir_r)[: x.shape[1]]
        return x + wet * np.stack([l, r])

    keys, lead = verb(keys, 0.3), verb(lead, 0.4)
    drums = drums + 0.08 * np.stack([signal.fftconvolve(drums[0], ir_l)[:N], signal.fftconvolve(drums[1], ir_r)[:N]])
    mix = drums * 0.9 + bass * 0.85 + keys + lead + fx * 0.7
    mix = M.hp(mix, 30, 2)
    mix = M.biquad(mix, "peak", 300, -3.0, 0.7)
    mix = M.biquad(mix, "highshelf", 5000, 2.0, 0.7)
    # a breath before the lid comes off
    i0, i1, fade = int(6.92 * SR), int(7.0 * SR), int(0.015 * SR)
    mix[:, i0 - fade:i0] *= np.linspace(1, 10 ** (-24 / 20), fade)
    mix[:, i0:i1] *= 10 ** (-24 / 20)
    f0 = int((TL["duration"] - 1.5) * SR)
    mix[:, f0:] *= np.linspace(1, 0, N - f0) ** 1.5
    mix = np.tanh(mix * 0.9) / 0.9
    mix *= 10 ** (-3 / 20) / np.max(np.abs(mix))
    import soundfile as sf
    sf.write(out, mix.T.astype(np.float32), SR, subtype="FLOAT")
    print("music written", out, round(N / SR, 2), "s")


if __name__ == "__main__":
    main()
