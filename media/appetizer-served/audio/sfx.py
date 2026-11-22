"""The Appetizer film's own sounds (the mixer, media/mint-film/audio/mix.py, asks this module first and falls back to
the promo's SFX): the service bell, the card deal and slap, the cloche's rattle and lift, the grin's bloop.

  make({"type": "desk_bell"}) -> mono float array at 48 kHz (None for an unknown type)
"""
import numpy as np
from scipy import signal

SR = 48000
_rng = np.random.default_rng(42)


def _t(d):
    return np.arange(int(d * SR)) / SR


def _bp(x, lo, hi, order=2):
    return signal.lfilter(*signal.butter(order, [lo / (SR / 2), hi / (SR / 2)], "band"), x)


def _lp(x, fc, order=2):
    return signal.lfilter(*signal.butter(order, fc / (SR / 2), "low"), x)


def desk_bell(pitch=1.0):
    """A hotel desk bell: the plunger's click, then a bright inharmonic ring over A6 (in key with the score)."""
    t = _t(2.2)
    f0 = 1760 * pitch
    x = np.zeros(len(t))
    for ratio, g, dec in ((1.0, 1.0, 0.6), (2.32, 0.45, 0.35), (3.86, 0.25, 0.2), (5.4, 0.12, 0.12), (0.5, 0.18, 0.4)):
        # a slow beat between two close partials, like real brass
        x += g * (np.sin(2 * np.pi * f0 * ratio * t) + 0.35 * np.sin(2 * np.pi * (f0 * ratio + 3.1) * t)) * np.exp(-t / dec)
    x *= np.minimum(1, t / 0.0015)
    n = int(0.008 * SR)
    click = _bp(_rng.standard_normal(n), 2500, 9000) * np.exp(-np.arange(n) / (0.0012 * SR))
    x[:n] += click * 1.5
    return x / np.max(np.abs(x)) * 0.8


def deal(pitch=1.0):
    """A card flicked across the table: a short airy swish."""
    t = _t(0.22)
    n = _rng.standard_normal(len(t))
    env = np.sin(np.pi * np.minimum(1, t / 0.22)) ** 2
    lo = 1500 * pitch
    x = _bp(n, lo, min(lo * 4.5, 20000)) * env
    return x * 0.6


def slap(pitch=1.0):
    """The card lands: a papery slap with a little body."""
    t = _t(0.18)
    n = _rng.standard_normal(len(t))
    crack = _bp(n, 900 * pitch, 6500) * np.exp(-t * 55)
    body = np.sin(2 * np.pi * np.cumsum(160 * pitch * np.exp(-t * 20) + 70) / SR) * np.exp(-t * 30)
    return (crack * 0.9 + body * 0.6) * np.minimum(1, t / 0.0008)


def rattle():
    """The cloche jiggles on the plate: a few quick metal-on-china taps."""
    x = np.zeros(int(0.32 * SR))
    for k, at in enumerate((0.0, 0.05, 0.1, 0.16, 0.21)):
        t = _t(0.09)
        f = 3100 + 400 * (k % 2)
        tap = (np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * f * 1.51 * t)) * np.exp(-t * 60)
        tap += _bp(_rng.standard_normal(len(t)), 2000, 8000) * np.exp(-t * 200) * 0.6
        i = int(at * SR)
        x[i:i + len(tap)] += tap[: len(x) - i] * (0.8 - k * 0.08)
    return x * 0.5


def cloche():
    """The lid comes off: a bright metallic shing with a rising swish (the reveal)."""
    t = _t(1.4)
    ring = sum(g * np.sin(2 * np.pi * f * t) * np.exp(-t / d) for f, g, d in ((2637, 0.5, 0.5), (3951, 0.3, 0.35), (5274, 0.2, 0.25), (1318, 0.25, 0.6)))
    ring *= np.minimum(1, t / 0.01)
    sw = _rng.standard_normal(len(t))
    sw = signal.lfilter(*signal.butter(2, [2000 / (SR / 2), 9000 / (SR / 2)], "band"), sw) * np.exp(-((t - 0.12) / 0.09) ** 2)
    return ring * 0.6 + sw * 0.5


def bloop():
    t = _t(0.22)
    f = 420 + 900 * (1 - np.exp(-t * 28))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 14) * 0.7


def make(cue):
    ty = cue["type"]
    p = cue.get("pitch", 1.0)
    if ty == "desk_bell":
        return desk_bell(p)
    if ty == "deal":
        return deal(p)
    if ty == "slap":
        return slap(p)
    if ty == "rattle":
        return rattle()
    if ty == "cloche":
        return cloche()
    if ty == "bloop":
        return bloop()
    return None
