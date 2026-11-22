/* Coinnibal "Appetizers are served" (13 s, 120 BPM: a beat is 0.5 s, downbeats on the even seconds).
 *
 * The X launch film for The Appetizer, the free early card of coinnibal.fun. One table, a teal gingham cloth:
 *   0.0  ORDER UP      a brass service bell pops onto the table and rings twice (0.5, 0.75): DING!; a menu slip
 *                      drops in: "Now serving · Early cards / The Appetizer / Your Coinnibal early card".
 *   2.0  THE DEAL      the cards are dealt onto the table, one after another, each with its own guest and coin:
 *                      No. 0001 @coinnibalfun (2.0), 0002 @nibble_queen (2.75), 0003 @coin_chef (3.5), then faster
 *                      and faster (quarters from 4.0, eighths from 5.0) until the table is a pile of orders;
 *                      the strip on top says "Early cards, coming right up".
 *   6.0  THE CLOCHE    the pile is swept off; one more card slides in, big: "Table for @you", No. 0042, its plate
 *                      under a silver cloche. The cloche rattles and lifts (7.0): the coin in its napkin looks up,
 *                      blinks, grins; the SERVED stamp thumps onto the card (8.0).
 *   9.5  END CARD      the card steps aside; the menu panel: wordmark, "Appetizers are served.",
 *                      "Follow @coinnibalfun", "Grab your early card at <SITE_HOST>".
 *
 * Every card is the real one: drawAppetizerCard of packages/art (bundled by ../build-art.mjs), with the card's own
 * Fraunces cut. The dealt cards are drawn once into bitmaps; the hero card is drawn as vectors every frame (a
 * context proxy keeps the card's setTransform(identity) inside our transform) so it stays sharp at 1.3x.
 * Landscape, square and portrait from the same code (?w=&h=). Copy: no ticker, no prices, nothing the card gives.
 */
'use strict';
window.SITE_HOST = QS.get('site') || 'coinnibal.fun';
(() => {
  const A = window.CoinnibalArt;
  const MODE = H > W ? 'portrait' : W === H ? 'square' : 'landscape';
  const CW = 1200, CH = 675; // APPETIZER_IMAGE
  const CARD_FONT = '"Fraunces Card"';
  const FONTS = { display: CARD_FONT, body: '"DM Sans"', mono: '"Geist Mono"' };
  const DAY = Date.UTC(2026, 10, 22, 12); // the day the Appetizers went out
  const INK = C.ink, CREAM = C.cream, TEAL_INK = '#1F5566';

  /* ── the beats ── */
  const DING = [0.5, 0.75];
  const SWEEP = 5.95, HERO_IN = 6.15, HERO_LAND = 6.5;
  const RATTLE = 6.72, LIFT = 7.0, BLINK = 7.42, GRIN = 7.6, STAMP = 8.0;
  const OUTRO = 9.45, END = 10.0, DUR = 13.0;

  /* ── the guests (made up), in the order they are dealt ── */
  const GUESTS = [
    ['coinnibalfun', 1], ['nibble_queen', 2], ['coin_chef', 3], ['bitebybite', 4], ['crumb_collector', 5],
    ['sir_munchalot', 7], ['snackoverflow', 9], ['penny_gobbler', 12], ['tiny_forks', 15], ['gravy_goblin', 18],
    ['second_helping', 21], ['dime_devourer', 26], ['salt_and_coin', 30], ['late_night_nibs', 34], ['chompette', 38],
  ];
  const HERO = { handle: 'you', no: 42 };
  // landing times: three slow ones (readable), then quarters, then eighths
  const LAND = [2.0, 2.75, 3.5, 4.0, 4.25, 4.5, 4.75, 5.0, 5.125, 5.25, 5.375, 5.5, 5.625, 5.75, 5.875];

  /* ── layout per frame shape ── */
  const LAY = (() => {
    if (MODE === 'landscape') return {
      band: 96, bell: [1470, 712, 380], ticket: [720, 470, 960],
      slow: [[900, 500, -0.035, 1180, Math.PI], [1010, 560, 0.03, 1180, 0], [950, 530, -0.018, 1180, -Math.PI / 2]],
      fastW: 820, fastBox: [0.2, 0.22, 0.8, 0.78], caption: [960, 1000, 56],
      hero: [960, 530, -0.012, 1580], heroEnd: [600, 545, -0.035, 1000],
      panel: [1150, 110, 700, 860],
    };
    if (MODE === 'square') return {
      band: 90, bell: [540, 860, 330], ticket: [540, 290, 940],
      slow: [[520, 470, -0.035, 1000, Math.PI], [560, 520, 0.03, 1000, 0], [540, 500, -0.018, 1000, -Math.PI / 2]],
      fastW: 720, fastBox: [0.25, 0.25, 0.75, 0.72], caption: [540, 1000, 48],
      hero: [540, 480, -0.012, 1040], heroEnd: [540, 300, -0.03, 780], heroCap: [540, 960, 50],
      panel: [60, 585, 960, 445],
    };
    return {
      band: 90, bell: [540, 1400, 470], ticket: [540, 560, 960],
      slow: [[540, 640, -0.035, 1010, Math.PI], [540, 960, 0.03, 1010, 0], [540, 1280, -0.025, 1010, -Math.PI / 2]],
      fastW: 820, fastBox: [0.3, 0.2, 0.7, 0.78], caption: [540, 1700, 56],
      hero: [540, 1020, -0.012, 1040], heroEnd: [540, 650, -0.03, 990], heroCap: [540, 520, 62],
      panel: [60, 1010, 960, 760],
    };
  })();

  /* ── the dealt cards: pose and flight ── */
  const DEAL = GUESTS.map(([handle, no], i) => {
    const r = rng(1000 + i * 17);
    let x, y, rot, w, from;
    if (i < 3) [x, y, rot, w, from] = LAY.slow[i];
    else {
      const b = LAY.fastBox;
      x = W * lerp(b[0], b[2], r()); y = H * lerp(b[1], b[3], r());
      rot = (r() - 0.5) * 0.44; w = LAY.fastW * lerp(0.9, 1.06, r());
      // come in from the side the card sits on, give or take
      from = Math.atan2(y - H / 2, x - W / 2) + (r() - 0.5) * 0.8;
    }
    const fly = i < 3 ? 0.3 : i < 7 ? 0.22 : 0.17;
    // swept off the table: away from the centre, top cards first
    const out = Math.atan2(y - H / 2 + 1, x - W / 2) + (r() - 0.5) * 0.5;
    return { handle, no, x, y, rot, w, from, land: LAND[i], fly, spin: (r() - 0.5) * 1.2, out, outAt: SWEEP + (GUESTS.length - 1 - i) * 0.012 };
  });
  const BITMAP = [];

  /* ── helpers ── */
  /** A context whose setTransform(identity) lands on our current transform (the card resets it on entry). */
  function lifted(ctx) {
    const base = ctx.getTransform();
    return new Proxy(ctx, {
      get(t, p) {
        if (p === 'setTransform') return (...a) => {
          t.setTransform(base);
          if (a.length === 6) t.transform(...a);
          else if (a.length === 1 && a[0]) t.transform(a[0].a, a[0].b, a[0].c, a[0].d, a[0].e, a[0].f);
        };
        if (p === 'resetTransform') return () => t.setTransform(base);
        const v = Reflect.get(t, p, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
      set(t, p, v) { t[p] = v; return true; },
    });
  }
  function cardFont(ctx, size, weight = 800) {
    ctx.font = `${weight} ${size}px ${CARD_FONT}`;
    ctx.fontStretch = 'normal';
    ctx.letterSpacing = '0px';
  }
  function fitCard(ctx, text, size, maxW, weight = 800) {
    let s = size;
    cardFont(ctx, s, weight);
    while (s > 16 && ctx.measureText(text).width > maxW) { s -= 2; cardFont(ctx, s, weight); }
    return s;
  }
  /** Spaced mono caps, centred or left of x. */
  function caps(ctx, text, x, y, size, color, align = 'center', weight = 600, gap = 0.14) {
    font(ctx, size, weight, 'mono');
    ctx.letterSpacing = `${size * gap}px`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text.toUpperCase(), x + (align === 'center' ? size * gap * 0.5 : 0), y);
    ctx.letterSpacing = '0px';
  }
  /** A blink as the art package draws one (faces.ts: blinking while (time + seed*977) % 4600 < 140). */
  function blinkTime(seed) {
    return ((4600 - ((seed * 977) % 4600)) % 4600) + 70 + 4600;
  }

  /* ── the table ── */
  function table(ctx) {
    const b = LAY.band;
    ctx.fillStyle = '#245F70';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(4, 24, 28, 0.30)';
    const ox = (W / 2) % (b * 2), oy = (H / 2) % (b * 2);
    for (let x = ox - b * 2 - b / 2; x < W; x += b * 2) ctx.fillRect(x, 0, b, H);
    for (let y = oy - b * 2 - b / 2; y < H; y += b * 2) ctx.fillRect(0, y, W, b);
    ctx.strokeStyle = 'rgba(219, 242, 249, 0.08)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = ox - b * 2 - b / 2; x < W; x += b) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = oy - b * 2 - b / 2; y < H; y += b) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    // a soft pool of light on the middle of the table
    const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.75);
    v.addColorStop(0, 'rgba(4,24,28,0)');
    v.addColorStop(1, 'rgba(4,24,28,0.42)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  /* ── a card on the table: a cream print frame round the real card ── */
  const B = 18, RR = 26;
  /**
   * Draws a framed card centred at (x, y), `w` px wide (the card's own width), turned by rot. lift 0 = flat on the
   * cloth, 1 = in the air (a longer, softer shadow). content(ctx) draws the card in card units (0..1200 × 0..675).
   */
  function framed(ctx, x, y, w, rot, lift, content, after) {
    const s = w / CW;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(s, s);
    ctx.translate(-CW / 2, -CH / 2);
    // the hard shadow, longer while it is in the air
    const off = 14 + lift * 50;
    ctx.save();
    ctx.globalAlpha *= 0.55 - lift * 0.2;
    rrect(ctx, -B + off * 0.8, -B + off, CW + 2 * B, CH + 2 * B, RR);
    ctx.fillStyle = '#020E11';
    ctx.fill();
    ctx.restore();
    rrect(ctx, -B, -B, CW + 2 * B, CH + 2 * B, RR);
    ctx.fillStyle = CREAM;
    ctx.fill();
    ctx.save();
    rrect(ctx, 0, 0, CW, CH, 10);
    ctx.clip();
    content(ctx);
    ctx.restore();
    ctx.lineJoin = 'round';
    rrect(ctx, 0, 0, CW, CH, 10);
    ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.stroke();
    rrect(ctx, -B, -B, CW + 2 * B, CH + 2 * B, RR);
    ctx.lineWidth = 6; ctx.stroke();
    if (after) after(ctx);
    ctx.restore();
  }

  /* ── the service bell ── */
  function bell(ctx, t) {
    const [x, y, size] = LAY.bell;
    const pop = E.outBack(prog(t, 0.05, 0.4), 2.2);
    const gone = prog(t, 1.75, 2.05);
    if (pop <= 0 || gone >= 1) return;
    let press = 0;
    for (const d of DING) { const dt = t - d; if (dt > -0.05 && dt < 0.12) press = Math.max(press, dt < 0 ? 1 + dt / 0.05 : 1 - dt / 0.12); }
    ctx.save();
    ctx.translate(x, y + E.inBack(gone) * H * 0.7);
    ctx.scale(pop, pop);
    const rx = size * 0.42, ry = size * 0.4, bh = size * 0.1;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // shadow
    ctx.beginPath(); ctx.ellipse(16, bh + 14, size * 0.55, size * 0.12, 0, 0, TAU);
    ctx.fillStyle = 'rgba(2,14,17,0.5)'; ctx.fill();
    // base: a dark disc with its edge
    ctx.beginPath(); ctx.ellipse(0, bh, size * 0.52, size * 0.12, 0, 0, TAU);
    ctx.fillStyle = C.reef; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 6; ctx.stroke();
    ctx.fillStyle = C.reef;
    ctx.fillRect(-size * 0.52, 0, size * 1.04, bh);
    ctx.beginPath(); ctx.moveTo(-size * 0.52, 0); ctx.lineTo(-size * 0.52, bh); ctx.moveTo(size * 0.52, 0); ctx.lineTo(size * 0.52, bh); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(0, 0, size * 0.52, size * 0.12, 0, 0, TAU);
    ctx.fillStyle = C.current; ctx.fill(); ctx.stroke();
    // the dome (squashed a little on a press)
    ctx.save();
    ctx.scale(1 + press * 0.02, 1 - press * 0.04);
    const dome = () => { ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, Math.PI, TAU); ctx.closePath(); };
    dome(); ctx.fillStyle = C.sun; ctx.fill();
    ctx.save(); dome(); ctx.clip();
    ctx.fillStyle = C.sunShade;
    ctx.beginPath(); ctx.ellipse(rx * 0.5, 0, rx * 0.75, ry * 1.1, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = C.sun;
    ctx.beginPath(); ctx.ellipse(-rx * 0.12, 0, rx * 0.8, ry * 1.02, 0, 0, TAU); ctx.fill();
    ctx.restore();
    dome(); ctx.strokeStyle = INK; ctx.lineWidth = 6; ctx.stroke();
    // the glint
    ctx.beginPath(); ctx.ellipse(0, 0, rx * 0.78, ry * 0.8, 0, Math.PI * 1.17, Math.PI * 1.36);
    ctx.strokeStyle = '#FFF6D8'; ctx.lineWidth = 9; ctx.stroke();
    // the rim band
    ctx.beginPath(); ctx.ellipse(0, 0, rx * 1.04, size * 0.045, 0, 0, TAU);
    ctx.fillStyle = C.sunShade; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 5; ctx.stroke();
    // the plunger
    const py = -ry - size * 0.11 + press * size * 0.06;
    ctx.fillStyle = C.mist;
    rrect(ctx, -size * 0.025, py, size * 0.05, -py - ry + 4, 3); ctx.fill(); ctx.lineWidth = 4; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(0, py, size * 0.08, size * 0.045, 0, 0, TAU);
    ctx.fillStyle = C.reef; ctx.fill(); ctx.lineWidth = 5; ctx.stroke();
    ctx.restore();
    // the ring: ink ticks and arcs on each ding
    for (const d of DING) {
      const dt = t - d;
      if (dt < 0 || dt > 0.55) continue;
      const k = E.outCubic(dt / 0.55);
      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = INK; ctx.lineWidth = 7 * (1 - k) + 2;
      for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + s * (0.5 + i * 0.36);
        const r0 = size * (0.5 + k * 0.12), r1 = size * (0.62 + k * 0.2);
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, -ry * 0.35 + Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * r1, -ry * 0.35 + Math.sin(a) * r1); ctx.stroke();
      }
      ctx.restore();
    }
    // DING!
    const dk = t - DING[0];
    if (dk > 0) {
      const p = E.outBack(prog(dk, 0, 0.22), 3);
      const bump = t > DING[1] ? 1 + 0.18 * Math.exp(-(t - DING[1]) * 12) : 1;
      ctx.save();
      ctx.translate(size * 0.12, -ry - size * 0.42);
      ctx.rotate(-0.1);
      ctx.scale(p * bump, p * bump);
      cardFont(ctx, Math.round(size * 0.3));
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = INK; ctx.lineWidth = size * 0.05;
      ctx.strokeText('DING!', 6, 7);
      ctx.fillStyle = INK; ctx.fillText('DING!', 6, 7);
      ctx.strokeText('DING!', 0, 0);
      ctx.fillStyle = C.cream; ctx.fillText('DING!', 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  /* ── the menu slip of the opening ── */
  function ticket(ctx, t) {
    const [x, y, w] = LAY.ticket;
    const k = prog(t, 0.55, 0.95);
    if (k <= 0 || t > 6.2) return;
    const h = w * 0.4;
    const e = E.outBack(k, 1.3);
    ctx.save();
    ctx.translate(x, lerp(-h, y, e));
    ctx.rotate(lerp(0.2, -0.03, e));
    ctx.translate(-w / 2, -h / 2);
    rrect(ctx, 14, 16, w, h, 20); ctx.fillStyle = 'rgba(2,14,17,0.5)'; ctx.fill();
    rrect(ctx, 0, 0, w, h, 20); ctx.fillStyle = CREAM; ctx.fill();
    ctx.save(); ctx.clip(); ctx.fillStyle = C.creamShade; ctx.fillRect(0, h - 12, w, 12); ctx.restore();
    rrect(ctx, 0, 0, w, h, 20); ctx.strokeStyle = INK; ctx.lineWidth = 7; ctx.stroke();
    ctx.strokeStyle = TEAL_INK; ctx.lineWidth = 2.5;
    rrect(ctx, 20, 20, w - 40, h - 40, 10); ctx.stroke();
    ctx.lineWidth = 1.5; rrect(ctx, 28, 28, w - 56, h - 56, 6); ctx.stroke();
    caps(ctx, 'Now serving · Early cards', w / 2, h * 0.2, Math.round(w * 0.028), TEAL_INK, 'center', 700);
    const ts = fitCard(ctx, 'The Appetizer', Math.round(w * 0.135), w - 150);
    ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('The Appetizer', w / 2, h * 0.2 + ts * 1.1);
    // the ornament: rule, sun diamond, rule
    const oy = h * 0.66;
    ctx.strokeStyle = INK; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(w * 0.14, oy); ctx.lineTo(w / 2 - 26, oy); ctx.moveTo(w / 2 + 26, oy); ctx.lineTo(w * 0.86, oy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w / 2, oy - 13); ctx.lineTo(w / 2 + 13, oy); ctx.lineTo(w / 2, oy + 13); ctx.lineTo(w / 2 - 13, oy); ctx.closePath();
    ctx.fillStyle = C.sun; ctx.fill(); ctx.stroke();
    cardFont(ctx, Math.round(w * 0.048), 700);
    ctx.fillStyle = TEAL_INK; ctx.textAlign = 'center';
    ctx.fillText('Your Coinnibal early card', w / 2, h * 0.84);
    ctx.restore();
    tape(ctx, x - w * 0.42, lerp(-h, y, e) - h * 0.5, 150, 40, -0.6, prog(t, 0.82, 0.95));
    tape(ctx, x + w * 0.42, lerp(-h, y, e) - h * 0.5, 150, 40, 0.55, prog(t, 0.86, 0.99));
  }

  /* ── the dealt cards ── */
  function dealt(ctx, t) {
    DEAL.forEach((d, i) => {
      const k = prog(t, d.land - d.fly, d.land);
      if (k <= 0) return;
      const sw = prog(t, d.outAt, d.outAt + 0.32);
      if (sw >= 1) return;
      const e = E.outQuart(k);
      const dist = Math.hypot(W, H) * 0.9;
      let x = d.x + Math.cos(d.from) * dist * (1 - e);
      let y = d.y + Math.sin(d.from) * dist * (1 - e);
      let rot = d.rot + d.spin * (1 - e);
      // the slap: a quick settle after it lands
      const dt = t - d.land;
      const settle = dt > 0 ? 1 + 0.025 * Math.exp(-dt * 18) * Math.cos(dt * 40) : 1;
      let lift = 1 - E.outCubic(k);
      if (sw > 0) {
        const s = E.inCubic(sw);
        x += Math.cos(d.out) * dist * s; y += Math.sin(d.out) * dist * s;
        rot += s * (d.spin > 0 ? 0.6 : -0.6);
        lift = Math.max(lift, s);
      }
      framed(ctx, x, y, d.w * settle, rot, lift, (c) => {
        c.imageSmoothingQuality = 'high';
        c.drawImage(BITMAP[i], 0, 0);
      });
    });
  }

  /* ── the hero card: the real card as vectors, its coin re-posed, a cloche over the plate ── */
  const PX = 958, PY = 470, CR = 112, CY = PY - CR + 26; // packages/art/src/appetizer.ts
  /** The napkin under the coin's chin, as drawAppetizerCard draws it (its napkin(), not exported). */
  function napkin(ctx, r) {
    const top = r * 0.62, half = r * 0.7, tip = r * 1.34;
    const shape = () => {
      ctx.beginPath();
      ctx.moveTo(-half, top);
      ctx.quadraticCurveTo(0, top + r * 0.1, half, top);
      ctx.quadraticCurveTo(half * 0.86, top + r * 0.42, r * 0.12, tip);
      ctx.quadraticCurveTo(0, tip + r * 0.06, -r * 0.12, tip);
      ctx.quadraticCurveTo(-half * 0.86, top + r * 0.42, -half, top);
      ctx.closePath();
    };
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    shape(); ctx.fillStyle = A.ELYSIUM.cream; ctx.fill();
    ctx.save(); ctx.clip();
    const b = r * 0.14;
    ctx.fillStyle = 'rgba(217, 113, 79, 0.55)';
    for (let x = -half - b; x < half + b; x += b * 2) ctx.fillRect(x, top - 4, b, tip - top + 20);
    for (let y = top + b * 0.5; y < tip + b; y += b * 2) ctx.fillRect(-half - 4, y, half * 2 + 8, b);
    ctx.fillStyle = 'rgba(180, 85, 58, 0.30)';
    ctx.beginPath(); ctx.moveTo(r * 0.05, tip + 10); ctx.quadraticCurveTo(half * 0.5, top + r * 0.4, half + 6, top); ctx.lineTo(half + 20, tip + 20); ctx.closePath(); ctx.fill();
    ctx.restore();
    shape(); ctx.strokeStyle = A.INK; ctx.lineWidth = 5; ctx.stroke();
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * half * 0.92, top + 2);
      ctx.quadraticCurveTo(s * (half + r * 0.3), top - r * 0.2, s * (half + r * 0.26), top + r * 0.1);
      ctx.quadraticCurveTo(s * (half + r * 0.12), top + r * 0.16, s * half * 0.92, top + 2);
      ctx.closePath();
      ctx.fillStyle = A.ELYSIUM.coral; ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  const HERO_LOOK = () => A.lookForHandle(HERO.handle);
  let heroLook = null;
  const heroSeed = () => A.hash32(HERO.handle) % 1000;
  /** The coin's face over time. */
  function heroFace(t) {
    const seed = heroSeed();
    let expression = 'happy', lookX = 0, lookY = 0.1, time = 0, pop = 0;
    if (t < BLINK) { lookX = 0.35; lookY = -0.95; expression = 'scared'; }
    else if (t < BLINK + 0.12) { time = blinkTime(seed); lookX = 0.1; lookY = -0.3; }
    else if (t < STAMP - 0.05) { expression = 'love'; lookX = 0; lookY = 0.05; }
    else if (t < STAMP + 0.6) { expression = 'proud'; lookX = -0.55; lookY = 0.45; }
    else { expression = 'happy'; lookX = -0.1; lookY = 0.1; }
    // blink once more on the end card
    for (const b of [9.0, 11.7]) if (t >= b && t < b + 0.12) time = blinkTime(seed);
    // the grin's little bounce, and the jump at the stamp
    const g = t - GRIN; if (g > 0 && g < 0.6) pop = Math.max(pop, 0.06 * Math.exp(-g * 7) * Math.sin(g * 30));
    const s = t - STAMP; if (s > 0 && s < 0.8) pop = Math.max(pop, 0.1 * Math.exp(-s * 6) * Math.abs(Math.cos(s * 18)));
    return { seed, expression, lookX, lookY, time, pop };
  }
  function heroContent(t) {
    return (ctx) => {
      // the stamp: off until it drops, then in the air (> 1) and pressed (1)
      let stamp = 0;
      if (t >= STAMP - 0.16) stamp = t >= STAMP ? 1 : lerp(2.4, 1, E.inQuad(prog(t, STAMP - 0.16, STAMP)));
      A.drawAppetizerCard(lifted(ctx), { no: HERO.no, handle: HERO.handle, at: DAY, host: window.SITE_HOST }, FONTS, { stamp });
      // the coin, re-posed (a little bigger when it bounces, anchored at its foot so the card's own coin never shows)
      const f = heroFace(t);
      ctx.save();
      ctx.translate(PX, CY + CR);
      ctx.scale(1 + f.pop, 1 + f.pop);
      ctx.translate(0, -CR);
      if (!heroLook) heroLook = HERO_LOOK();
      A.drawRisoCoin(lifted(ctx), heroLook, CR, { time: f.time, lookX: f.lookX, lookY: f.lookY, expression: f.expression, pxPerUnit: 1, seed: f.seed });
      napkin(ctx, CR);
      ctx.restore();
      // ink specks at the stamp's thump (the stamp sits at about (552, 542) on the card)
      const dt = t - STAMP;
      if (dt >= 0 && dt < 0.5) {
        const r = rng(77);
        ctx.save();
        ctx.fillStyle = A.TEXT_INKS.day.down;
        ctx.globalAlpha = (1 - dt / 0.5) * 0.85;
        for (let i = 0; i < 16; i++) {
          const a0 = r() * TAU, d0 = 140 + r() * 40 + E.outExpo(clamp(dt * 3)) * 30 * r();
          ctx.beginPath(); ctx.arc(552 + Math.cos(a0) * d0, 542 + Math.sin(a0) * d0 * 0.55, 2 + r() * 5, 0, TAU); ctx.fill();
        }
        ctx.restore();
      }
    };
  }
  /** The cloche over the plate, in card units; lifts off at LIFT. */
  function cloche(ctx, t) {
    const k = prog(t, LIFT, LIFT + 0.55);
    if (k >= 1) return;
    let dx = 0, dy = 0, rot = 0;
    const r = t - RATTLE;
    if (r > 0 && t < LIFT) { rot = Math.sin(r * 70) * 0.035; dy = -Math.abs(Math.sin(r * 35)) * 8; }
    if (k > 0) {
      // a hop up (the peek), then away to the top right
      const up = E.outBack(prog(k, 0, 0.35), 2);
      const away = E.inCubic(prog(k, 0.3, 1));
      dy = -up * 170 - away * 1100;
      dx = away * 700;
      rot = up * 0.18 + away * 0.9;
    }
    const rx = 182, ry = 250, rimY = 62, by = PY + 8;
    ctx.save();
    // its shadow on the plate, while it sits there
    ctx.globalAlpha = 1 - clamp(k * 3);
    ctx.beginPath(); ctx.ellipse(PX + 16, by + 20, rx + 10, rimY + 4, 0, 0, TAU);
    ctx.fillStyle = 'rgba(2,14,17,0.45)'; ctx.fill();
    ctx.globalAlpha = 1;
    ctx.translate(PX + dx, by + dy);
    ctx.rotate(rot);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const dome = () => { ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, Math.PI, TAU); ctx.ellipse(0, 0, rx, rimY, 0, 0, Math.PI); ctx.closePath(); };
    dome(); ctx.fillStyle = C.mist; ctx.fill();
    ctx.save(); dome(); ctx.clip();
    ctx.fillStyle = '#A9D3E0';
    ctx.beginPath(); ctx.ellipse(rx * 0.62, 0, rx * 0.7, ry * 1.1, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = C.mist;
    ctx.beginPath(); ctx.ellipse(-rx * 0.08, 0, rx * 0.82, ry * 1.02, 0, 0, TAU); ctx.fill();
    ctx.restore();
    dome(); ctx.strokeStyle = INK; ctx.lineWidth = 7; ctx.stroke();
    // the glint
    ctx.beginPath(); ctx.ellipse(0, 0, rx * 0.8, ry * 0.82, 0, Math.PI * 1.16, Math.PI * 1.38);
    ctx.strokeStyle = C.white; ctx.lineWidth = 12; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(0, 0, rx * 0.8, ry * 0.82, 0, Math.PI * 1.43, Math.PI * 1.47);
    ctx.stroke();
    // the rim: a rolled band along the front edge
    ctx.beginPath(); ctx.ellipse(0, 0, rx + 10, rimY + 8, 0, 0.04, Math.PI - 0.04);
    ctx.ellipse(0, 0, rx - 6, rimY - 10, 0, Math.PI - 0.04, 0.04, true); ctx.closePath();
    ctx.fillStyle = '#A9D3E0'; ctx.fill(); ctx.lineWidth = 6; ctx.stroke();
    // the knob
    ctx.beginPath(); ctx.ellipse(0, -ry - 4, 24, 10, 0, 0, TAU);
    ctx.fillStyle = '#A9D3E0'; ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, -ry - 22, 20, 0, TAU);
    ctx.fillStyle = C.sun; ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  /** Steam and sparkles from the plate as the cloche comes off. */
  function steam(ctx, t) {
    const dt = t - LIFT - 0.05;
    if (dt < 0 || dt > 1.3) return;
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const p = prog(dt, i * 0.08, 0.85 + i * 0.1);
      if (p <= 0 || p >= 1) continue;
      const x0 = PX + (i - 1) * 70, y0 = CY - CR - 30 - p * 170;
      const len = 120 * (0.4 + 0.6 * E.outCubic(clamp(p * 2)));
      const a = (1 - p) * clamp(p * 5);
      const path = () => {
        ctx.beginPath();
        for (let j = 0; j <= 16; j++) {
          const u = j / 16;
          const x = x0 + Math.sin(u * 5 + p * 6 + i * 2) * 16 * (0.5 + u);
          const y = y0 - u * len;
          j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
      };
      ctx.globalAlpha = a;
      path(); ctx.strokeStyle = INK; ctx.lineWidth = 20; ctx.stroke();
      path(); ctx.strokeStyle = C.white; ctx.lineWidth = 11; ctx.stroke();
    }
    ctx.restore();
    // sparkles
    const sp = [[-200, -150, 26, C.sun], [205, -110, 22, C.cream], [150, -250, 16, C.foam], [-150, -280, 14, C.sun]];
    sp.forEach(([ox, oy, s, fill], i) => {
      const p = prog(dt, 0.05 + i * 0.05, 0.4 + i * 0.05);
      const out = 1 - prog(dt, 0.9, 1.3);
      if (p <= 0) return;
      const sc = E.outBack(p, 3) * out;
      if (sc <= 0) return;
      const x = PX + ox, y = CY + oy;
      ctx.save();
      ctx.translate(x, y); ctx.rotate(dt * 2); ctx.scale(sc, sc);
      ctx.beginPath();
      ctx.moveTo(0, -s); ctx.quadraticCurveTo(s * 0.18, -s * 0.18, s, 0); ctx.quadraticCurveTo(s * 0.18, s * 0.18, 0, s);
      ctx.quadraticCurveTo(-s * 0.18, s * 0.18, -s, 0); ctx.quadraticCurveTo(-s * 0.18, -s * 0.18, 0, -s);
      ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 3.5; ctx.stroke();
      ctx.restore();
    });
  }
  function heroPose(t) {
    const [hx, hy, hr, hw] = LAY.hero;
    const [ex, ey, er, ew] = LAY.heroEnd;
    const k = E.outQuart(prog(t, HERO_IN, HERO_LAND));
    let x = hx, y = lerp(H + hw * 0.4, hy, k), rot = lerp(0.25, hr, k), w = hw, lift = 1 - k;
    // the shake when the stamp lands
    const s = t - STAMP;
    if (s > 0 && s < 0.35) { const a = (1 - s / 0.35) * 10; x += Math.sin(s * 90) * a; y += Math.cos(s * 77) * a * 0.7; }
    const o = E.inOutCubic(prog(t, OUTRO, END));
    if (o > 0) {
      x = lerp(x, ex, o); y = lerp(y, ey, o); rot = lerp(rot, er, o); w = lerp(w, ew, o);
      lift = Math.sin(Math.PI * o) * 0.5;
      // a slow float on the end card
      const f = t - END; if (f > 0) { y += Math.sin(f * 1.6) * 4; rot += Math.sin(f * 1.1) * 0.004; }
    }
    return { x, y, rot, w, lift };
  }
  function hero(ctx, t) {
    if (t < HERO_IN) return;
    const p = heroPose(t);
    framed(ctx, p.x, p.y, p.w, p.rot, p.lift, heroContent(t), (c) => { steam(c, t); cloche(c, t); });
  }

  /* ── the strip over the pile ── */
  function caption(ctx, t, text = 'Early cards, coming right up', pos = LAY.caption, t0 = 2.1, t1 = SWEEP - 0.1) {
    if (!pos) return;
    const k = prog(t, t0, t0 + 0.3);
    const out = prog(t, t1, t1 + 0.25);
    if (k <= 0 || out >= 1) return;
    const [x, y, size] = pos;
    cardFont(ctx, size);
    const tw = ctx.measureText(text).width;
    const w = tw + size * 1.4, h = size * 1.6;
    ctx.save();
    ctx.translate(x, y + E.inCubic(out) * h * 3);
    ctx.rotate(-0.015);
    ctx.scale(E.outBack(k, 2), E.outBack(k, 2));
    rrect(ctx, -w / 2 + 10, -h / 2 + 12, w, h, 14); ctx.fillStyle = 'rgba(2,14,17,0.55)'; ctx.fill();
    rrect(ctx, -w / 2, -h / 2, w, h, 14); ctx.fillStyle = C.sun; ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = 6; ctx.stroke();
    ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, size * 0.04);
    ctx.restore();
    if (out <= 0) {
      tape(ctx, x - w / 2 + 20, y - h / 2, 110, 34, -0.5, prog(t, t0 + 0.2, t0 + 0.32));
      tape(ctx, x + w / 2 - 20, y - h / 2, 110, 34, 0.5, prog(t, t0 + 0.23, t0 + 0.35));
    }
  }

  /* ── the end card ── */
  function endCard(ctx, t) {
    const k = prog(t, OUTRO + 0.1, END + 0.05);
    if (k <= 0) return;
    const [px, py, pw, ph] = LAY.panel;
    const e = E.outQuart(k);
    const land = MODE === 'landscape';
    ctx.save();
    if (land) ctx.translate((1 - e) * (W - px + 60), 0); else ctx.translate(0, (1 - e) * (H - py + 60));
    ctx.translate(px + pw / 2, py + ph / 2);
    ctx.rotate(0.012 * (land ? 1 : -1));
    ctx.translate(-pw / 2, -ph / 2);
    rrect(ctx, 14, 16, pw, ph, 22); ctx.fillStyle = 'rgba(2,14,17,0.5)'; ctx.fill();
    rrect(ctx, 0, 0, pw, ph, 22); ctx.fillStyle = CREAM; ctx.fill();
    ctx.save(); ctx.clip(); ctx.fillStyle = C.creamShade; ctx.fillRect(0, ph - 12, pw, 12); ctx.restore();
    rrect(ctx, 0, 0, pw, ph, 22); ctx.strokeStyle = INK; ctx.lineWidth = 7; ctx.stroke();
    ctx.strokeStyle = TEAL_INK; ctx.lineWidth = 2.5;
    rrect(ctx, 22, 22, pw - 44, ph - 44, 10); ctx.stroke();
    ctx.lineWidth = 1.5; rrect(ctx, 30, 30, pw - 60, ph - 60, 6); ctx.stroke();
    const cx = pw / 2;
    const step = (a) => E.outCubic(prog(t, END - 0.2 + a, END + 0.15 + a));
    const rise = (a) => (1 - step(a)) * 26;
    const item = (a, fn) => { const s = step(a); if (s <= 0) return; ctx.save(); ctx.globalAlpha = s; ctx.translate(0, rise(a)); fn(); ctx.restore(); };
    // per shape: wordmark y and h, the headline (lines, size, y), the rule, "Follow @coinnibalfun" (y, size), "Grab your
    // early card at" (y, size), the host (y, size); the square puts the wordmark and the follow in its foot row (`frow`)
    const L = MODE === 'landscape'
      ? { wy: 84, wh: 86, lines: ['Appetizers', 'are served.'], hs: 104, hy: 295, ry: 445, fy: 535, fs: 42, gy: 670, gs: 40, uy: 768, us: 84 }
      : MODE === 'square'
        ? { wy: null, lines: ['Appetizers are served.'], hs: 76, hy: 100, ry: 150, gy: 215, gs: 38, uy: 295, us: 70, fy: 385, fs: 32, frow: true }
        : { wy: null, lines: ['Appetizers', 'are served.'], hs: 116, hy: 160, ry: 330, fy: 428, fs: 54, gy: 565, gs: 46, uy: 665, us: 96 };
    if (L.wy != null) item(-0.05, () => wordmark(ctx, cx, L.wy, L.wh, { center: true }));
    item(0.0, () => {
      ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      L.lines.forEach((ln, i) => { const s = fitCard(ctx, ln, L.hs, pw - 110); ctx.fillText(ln, cx, L.hy + i * L.hs * 1.02); });
    });
    item(0.15, () => {
      const oy = L.ry;
      ctx.strokeStyle = INK; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(cx - pw * 0.34, oy); ctx.lineTo(cx - 24, oy); ctx.moveTo(cx + 24, oy); ctx.lineTo(cx + pw * 0.34, oy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, oy - 12); ctx.lineTo(cx + 12, oy); ctx.lineTo(cx, oy + 12); ctx.lineTo(cx - 12, oy); ctx.closePath();
      ctx.fillStyle = C.sun; ctx.fill(); ctx.stroke();
    });
    item(0.35, () => {
      cardFont(ctx, L.gs, 700);
      ctx.fillStyle = TEAL_INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('Grab your early card at', cx, L.gy);
    });
    item(0.45, () => {
      const s = fitCard(ctx, window.SITE_HOST, L.us, pw - 110);
      const tw = ctx.measureText(window.SITE_HOST).width;
      // a sun marker stroke under the host, drawn on
      const m = E.outCubic(prog(t, END + 0.6, END + 0.95));
      if (m > 0) {
        ctx.save();
        ctx.fillStyle = C.sun;
        ctx.beginPath();
        ctx.roundRect(cx - tw / 2 - 12, L.uy - s * 0.32, (tw + 24) * m, s * 0.36, 8);
        ctx.fill();
        ctx.restore();
      }
      cardFont(ctx, s);
      ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(window.SITE_HOST, cx, L.uy);
    });
    if (L.frow) {
      // square: the wordmark and the follow share the foot row
      item(0.7, () => {
        wordmark(ctx, 60, L.fy - 30, 58, {});
        follow(ctx, pw - 60, L.fy, L.fs, 'right');
      });
    } else item(0.25, () => follow(ctx, cx, L.fy, L.fs, 'center'));
    ctx.restore();
  }
  /** "Follow @coinnibalfun": X's mark and the words, the handle in ink, at (x, baseline y). */
  function follow(ctx, x, y, size, align) {
    cardFont(ctx, size, 800);
    const a = 'Follow ', b = '@coinnibalfun';
    const wa = ctx.measureText(a).width, wb = ctx.measureText(b).width;
    const mark = size * 0.8, gap = size * 0.32;
    const w = mark + gap + wa + wb;
    let x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    // X's mark (its 24-unit path), sitting on the cap height
    ctx.save();
    ctx.translate(x0, y - size * 0.72);
    ctx.scale(mark / 24, mark / 24);
    ctx.fillStyle = INK;
    ctx.fill(new Path2D('M17.8 3h3.1l-6.8 7.8 8 10.2h-6.3l-4.9-6.4L5.3 21H2.2l7.3-8.3L1.8 3h6.4l4.4 5.9zm-1.1 16.2h1.7L7.4 4.7H5.6z'));
    ctx.restore();
    x0 += mark + gap;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = TEAL_INK; ctx.fillText(a, x0, y);
    ctx.fillStyle = INK; ctx.fillText(b, x0 + wa, y);
  }

  /** Portrait: the wordmark sits above the card on the end card. */
  function topMark(ctx, t) {
    if (MODE !== 'portrait') return;
    const s = E.outCubic(prog(t, END - 0.1, END + 0.3));
    if (s <= 0) return;
    ctx.save();
    ctx.globalAlpha = s;
    ctx.translate(0, (1 - s) * -30);
    wordmark(ctx, W / 2, 150, 130, { center: true, diecut: true });
    ctx.restore();
  }

  window.SCENES_INIT = async () => {
    const f = new FontFace('Fraunces Card', 'url(/cache/fonts/fraunces-wght.woff2)', { weight: '100 900' });
    await f.load();
    document.fonts.add(f);
    for (const d of DEAL) {
      const c = mkCanvas(CW, CH);
      A.drawAppetizerCard(c.getContext('2d'), { no: d.no, handle: d.handle, at: DAY, host: window.SITE_HOST }, FONTS);
      BITMAP.push(c);
    }
    heroLook = HERO_LOOK();
  };
  window.SCENE_DRAW = (ctx, t) => {
    table(ctx);
    bell(ctx, t);
    ticket(ctx, t);
    dealt(ctx, t);
    caption(ctx, t);
    hero(ctx, t);
    caption(ctx, t, 'Your early card is ready', LAY.heroCap, HERO_LAND - 0.05, OUTRO - 0.15);
    endCard(ctx, t);
    topMark(ctx, t);
    // a short fade in from ink and out at the very end
    const fi = 1 - prog(t, 0, 0.12), fo = prog(t, DUR - 0.2, DUR);
    if (fi > 0 || fo > 0) { ctx.fillStyle = INK; ctx.globalAlpha = Math.max(fi, fo); ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
  };
  window.SCENE_GRAIN = (ctx, t) => {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const k = Math.floor(t * 15 + 1e-6);
    const g = TEX.grain[((k % TEX.grain.length) + TEX.grain.length) % TEX.grain.length];
    const pat = ctx.createPattern(g, 'repeat');
    pat.setTransform(new DOMMatrix().translate((k * 137) % 512, (k * 251) % 512).scale(2, 2));
    ctx.globalAlpha = 0.3; ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = pat; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  };
  window.SCENE_DARK = () => false;
  window.SCENE_BLUR = (t) => {
    // a touch of motion blur on the fast moves: the deals, the sweep, the cloche, the hand-off to the end card
    if (DEAL.some((d) => t > d.land - d.fly && t < d.land + 0.02)) return { k: 7, shutter: 0.012 };
    if ((t > SWEEP && t < HERO_LAND + 0.02) || (t > LIFT && t < LIFT + 0.6) || (t > STAMP - 0.16 && t < STAMP + 0.02) || (t > OUTRO && t < END)) return { k: 7, shutter: 0.012 };
    return { k: 1, shutter: 0 };
  };
  window.SCENE_ASSETS = () => [];
  window.APPETIZER = { DING, LAND, SWEEP, HERO_IN, HERO_LAND, RATTLE, LIFT, BLINK, GRIN, STAMP, OUTRO, END, DUR };
})();
