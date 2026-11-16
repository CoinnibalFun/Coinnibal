/* Coinnibal promo: shared drawing library (Storybook paints, riso print).
 * Everything here is deterministic: no Date, no Math.random. All motion is a
 * pure function of the timeline time t (seconds). */
'use strict';

// the frame size comes from the page URL (?w=1080&h=1920 for a vertical cut); landscape by default
const QS = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const W = Number(QS.get('w')) || 1920, H = Number(QS.get('h')) || 1080, TAU = Math.PI * 2;
const C = {
  paper: '#F8F7F4', card: '#F6EEDA', ink: '#04181C', ink2: '#6B655A',
  pink: '#34B7DD', pinkInk: '#2490B0', pinkText: '#1E6F8C',
  teal: '#2D7388', tealInk: '#1F5566', mustard: '#F2C14E', mustardInk: '#8A5F0E',
  blue: '#93D9EE', green: '#3C9A87', red: '#FF5252', orange: '#D9714F', purple: '#1E4D5A',
  night: '#0F2A30', nightCard: '#163B44', nightInk: '#F6EEDA', nightInk2: '#BFD8DD', nightPink: '#6FCDE8',
  cover: '#1F5566', line: 'rgba(4,24,28,0.35)', tape: 'rgba(219,242,249,0.85)',
  // the Storybook paints by their own names (packages/shared/src/palette.ts)
  abyss: '#04181C', deep: '#071317', trench: '#0F2A30', reef: '#163B44', current: '#1E4D5A',
  cyan: '#34B7DD', cyanShade: '#2490B0', spray: '#6FCDE8', foam: '#93D9EE', mist: '#DBF2F9',
  cream: '#F6EEDA', creamShade: '#DCCDA8', sun: '#F2C14E', sunShade: '#D49A2B', sunText: '#8A5F0E',
  up: '#3C9A87', down: '#FF5252', downShade: '#C93A3A', blush: '#F39B86', coral: '#D9714F', white: '#FFFFFF',
};
// Storybook type (the web app's fonts): Fraunces for display, Geist Mono for
// numbers and kickers. The palette above is the Storybook paint table under the old Paper Ticket names
// (pink -> cyan, mustard -> sun, night -> trench, ...), so every scene picks it up unchanged.
const FONT = { display: '"Fraunces", Georgia, serif', mono: '"Geist Mono", ui-monospace, monospace' };

/* ───────────── math & easing ───────────── */
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const prog = (t, a, b) => clamp((t - a) / (b - a));
const E = {
  lin: (x) => x,
  inQuad: (x) => x * x,
  outQuad: (x) => 1 - (1 - x) * (1 - x),
  inCubic: (x) => x * x * x,
  outCubic: (x) => 1 - Math.pow(1 - x, 3),
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  outQuart: (x) => 1 - Math.pow(1 - x, 4),
  inQuart: (x) => x * x * x * x,
  inOutQuart: (x) => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2),
  outExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  inExpo: (x) => (x <= 0 ? 0 : Math.pow(2, 10 * x - 10)),
  inOutExpo: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2),
  outBack: (x, s = 1.70158) => 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2),
  inBack: (x, s = 1.70158) => (s + 1) * x * x * x - s * x * x,
};
/** Damped spring from 0 to 1 starting at time 0 (dt in seconds). */
function spring(dt, freq = 2.2, damp = 7) {
  if (dt <= 0) return 0;
  return 1 - Math.exp(-damp * dt) * Math.cos(TAU * freq * dt);
}
/** Eased tween of t over [a,b] with easing fn. */
const tw = (t, a, b, fn = E.outCubic) => fn(prog(t, a, b));

/* deterministic hash noise */
function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash(i + seed * 57.3), hash(i + 1 + seed * 57.3), u) * 2 - 1;
}
/** Decaying shake for impacts at times[]; returns {x,y,r}. */
function shake(t, times, amp = 14, dur = 0.45) {
  let x = 0, y = 0, r = 0;
  for (const t0 of times) {
    const d = t - t0;
    if (d < 0 || d > dur) continue;
    const k = Math.pow(1 - d / dur, 2.2) * amp;
    x += noise1(d * 38, t0) * k;
    y += noise1(d * 41 + 9, t0) * k;
    r += noise1(d * 30 + 3, t0) * k * 0.0009;
  }
  return { x, y, r };
}

/* ───────────── canvas helpers ───────────── */
function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function font(ctx, size, weight = 800, fam = 'display', stretch = 'semi-condensed') {
  ctx.font = `${weight} ${size}px ${FONT[fam]}`;
  ctx.fontStretch = fam === 'display' ? stretch : 'normal';
  ctx.letterSpacing = '0px';
  ctx.fontKerning = 'normal';
}
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
/** Ticket outline with half-circle notches at x = stubX (top and bottom). */
function ticketPath(ctx, x, y, w, h, r, stubX, nr) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  if (stubX != null) {
    ctx.lineTo(x + stubX - nr, y);
    ctx.arc(x + stubX, y, nr, Math.PI, 0, true);
  }
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  if (stubX != null) {
    ctx.lineTo(x + stubX + nr, y + h);
    ctx.arc(x + stubX, y + h, nr, 0, Math.PI, true);
  }
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
/** Side-notched frame (notches on left and right edges at mid height). */
function sideTicketPath(ctx, x, y, w, h, r, nr, ny = 0.5) {
  const my = y + h * ny;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, my - nr);
  ctx.arc(x + w, my, nr, -Math.PI / 2, Math.PI / 2, true);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, my + nr);
  ctx.arc(x, my, nr, Math.PI / 2, -Math.PI / 2, true);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
function dashed(ctx, x1, y1, x2, y2, color = C.line, w = 2.5, dash = [7, 7]) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.restore();
}
/** Paper drop shadow: a soft ambient one plus the brand's hard 1.5px ink lip. */
function paperShadow(ctx, pathFn, lift = 1, hard = 0.28) {
  ctx.save();
  ctx.shadowColor = `rgba(4,24,28,${0.16 * lift})`;
  ctx.shadowBlur = 30 * lift;
  ctx.shadowOffsetY = 14 * lift;
  ctx.shadowOffsetX = 4 * lift;
  pathFn();
  ctx.fillStyle = 'rgba(4,24,28,1)';
  ctx.fill();
  ctx.restore();
  if (hard > 0) {
    ctx.save();
    ctx.translate(0, 2);
    pathFn();
    ctx.fillStyle = `rgba(4,24,28,${hard})`;
    ctx.fill();
    ctx.restore();
  }
}

/* ───────────── textures (built once) ───────────── */
const TEX = {};
function buildTextures() {
  // paper fibre + mottling, 1024 tile
  const n = 1024;
  const p = mkCanvas(n, n), g = p.getContext('2d');
  const r = rng(7);
  g.clearRect(0, 0, n, n);
  for (let i = 0; i < 260; i++) {
    const x = r() * n, y = r() * n, rad = 40 + r() * 160;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    const a = 0.006 + r() * 0.008;
    grd.addColorStop(0, r() < 0.5 ? `rgba(4,24,28,${a})` : `rgba(246,238,218,${a * 2.0})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    for (const ox of [-n, 0, n]) for (const oy of [-n, 0, n]) { g.save(); g.translate(ox, oy); g.fillRect(x - rad, y - rad, rad * 2, rad * 2); g.restore(); }
  }
  for (let i = 0; i < 2600; i++) {
    const x = r() * n, y = r() * n, l = 3 + r() * 12, a = r() * TAU;
    g.strokeStyle = `rgba(4,24,28,${0.02 + r() * 0.035})`;
    g.lineWidth = 0.6 + r() * 0.7;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(4,24,28,${0.04 + r() * 0.08})`;
    g.fillRect(r() * n, r() * n, 1 + r(), 1 + r());
  }
  TEX.fibre = p;

  // dot screen (7px and 11px grids)
  const d = mkCanvas(77, 77), dg = d.getContext('2d');
  dg.fillStyle = 'rgba(4,24,28,0.07)';
  for (let x = 0; x < 77; x += 7) for (let y = 0; y < 77; y += 7) { dg.beginPath(); dg.arc(x + 1, y + 1, 1.1, 0, TAU); dg.fill(); }
  dg.fillStyle = 'rgba(4,24,28,0.045)';
  for (let x = 0; x < 77; x += 11) for (let y = 0; y < 77; y += 11) { dg.beginPath(); dg.arc(x + 4, y + 6, 1.1, 0, TAU); dg.fill(); }
  TEX.dots = d;

  // film grain frames (animated at 30 fps)
  TEX.grain = [];
  for (let k = 0; k < 6; k++) {
    const gc = mkCanvas(512, 512), gg = gc.getContext('2d');
    const id = gg.createImageData(512, 512);
    const rr = rng(100 + k);
    for (let i = 0; i < id.data.length; i += 4) {
      const v = rr();
      const on = v > 0.5;
      id.data[i] = id.data[i + 1] = id.data[i + 2] = on ? 255 : 0;
      id.data[i + 3] = Math.floor(Math.abs(v - 0.5) * 2 * 20);
    }
    gg.putImageData(id, 0, 0);
    TEX.grain.push(gc);
  }

  // ink speckle mask for stamps (knock-outs)
  const s = mkCanvas(512, 512), sg = s.getContext('2d');
  const rs = rng(31);
  for (let i = 0; i < 1400; i++) {
    sg.fillStyle = `rgba(0,0,0,${0.35 + rs() * 0.65})`;
    sg.beginPath(); sg.arc(rs() * 512, rs() * 512, 0.5 + rs() * 2.4, 0, TAU); sg.fill();
  }
  for (let i = 0; i < 40; i++) {
    sg.strokeStyle = `rgba(0,0,0,${0.2 + rs() * 0.4})`;
    sg.lineWidth = 1 + rs() * 3;
    const x = rs() * 512, y = rs() * 512;
    sg.beginPath(); sg.moveTo(x, y); sg.lineTo(x + 30 + rs() * 90, y + (rs() - 0.5) * 20); sg.stroke();
  }
  TEX.speckle = s;
}

/** Paper background with parallax offset (ox, oy). */
function drawPaper(ctx, ox = 0, oy = 0, base = C.paper, dark = false) {
  ctx.fillStyle = base;
  ctx.fillRect(-200, -200, W + 400, H + 400);
  ctx.save();
  if (dark) ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = dark ? 0.35 : 1;
  const pf = ctx.createPattern(TEX.fibre, 'repeat');
  pf.setTransform(new DOMMatrix().translate(ox * 0.6, oy * 0.6));
  ctx.fillStyle = pf;
  ctx.fillRect(-200, -200, W + 400, H + 400);
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = dark ? 0.0 : 1;
  const pd = ctx.createPattern(TEX.dots, 'repeat');
  pd.setTransform(new DOMMatrix().translate(ox, oy));
  ctx.fillStyle = pd;
  ctx.fillRect(-200, -200, W + 400, H + 400);
  ctx.restore();
}
function drawGrainAndVignette(ctx, t, dark = false) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const k = Math.floor(t * 15 + 1e-6);
  const g = TEX.grain[((k % TEX.grain.length) + TEX.grain.length) % TEX.grain.length];
  const pat = ctx.createPattern(g, 'repeat');
  pat.setTransform(new DOMMatrix().translate((k * 137) % 512, (k * 251) % 512).scale(2, 2));
  ctx.globalAlpha = dark ? 0.55 : 0.85;
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.05);
  v.addColorStop(0, 'rgba(4,24,28,0)');
  v.addColorStop(1, dark ? 'rgba(0,5,7,0.55)' : 'rgba(4,24,28,0.16)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/* ───────────── typography ───────────── */
/** Mono kicker label with decode scramble. */
function kicker(ctx, text, x, y, t, t0, opts = {}) {
  const dt = t - t0;
  if (dt < 0) return;
  const out = opts.out != null ? prog(t, opts.out, opts.out + 0.3) : 0;
  const size = opts.size || 21;
  const col = opts.color || C.ink;
  font(ctx, size, 500, 'mono');
  ctx.letterSpacing = (opts.ls ?? 4.5) + 'px';
  const glyphs = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%';
  const n = text.length;
  const per = opts.speed || 0.018;
  let s = '';
  for (let i = 0; i < n; i++) {
    const ti = dt - i * per;
    const ch = text[i];
    if (ti < 0) break;
    if (ti < 0.12 && ch !== ' ') s += glyphs[Math.floor(hash(i * 13 + Math.floor(t * 40)) * glyphs.length)];
    else s += ch;
  }
  ctx.save();
  ctx.globalAlpha = (opts.alpha ?? 1) * (1 - out);
  ctx.textBaseline = 'middle';
  ctx.textAlign = opts.align || 'left';
  let tx = x;
  if (opts.dot !== false && (opts.align || 'left') === 'left') {
    const p = E.outBack(prog(dt, 0, 0.3));
    ctx.fillStyle = opts.dotColor || C.pink;
    ctx.beginPath(); ctx.arc(x + 6, y, 6.5 * p, 0, TAU); ctx.fill();
    tx = x + 26;
  }
  ctx.fillStyle = col;
  ctx.fillText(s, tx, y + 1 - out * 8);
  ctx.restore();
}

/**
 * Kinetic two-line headline. lines: [{text, color, at}] ; words rise out of a
 * mask with stagger and a riso two-ink misregistration that snaps into place.
 */
function headline(ctx, lines, x, y, t, opts = {}) {
  const size = opts.size || 108;
  const lh = size * (opts.lh || 1.0);
  const out = opts.out;
  const align = opts.align || 'left';
  font(ctx, size, 800, 'display');
  ctx.letterSpacing = (-size * 0.016) + 'px';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((ln, li) => {
    const words = ln.text.split(' ');
    const ly = y + li * lh;
    const sp = ctx.measureText(' ').width * 0.9;
    const widths = words.map((w) => ctx.measureText(w).width);
    const total = widths.reduce((a, b) => a + b, 0) + sp * (words.length - 1);
    let wx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    words.forEach((w, wi) => {
      const t0 = ln.at + wi * (opts.stagger ?? 0.07);
      const p = prog(t, t0, t0 + 0.62);
      if (p <= 0) { wx += widths[wi] + sp; return; }
      const e = E.outExpo(p);
      let dy = (1 - e) * size * 0.95;
      let oa = 1;
      if (out != null) {
        const to = out + (li * words.length + wi) * 0.03;
        const po = E.inCubic(prog(t, to, to + 0.32));
        dy -= po * size * 1.05;
        oa = 1 - po;
      }
      const reg = 1 - spring(t - t0, 1.6, 6.5);
      ctx.save();
      // mask: only the line box shows
      ctx.beginPath();
      ctx.rect(wx - 20, ly - size * 0.98, widths[wi] + 40, size * 1.26);
      ctx.clip();
      ctx.globalAlpha = oa;
      const color = ln.color || C.ink;
      if (Math.abs(reg) > 0.01) {
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = ln.color ? C.teal : C.pink;
        ctx.fillText(w, wx + reg * 16, ly + dy + reg * 9);
        ctx.fillStyle = C.mustard;
        ctx.fillText(w, wx - reg * 12, ly + dy - reg * 6);
        ctx.globalCompositeOperation = 'source-over';
      }
      if (ln.shadow) {
        ctx.fillStyle = ln.shadow;
        ctx.fillText(w, wx + 4, ly + dy + 4);
      }
      ctx.fillStyle = color;
      ctx.fillText(w, wx, ly + dy);
      ctx.restore();
      wx += widths[wi] + sp;
    });
  });
}

/* ───────────── props ───────────── */
/** Translucent tape strip with torn ends. p = 0..1 lay-down progress. */
function tape(ctx, x, y, w, h, rot, p = 1, color = C.tape) {
  if (p <= 0) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  const s = lerp(1.25, 1, E.outCubic(p));
  ctx.scale(s, s);
  ctx.globalAlpha = clamp(p * 1.6);
  ctx.beginPath();
  const teeth = 6;
  ctx.moveTo(-w / 2, -h / 2);
  for (let i = 0; i <= teeth; i++) ctx.lineTo(-w / 2 + (i % 2 ? 4 : 0), -h / 2 + (h * i) / teeth);
  ctx.lineTo(w / 2, h / 2);
  for (let i = teeth; i >= 0; i--) ctx.lineTo(w / 2 - (i % 2 ? 4 : 0), -h / 2 + (h * i) / teeth);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(-w / 2 + 4, -h / 2 + 3, w - 8, h * 0.28);
  ctx.restore();
}

/**
 * Rubber stamp. p = time since the slam (s). Before the slam (p<0) it hovers
 * above (bigger, transparent). Ink texture via the speckle mask.
 */
const STAMP_CACHE = new Map();
function stampImage(text, color, opts) {
  const key = text + color + JSON.stringify(opts);
  if (STAMP_CACHE.has(key)) return STAMP_CACHE.get(key);
  const size = opts.size || 64;
  const c0 = mkCanvas(10, 10).getContext('2d');
  font(c0, size, 800, opts.mono ? 'mono' : 'display', 'condensed');
  c0.letterSpacing = (opts.mono ? 6 : 2) + 'px';
  const tw0 = c0.measureText(text).width;
  const padX = size * 0.45, padY = size * 0.28;
  const w = Math.ceil(tw0 + padX * 2 + 20), h = Math.ceil(size + padY * 2 + 20);
  const round = opts.round;
  const cw = round ? Math.max(w, h) + 20 : w, ch = round ? cw : h;
  const cv = mkCanvas(cw, ch), g = cv.getContext('2d');
  g.translate(cw / 2, ch / 2);
  g.strokeStyle = color; g.fillStyle = color;
  if (round) {
    const R = cw / 2 - 12;
    g.lineWidth = size * 0.09;
    g.beginPath(); g.arc(0, 0, R, 0, TAU); g.stroke();
    g.lineWidth = size * 0.045;
    g.beginPath(); g.arc(0, 0, R - size * 0.18, 0, TAU); g.stroke();
  } else {
    g.lineWidth = size * 0.085;
    g.beginPath(); g.roundRect(-w / 2 + 10, -h / 2 + 10, w - 20, h - 20, size * 0.16); g.stroke();
    g.lineWidth = size * 0.035;
    g.beginPath(); g.roundRect(-w / 2 + 10 + size * 0.14, -h / 2 + 10 + size * 0.14, w - 20 - size * 0.28, h - 20 - size * 0.28, size * 0.1); g.stroke();
  }
  font(g, size, 800, opts.mono ? 'mono' : 'display', 'condensed');
  g.letterSpacing = (opts.mono ? 6 : 2) + 'px';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 3, size * 0.06);
  // knock out speckles
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'destination-out';
  const pat = g.createPattern(TEX.speckle, 'repeat');
  pat.setTransform(new DOMMatrix().translate(hash(text.length * 3) * 400, hash(text.length * 7) * 400));
  g.fillStyle = pat;
  g.fillRect(0, 0, cw, ch);
  STAMP_CACHE.set(key, cv);
  return cv;
}
function stamp(ctx, text, x, y, rot, dt, color, opts = {}) {
  if (dt < -0.18) return;
  const img = stampImage(text, color, opts);
  const scale = opts.scale || 1;
  let s, a;
  if (dt < 0) {
    const k = prog(dt, -0.18, 0);
    s = lerp(1.9, 1.0, E.inQuad(k));
    a = k * 0.5;
  } else {
    s = 1 + 0.07 * Math.exp(-dt * 10) * Math.cos(dt * 40);
    a = 1;
    if (opts.fade != null) a *= 1 - prog(dt, opts.fade, opts.fade + 0.3);
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(s * scale, s * scale);
  ctx.globalAlpha = a * (opts.alpha ?? 0.92);
  ctx.globalCompositeOperation = opts.blend || 'multiply';
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  ctx.restore();
  // ink splash specks at impact
  if (dt >= 0 && dt < 0.5 && opts.specks !== false) {
    const r = rng(Math.floor(x * 7 + y));
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = (1 - dt / 0.5) * 0.8;
    for (let i = 0; i < 14; i++) {
      const a0 = r() * TAU, d0 = (img.width * 0.5 + r() * 60) * scale;
      const dd = d0 + E.outExpo(clamp(dt * 3)) * 30 * r();
      ctx.beginPath();
      ctx.arc(x + Math.cos(a0) * dd, y + Math.sin(a0) * dd * 0.6, 1.5 + r() * 4, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Halftone floor shadow ellipse. */
function halftoneShadow(ctx, cx, cy, rx, ry, alpha = 0.18, sp = 7) {
  ctx.save();
  ctx.fillStyle = C.ink;
  ctx.globalAlpha = alpha;
  for (let x = -rx; x <= rx; x += sp) {
    for (let y = -ry; y <= ry; y += sp) {
      const k = 1 - (x * x) / (rx * rx) - (y * y) / (ry * ry);
      if (k <= 0) continue;
      ctx.beginPath();
      ctx.arc(cx + x, cy + y, sp * 0.48 * Math.sqrt(k), 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** Coin character via the art package. o: {look, r, expr, lookX, lookY, time, sx, sy, rot, alpha} */
function coin(ctx, x, y, o) {
  const A = window.CoinnibalArt;
  ctx.save();
  ctx.translate(x, y);
  if (o.rot) ctx.rotate(o.rot);
  ctx.scale(o.sx ?? 1, o.sy ?? 1);
  if (o.alpha != null) ctx.globalAlpha = o.alpha;
  A.drawRisoCoin(ctx, o.look, o.r, {
    time: (o.time ?? 0) * 1000,
    lookX: o.lookX ?? 0, lookY: o.lookY ?? 0,
    expression: o.expr || 'happy',
    pxPerUnit: 1, seed: o.seed ?? 0,
    flags: o.flags ?? 0,
  });
  ctx.restore();
}

/* ───────────── the Coinnibal marks (apps/web/src/design/motifs/brandShapes.ts + Wordmark.tsx) ─────────────
 * The same paths, drawn with Path2D: the COINNIBAL letters are brush skeletons stroked with a fat round pen,
 * the "O" is the gold bitten coin; the coin mark is the bitten cyan coin with a cream C; the chomp mark is
 * the C as a fanged mouth closing on a scared gold coin. */
const BITTEN_COIN = 'M46 -0.63 A46 46 0 1 1 -7.36 -45.41 A15.64 15.64 0 0 0 13.63 -31.98 A16.27 16.27 0 0 0 29.13 -18.98 A15.64 15.64 0 0 0 46 -0.63Z';
const MARK_C = 'M13 -14 C8 -22 -13 -24 -13 0 C-13 24 8 22 13 14';
const WORD_LETTERS = [
  { d: 'M62 30 C52 12 16 12 16 56 C16 100 52 100 62 82', x: 0, rot: -4, dy: 1, shine: 'M8 40 v12' },
  { x: 78, rot: 3, dy: 2 },
  { d: 'M28 18 V94', x: 158, rot: -2, dy: -2, shine: 'M20 32 v12' },
  { d: 'M16 94 V18 L60 94 V18', x: 208, rot: 2.5, dy: 3, shine: 'M8 34 v12' },
  { d: 'M16 94 V18 L60 94 V18', x: 288, rot: -2, dy: -1, shine: 'M8 34 v12' },
  { d: 'M28 18 V94', x: 358, rot: 3, dy: 2, shine: 'M20 32 v12' },
  { d: 'M16 94 V18 H36 C62 18 62 54 36 54 H16 M36 54 C68 54 68 94 36 94 H16', x: 408, rot: -3, dy: 0, shine: 'M8 34 v12' },
  { d: 'M12 94 L38 18 L64 94 M24 68 H52', x: 488, rot: 2, dy: 2, shine: 'M18 50 l5 -14' },
  { d: 'M16 18 V94 H56', x: 568, rot: -2.5, dy: -1, shine: 'M8 32 v14' },
];
const WORD_W = 654, WORD_H = 128, WORD_COIN_SCALE = 0.9;
const P2D = new Map();
const path2d = (d) => { let p = P2D.get(d); if (!p) { p = new Path2D(d); P2D.set(d, p); } return p; };
const PAINT = { cyan: [C.cyan, C.cyanShade], sun: [C.sun, C.sunShade], cream: [C.cream, C.creamShade], foam: [C.foam, '#69B4CC'] };
function strokeP(ctx, d, color, w) { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke(path2d(d)); }
/** The bitten coin in its own units (radius 46), paint 'sun' or 'cyan'; with the cream C for the coin mark. */
function bittenCoin(ctx, paint = 'sun', o = {}) {
  const [lit, shade] = PAINT[paint];
  const bc = path2d(BITTEN_COIN);
  ctx.save();
  ctx.save(); ctx.translate(o.shadow ?? 5, o.shadow ?? 5); ctx.fillStyle = C.ink; ctx.fill(bc); ctx.lineWidth = o.edge ?? 6; ctx.strokeStyle = C.ink; ctx.stroke(bc); ctx.restore();
  ctx.fillStyle = shade; ctx.fill(bc);
  ctx.save(); ctx.clip(bc); ctx.fillStyle = lit; ctx.beginPath(); ctx.arc(-5, -7, 44, 0, TAU); ctx.fill(); ctx.restore();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.arc(0, 0, o.c ? 36 : 30, 0, TAU); ctx.strokeStyle = shade; ctx.lineWidth = o.c ? 3 : 4;
  ctx.save(); ctx.clip(bc); ctx.stroke(); ctx.restore();
  ctx.globalAlpha *= 0.85; strokeP(ctx, 'M-36 -10 A37 37 0 0 1 -18 -32', '#FFFFFF', 6); ctx.globalAlpha /= 0.85;
  ctx.strokeStyle = C.ink; ctx.lineWidth = o.edge ?? 7.2; ctx.stroke(bc);
  if (o.c) {
    ctx.translate(-4, 4);
    ctx.save(); ctx.translate(3, 3); strokeP(ctx, MARK_C, C.ink, 22); ctx.restore();
    strokeP(ctx, MARK_C, C.ink, 22);
    strokeP(ctx, MARK_C, C.cream, 14);
  }
  ctx.restore();
}
/** The coin mark centred at (x, y), radius r (px). */
function brandMark(ctx, x, y, r, paint = 'cyan', alpha = 1) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.scale(r / 46, r / 46);
  bittenCoin(ctx, paint, { c: true, shadow: 4, edge: 5 });
  ctx.restore();
}
/** One wordmark letter (or the coin O) in its 80 x 112 cell. */
function wordLetter(ctx, l, paint) {
  const [lit, shade] = PAINT[paint];
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (!l.d) {
    ctx.save(); ctx.translate(40, 56); ctx.scale(WORD_COIN_SCALE, WORD_COIN_SCALE);
    bittenCoin(ctx, paint === 'sun' ? 'cyan' : 'sun', { shadow: 5 / WORD_COIN_SCALE, edge: (6 / WORD_COIN_SCALE) * 1.2 });
    ctx.restore();
    return;
  }
  ctx.save(); ctx.translate(5, 5); strokeP(ctx, l.d, C.ink, 30); ctx.restore();
  strokeP(ctx, l.d, C.ink, 30);
  strokeP(ctx, l.d, shade, 24);
  ctx.save(); ctx.translate(-1.6, -1.8); strokeP(ctx, l.d, lit, 19); ctx.restore();
  if (l.shine) { ctx.save(); ctx.translate(5, 0); strokeP(ctx, l.shine, C.mist, 4.5); ctx.restore(); }
}
/**
 * The COINNIBAL wordmark, `height` px tall, its left edge at x (or centred), top at y.
 * o.letter(i) -> {p (0..1 arrival), dy, rot, s} animates each letter; o.diecut adds the cream sticker halo.
 * Returns the box and the centre of the coin O (for match cuts).
 */
function wordmark(ctx, x, y, height, o = {}) {
  const k = height / WORD_H;
  const w = WORD_W * k;
  const x0 = o.center ? x - w / 2 : x;
  const paint = o.paint || 'cyan';
  ctx.save();
  ctx.translate(x0 + 6 * k, y + 4 * k);
  ctx.scale(k, k);
  if (o.alpha != null) ctx.globalAlpha = o.alpha;
  const anim = (i) => (o.letter ? o.letter(i) : { p: 1 });
  if (o.diecut) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const halo = (l, extra) => (l.d ? 24 + 6 + 26 + extra : 46 * WORD_COIN_SCALE * 2 + 26 + extra);
    for (const pass of [['s', C.ink, 6], ['o', C.ink, 6], ['c', C.cream, 0]]) {
      WORD_LETTERS.forEach((l, i) => {
        const a = anim(i); if (a.p <= 0) return;
        ctx.save(); ctx.translate(l.x, l.dy + (a.dy || 0)); if (pass[0] === 's') ctx.translate(6, 6);
        ctx.translate(40, 56); ctx.rotate(((l.rot + (a.rot || 0)) * Math.PI) / 180); ctx.scale(a.s ?? 1, a.s ?? 1); ctx.translate(-40, -56);
        strokeP(ctx, l.d || 'M40 56 h0.1', pass[1], halo(l, pass[2]));
        ctx.restore();
      });
    }
  }
  WORD_LETTERS.forEach((l, i) => {
    const a = anim(i); if (a.p <= 0) return;
    ctx.save();
    ctx.translate(l.x, l.dy + (a.dy || 0));
    ctx.translate(40, 56); ctx.rotate(((l.rot + (a.rot || 0)) * Math.PI) / 180); ctx.scale(a.s ?? 1, a.s ?? 1); ctx.translate(-40, -56);
    if (a.alpha != null) ctx.globalAlpha *= a.alpha;
    wordLetter(ctx, l, paint);
    ctx.restore();
  });
  ctx.restore();
  return { x: x0, y, w, h: height, ox: x0 + (6 + 78 + 40) * k, oy: y + (4 + 2 + 56) * k, or: 46 * WORD_COIN_SCALE * k };
}
/**
 * The chomp mark centred at (x, y), `size` px across. bite: 0 = jaws open, 1 = closed on the coin;
 * eye: blink 0..1; prey: 0..1 how far the scared coin has been pulled into the mouth (1 = gone).
 */
function chompMark(ctx, x, y, size, o = {}) {
  const k = size / 114;
  const bite = o.bite ?? 0.4, prey = o.prey ?? 0;
  ctx.save();
  ctx.translate(x, y); ctx.scale(k, k); ctx.translate(-5, -2);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // jaw opening: the C's ends swing apart (bite 0) or close to the stock mark (bite 1)
  const open = (1 - bite) * 0.5;
  const a0 = Math.atan2(23, 19.3) + open, R = 30;
  const C_D = `M${(R * Math.cos(-a0)).toFixed(2)} ${(R * Math.sin(-a0)).toFixed(2)} A30 30 0 1 0 ${(R * Math.cos(a0)).toFixed(2)} ${(R * Math.sin(a0)).toFixed(2)}`;
  // inside the mouth
  ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(0, 0, 22, 0, TAU); ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.arc(0, 0, 22, 0, TAU); ctx.clip();
  ctx.fillStyle = C.blush; ctx.beginPath(); ctx.ellipse(2, 14, 14, 7, 0, 0, TAU); ctx.fill(); ctx.restore();
  // the prey coin (pulled in and shrinking)
  if (prey < 1) {
    const px = lerp(35, 6, E.inCubic(prey)), ps = 1 - prey * 0.85;
    ctx.save(); ctx.translate(px, 0); ctx.scale(ps, ps); ctx.rotate(Math.sin((o.time ?? 0) * 30) * 0.08 * (1 - prey));
    ctx.fillStyle = C.sun; ctx.strokeStyle = C.ink; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(0, 0, 12.5, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = C.sunShade; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(0, 0, 7.5, 0, TAU); ctx.stroke();
    ctx.fillStyle = '#FFFFFF'; ctx.strokeStyle = C.ink; ctx.lineWidth = 1.6;
    for (const ex of [2.5, 8.5]) { ctx.beginPath(); ctx.arc(ex, -2.5, 2.8, 0, TAU); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle = C.ink; ctx.beginPath(); ctx.ellipse(5.5, 5, 1.8, 2.4, 0, 0, TAU); ctx.fill();
    ctx.restore();
  }
  // crumbs
  const cr = o.crumbs ?? 1;
  if (cr > 0) {
    ctx.fillStyle = C.sun; ctx.strokeStyle = C.ink; ctx.lineWidth = 2.5;
    [[53, -15, 4], [46, -26, 2.8], [54, 13, 3]].forEach(([cx, cy, r], i) => {
      const b = Math.sin((o.time ?? 0) * 6 + i * 2) * 1.5;
      ctx.beginPath(); ctx.arc(cx + (1 - cr) * -10, cy + b, r * cr, 0, TAU); ctx.fill(); ctx.stroke();
    });
  }
  // the C
  ctx.save(); ctx.translate(4, 4); strokeP(ctx, C_D, C.ink, 33); ctx.restore();
  strokeP(ctx, C_D, C.ink, 33);
  strokeP(ctx, C_D, C.cyanShade, 24);
  ctx.save(); ctx.beginPath(); ctx.arc(-8, -10, 42, 0, TAU); ctx.clip(); strokeP(ctx, C_D, C.cyan, 24); ctx.restore();
  ctx.globalAlpha *= 0.85; strokeP(ctx, 'M-35 12 A36 36 0 0 1 -30 -18', '#FFFFFF', 4.5); ctx.globalAlpha /= 0.85;
  // fangs: upper pair turns with the upper jaw, lower pair with the lower jaw
  const fang = (sgn) => {
    ctx.save(); ctx.rotate(-sgn * open);
    const d = sgn < 0 ? 'M12 -9 L15.5 0 L19.5 -9.5Z M21.5 -10 L24.5 -2 L28 -10.5Z' : 'M12 9 L15.5 0 L19.5 9.5Z M21.5 10 L24.5 2 L28 10.5Z';
    ctx.fillStyle = '#FFFFFF'; ctx.fill(path2d(d)); ctx.strokeStyle = C.ink; ctx.lineWidth = 2.2; ctx.stroke(path2d(d));
    ctx.restore();
  };
  fang(-1); fang(1);
  // the hungry eye and brow
  const blink = o.eye ?? 0;
  ctx.save(); ctx.translate(-10, -28); ctx.scale(1, 1 - blink * 0.9);
  ctx.fillStyle = '#FFFFFF'; ctx.strokeStyle = C.ink; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(0, 0, 10.5, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(4, 2.5, 5, 0, TAU); ctx.fill();
  ctx.fillStyle = '#FFFFFF'; ctx.beginPath(); ctx.arc(5.5, 0.8, 1.5, 0, TAU); ctx.fill();
  ctx.restore();
  strokeP(ctx, 'M-24 -44 L1 -37', C.ink, 5);
  ctx.restore();
}
/** The $NIBAL token: a small gold coin with a riso ghost and an N, r px. spin turns it edge-on. */
function nibal(ctx, x, y, r, o = {}) {
  if (r <= 0.3) return;
  ctx.save();
  ctx.translate(x, y);
  if (o.rot) ctx.rotate(o.rot);
  ctx.scale(Math.max(0.12, Math.abs(Math.cos(o.spin || 0))), 1);
  if (o.alpha != null) ctx.globalAlpha = o.alpha;
  ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(r * 0.12, r * 0.14, r, 0, TAU); ctx.fill();
  ctx.fillStyle = C.sunShade; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.clip(); ctx.fillStyle = C.sun; ctx.beginPath(); ctx.arc(-r * 0.1, -r * 0.14, r * 0.95, 0, TAU); ctx.fill(); ctx.restore();
  ctx.strokeStyle = C.ink; ctx.lineWidth = Math.max(1.5, r * 0.12); ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
  ctx.strokeStyle = C.sunShade; ctx.lineWidth = Math.max(1, r * 0.08); ctx.beginPath(); ctx.arc(0, 0, r * 0.68, 0, TAU); ctx.stroke();
  if (r > 9) {
    font(ctx, r * 1.0, 900, 'display'); ctx.fillStyle = C.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', 0, r * 0.06);
  }
  ctx.restore();
}

/** Number with thousands separators. */
function fmt(n, dec = 0) {
  const s = Math.abs(n).toFixed(dec);
  const [i, d] = s.split('.');
  const ii = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + ii + (d ? '.' + d : '');
}

/** Counter with tabular (fixed-cell) digits so it never jitters while counting. */
function odometer(ctx, value, x, y, size, opts = {}) {
  const dec = opts.dec || 0;
  const s = fmt(value, dec);
  font(ctx, size, opts.weight || 800, opts.mono ? 'mono' : 'display');
  ctx.letterSpacing = '0px';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = opts.color || C.ink;
  ctx.textAlign = 'center';
  const cell = ctx.measureText('0').width * 0.98;
  const sep = ctx.measureText(',').width * 0.9;
  const widths = [...s].map((ch) => (/\d/.test(ch) ? cell : sep));
  const total = widths.reduce((a, b) => a + b, 0);
  let cx = opts.align === 'right' ? x - total : opts.align === 'center' ? x - total / 2 : x;
  [...s].forEach((ch, i) => { ctx.fillText(ch, cx + widths[i] / 2, y); cx += widths[i]; });
  ctx.textAlign = 'left';
  return total;
}

/** Simple confetti/particle burst. Deterministic via seed. */
function burst(ctx, x, y, dt, opts = {}) {
  if (dt < 0 || dt > (opts.life || 1.2)) return;
  const r = rng(opts.seed || 1);
  const n = opts.n || 26;
  const cols = opts.colors || [C.pink, C.teal, C.mustard, C.blue];
  const life = opts.life || 1.2;
  for (let i = 0; i < n; i++) {
    const a = r() * TAU, v = (opts.speed || 700) * (0.35 + r() * 0.65);
    const g = opts.gravity ?? 900;
    const drag = 2.6;
    const k = (1 - Math.exp(-drag * dt)) / drag;
    const px = x + Math.cos(a) * v * k;
    const py = y + Math.sin(a) * v * k + 0.5 * g * dt * dt * 0.6;
    const life_i = life * (0.6 + r() * 0.4);
    const fa = 1 - prog(dt, life_i * 0.6, life_i);
    if (fa <= 0) continue;
    ctx.save();
    ctx.globalAlpha = fa;
    ctx.fillStyle = cols[i % cols.length];
    ctx.translate(px, py);
    ctx.rotate(r() * TAU + dt * (r() - 0.5) * 14);
    const s = (opts.size || 9) * (0.6 + r() * 0.8);
    if (i % 3 === 0) { ctx.beginPath(); ctx.arc(0, 0, s * 0.6, 0, TAU); ctx.fill(); }
    else ctx.fillRect(-s / 2, -s * 0.3, s, s * 0.6 * (1 - Math.abs(Math.sin(dt * 9 + i))) + 1.5);
    ctx.restore();
  }
}

/** Expanding halftone ring shockwave. */
function shockDots(ctx, x, y, dt, color = C.ink, maxR = 900, alpha = 0.22) {
  if (dt < 0 || dt > 0.9) return;
  const p = E.outCubic(dt / 0.9);
  const R = 60 + p * maxR;
  const n = Math.floor(R * 0.11);
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha * (1 - p);
  for (let ring = 0; ring < 3; ring++) {
    const rr = R - ring * 26;
    if (rr <= 0) continue;
    const m = Math.floor(n * (rr / R));
    for (let i = 0; i < m; i++) {
      const a = (i / m) * TAU + ring * 0.2;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 3.4 - ring, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** Barcode. */
function barcode(ctx, x, y, w, h, seed = 3, color = C.ink) {
  const r = rng(seed);
  ctx.fillStyle = color;
  let cx = x;
  while (cx < x + w) {
    const bw = 1.5 + Math.floor(r() * 4) * 1.4;
    if (r() > 0.42) ctx.fillRect(cx, y, bw, h);
    cx += bw + 1.2;
  }
}

/** Noisy organic radius for ink blobs / burn fronts. */
function blobPath(ctx, x, y, R, seed, rough = 0.08, steps = 120, phase = 0) {
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * TAU;
    const nn = noise1(a * 3 + seed, seed) * 0.6 + noise1(a * 9 + seed * 2, seed + 1) * 0.3 + noise1(a * 23 + phase, seed + 2) * 0.1;
    const rr = R * (1 + nn * rough);
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

Object.assign(window, {
  W, H, TAU, C, FONT, clamp, lerp, prog, E, spring, tw, hash, rng, noise1, shake,
  mkCanvas, font, rrect, ticketPath, sideTicketPath, dashed, paperShadow, TEX, buildTextures,
  drawPaper, drawGrainAndVignette, kicker, headline, tape, stamp, stampImage, halftoneShadow,
  coin, brandMark, wordmark, chompMark, bittenCoin, nibal, fmt, odometer, burst, shockDots, barcode, blobPath,
});
