/* Coinnibal promo: the eight beats and the cuts between them.
 * The beat starts live in timeline.json ("beats"); the cue times below are offsets on the same 100 BPM grid
 * (one beat = 0.6 s, one bar = 2.4 s) that the score and the SFX are written to. */
'use strict';

const S = {}; // shared state built in init
const LOOK = {};
const B = {}; // beat starts, from timeline.json
// the site's host on the end card (render.mjs passes SITE_HOST as ?site=)
window.SITE_HOST = QS.get('site') || 'coinnibal.fun';

/* ───────────── shared helpers ───────────── */
function drift(t, amp = 1) {
  return { x: Math.sin(t * 0.52) * 6 * amp + Math.sin(t * 1.3) * 1.5 * amp, y: Math.sin(t * 0.37 + 1) * 4.5 * amp, r: Math.sin(t * 0.21) * 0.0025 * amp };
}
function bg(ctx, t, color = C.paper, dark = false, par = 1) {
  const d = drift(t, 1);
  drawPaper(ctx, -t * 10 * par + d.x * 0.4, d.y * 0.4, color, dark);
}
function nightBg(ctx, t) {
  bg(ctx, t, C.trench, true);
  ctx.save();
  ctx.globalAlpha = 0.4; ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = ctx.createPattern(TEX.dots, 'repeat'); ctx.fillRect(0, 0, W, H);
  ctx.restore();
}
/* footage: frames of the replayed take, cut by render/footage-from-takes.mjs into cache/footage/<id>/NNNN.jpg
 * (60 fps, the replay's own pixels) with track.json: per frame the hero coin and the nearest prey in CSS px of
 * the 1920x1080 page: [hx, hy, hr, px, py, pr] (prey 0 when none is near). */
function footFrame(id, lt) {
  const sh = S.shots[id];
  return clamp(Math.floor(Math.max(0, lt) * 60 + 1e-6), 0, sh.frames - 1);
}
function footUrl(id, lt) {
  return `/cache/footage/${id}/${String(footFrame(id, lt) + 1).padStart(4, '0')}.jpg`;
}
function trackAt(id, lt) {
  const tr = S.track[id];
  if (!tr || !tr.length) return { x: 960, y: 540, r: 60, px: 0, py: 0, pr: 0 };
  const f = clamp(lt * 60, 0, tr.length - 1);
  const i = Math.floor(f), k = f - i;
  const a = tr[i], b = tr[Math.min(tr.length - 1, i + 1)];
  const prey = a[5] && b[5] ? [lerp(a[3], b[3], k), lerp(a[4], b[4], k), lerp(a[5], b[5], k)] : [a[3], a[4], a[5]];
  return { x: lerp(a[0], b[0], k), y: lerp(a[1], b[1], k), r: lerp(a[2], b[2], k), px: prey[0], py: prey[1], pr: prey[2] };
}
/** Draws footage shot `id` at local time lt into the box with a camera on the page (cx, cy in CSS px, zoom z:
 * z = 1 fits the page's width to the box). Returns a page -> screen mapper. */
function drawFoot(ctx, id, lt, box, cam) {
  const im = getImg(footUrl(id, lt));
  const z = (box.w / 1920) * cam.z;
  const map = (px, py) => ({ x: box.x + box.w / 2 + (px - cam.cx) * z, y: box.y + box.h / 2 + (py - cam.cy) * z, s: z });
  ctx.save();
  ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  ctx.fillStyle = C.trench; ctx.fillRect(box.x, box.y, box.w, box.h);
  if (im) {
    const k = im.width / 1920; // image px per page px
    const o = map(0, 0);
    ctx.drawImage(im, o.x, o.y, (im.width / k) * z, (im.height / k) * z);
  }
  ctx.restore();
  return map;
}
/** A camera that follows the hero coin, smoothed over the last `lag` seconds (a pure function of time). */
function followCam(id, lt, z, lead = [0, 0], lag = 0.35, aspect = 16 / 9) {
  let cx = 0, cy = 0, wsum = 0;
  for (let i = 0; i < 12; i++) {
    const dt = (i / 11) * lag * 2;
    const w = Math.exp(-dt / Math.max(0.01, lag));
    const p = trackAt(id, Math.max(0, lt - dt));
    cx += p.x * w; cy += p.y * w; wsum += w;
  }
  cx = cx / wsum + lead[0]; cy = cy / wsum + lead[1];
  const hw = 960 / z, hh = 960 / aspect / z;
  return { cx: clamp(cx, hw, 1920 - hw), cy: clamp(cy, hh, 1080 - hh), z };
}
/** Small label chip (mono text in a rounded ink-outlined box). */
function chip(ctx, text, x, y, o = {}) {
  font(ctx, o.size || 18, o.weight || 500, 'mono');
  ctx.letterSpacing = (o.ls ?? 2) + 'px';
  const tw0 = ctx.measureText(text).width;
  const pw = o.pad ?? 12, h = (o.size || 18) * 1.9;
  const w = tw0 + pw * 2;
  const x0 = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
  ctx.save();
  if (o.alpha != null) ctx.globalAlpha = o.alpha;
  rrect(ctx, x0, y - h / 2, w, h, 8);
  if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
  if (o.stroke !== false) { ctx.strokeStyle = o.strokeColor || o.color || C.ink; ctx.lineWidth = o.lw || 2; ctx.stroke(); }
  ctx.fillStyle = o.color || C.ink;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x0 + pw, y + 1);
  ctx.restore();
  return w;
}
/** Print marks: the brand line bottom left, the beat counter and three ink swatches bottom right. */
function hud(ctx, t, idx, dark = false, alpha = 1) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha * 0.75;
  const col = dark ? C.nightInk2 : C.ink2;
  font(ctx, 15, 500, 'mono');
  ctx.letterSpacing = '3px';
  ctx.fillStyle = col;
  ctx.textBaseline = 'middle';
  ctx.fillText('COINNIBAL  /  COINS THAT EAT COINS', 64, H - 46);
  ctx.textAlign = 'right';
  ctx.fillText(String(idx).padStart(2, '0') + ' / 06', W - 64 - 96, H - 46);
  [C.cyan, C.sun, C.blush].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(W - 64 - 78 + i * 28, H - 52, 22, 12);
  });
  ctx.strokeStyle = col; ctx.lineWidth = 1.5;
  [[40, 40], [W - 40, 40]].forEach(([x, y]) => {
    ctx.beginPath(); ctx.arc(x, y, 8, 0, TAU); ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y); ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 14); ctx.stroke();
  });
  ctx.restore();
}
/** A value tag: a gold $NIBAL coin, the amount and "$NIBAL" on an ink pill, centred at (x, y). */
function valueTag(ctx, x, y, v, o = {}) {
  const size = o.size || 34;
  const s = o.pop ?? 1;
  if (s <= 0.01) return 0;
  ctx.save();
  ctx.translate(x, y); ctx.scale(s, s);
  if (o.rot) ctx.rotate(o.rot);
  if (o.alpha != null) ctx.globalAlpha = o.alpha;
  const txt = (o.plus ? '+' : '') + fmt(Math.round(v));
  font(ctx, size, 800, 'mono'); ctx.letterSpacing = '0px';
  const tw0 = ctx.measureText(txt).width;
  font(ctx, size * 0.5, 600, 'mono'); ctx.letterSpacing = '1.5px';
  const uw = ctx.measureText('$NIBAL').width;
  const r = size * 0.42, pad = size * 0.32, gap = size * 0.22;
  const w = pad + r * 2 + gap + tw0 + gap + uw + pad, h = size * 1.45;
  const x0 = -w / 2;
  rrect(ctx, x0 + 4, -h / 2 + 4, w, h, h / 2); ctx.fillStyle = C.abyss; ctx.fill();
  rrect(ctx, x0, -h / 2, w, h, h / 2); ctx.fillStyle = o.fill || C.ink; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = o.edge || C.sun; ctx.stroke();
  nibal(ctx, x0 + pad + r, 0, r, { spin: o.spin || 0 });
  font(ctx, size, 800, 'mono'); ctx.letterSpacing = '0px';
  ctx.fillStyle = o.color || C.cream; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText(txt, x0 + pad + r * 2 + gap, size * 0.04);
  font(ctx, size * 0.5, 600, 'mono'); ctx.letterSpacing = '1.5px'; ctx.fillStyle = C.sun;
  ctx.fillText('$NIBAL', x0 + pad + r * 2 + gap + tw0 + gap, size * 0.06);
  ctx.restore();
  return w * s;
}
/** Point k of a quadratic arc from a to b, lifted by `lift` px at the middle. */
function arcPt(a, b, k, lift) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - lift;
  return { x: (1 - k) * (1 - k) * a.x + 2 * (1 - k) * k * mx + k * k * b.x, y: (1 - k) * (1 - k) * a.y + 2 * (1 - k) * k * my + k * k * b.y };
}

/* ───────────── init ───────────── */
const ONCE = new Map();
function loadImgOnce(url) {
  if (ONCE.has(url)) return ONCE.get(url).p;
  const im = new Image();
  const p = new Promise((res) => { im.onload = () => res(im); im.onerror = () => res(null); });
  im.src = url;
  ONCE.set(url, { im, p });
  return p;
}
const imgOnce = (url) => { const im = ONCE.get(url)?.im; return im && im.complete && im.naturalWidth ? im : null; };
window.SCENES_INIT = async () => {
  const A = window.CoinnibalArt;
  for (let i = 0; i < 8; i++) LOOK['b' + i] = A.lookForBasicSkin(i);
  LOOK.goldie = A.lookForBasicSkin(1);
  for (const [k, v] of Object.entries(TL.beats)) B[k] = v[0];
  S.shots = {};
  S.track = {};
  for (const s of TL.footage || []) {
    S.shots[s.id] = s;
    try {
      const r = await fetch(`/cache/footage/${s.id}/track.json`);
      if (r.ok) { const j = await r.json(); S.track[s.id] = j.track; s.frames = j.frames; s.events = j.events || {}; }
    } catch {}
    s.frames ||= Math.round(s.dur * 60);
  }
  // the NFT emblems (render/nft-cards.ts): illustrative art from the collection's own generator
  S.nft = [];
  try { S.nft = await (await fetch('/cache/nft/index.json')).json(); } catch {}
  await Promise.all(S.nft.map((n) => loadImgOnce(`/cache/nft/${n.file}`)));
};

/* ───────────── 1. COLD OPEN: you take what you eat (0 – 4.8) ─────────────
 * Real footage. Goldie gulps a coin in slow motion: the prey's value tag lifts off it and flies into her
 * purse, which ticks 1,000 -> 2,000. A second gulp stacks it: 2,000 -> 3,000. The camera then pushes into
 * her gold coin, which becomes the coin O of the wordmark. */
const HOOK_CUT = 2.4;
function hookLayout(t) {
  return t < HOOK_CUT ? { id: 'G1', lt: t, base: 1000, idx: 0 } : { id: 'G2', lt: t - HOOK_CUT, base: 2000, idx: 1 };
}
function sceneHook(ctx, t) {
  const L = hookLayout(t);
  const sh = S.shots[L.id];
  const gulp = sh.events?.gulp ?? 1.2;
  const lt = L.lt;
  const punch = Math.exp(-Math.pow((lt - gulp) / 0.35, 2)) * 0.16;
  const push = L.idx === 1 ? E.inCubic(prog(t, B.logo - 0.5, B.logo)) : 0;
  const z = (sh.zoom || 1.35) * (1 + punch) * (1 + push * 2.4);
  const cam = followCam(L.id, lt, z, sh.lead || [0, -20], 0.3);
  const shk = shake(lt, [gulp], 10, 0.4);
  ctx.save();
  ctx.translate(shk.x, shk.y);
  const map = drawFoot(ctx, L.id, lt, { x: 0, y: 0, w: W, h: H }, cam);
  ctx.restore();
  const hero = trackAt(L.id, lt);
  const hp = map(hero.x, hero.y);
  const hr = hero.r * hp.s;
  const dg = lt - gulp;
  if (dg > -0.02 && dg < 0.12) { ctx.save(); ctx.globalAlpha = (1 - Math.abs(dg - 0.03) / 0.1) * 0.3; ctx.fillStyle = C.cream; ctx.fillRect(0, 0, W, H); ctx.restore(); }
  shockDots(ctx, hp.x, hp.y, dg, C.sun, 700, 0.5);
  // the prey's tag rides on the prey until the gulp, then flies into the purse
  const purse = { x: hp.x, y: hp.y - hr - 64 };
  const fly = prog(lt, gulp - 0.02, gulp + 0.42);
  const pre = trackAt(L.id, Math.min(lt, gulp - 0.04));
  if (pre.pr > 0 && fly < 1) {
    const pp = map(pre.px, pre.py);
    // the tag sits on the far side of the prey from Goldie
    const hp0 = map(trackAt(L.id, Math.min(lt, gulp - 0.04)).x, trackAt(L.id, Math.min(lt, gulp - 0.04)).y);
    const dx = pp.x - hp0.x, dy = pp.y - hp0.y, dl = Math.hypot(dx, dy) || 1;
    const from = { x: pp.x + (dx / dl) * (pre.pr * pp.s + 110), y: pp.y + (dy / dl) * (pre.pr * pp.s + 50) };
    const k = E.inOutCubic(fly);
    const p = arcPt(from, purse, k, 170);
    const pop = E.outBack(prog(lt, Math.max(0, gulp - 0.95), Math.max(0.25, gulp - 0.65)), 2) * (1 - 0.3 * k);
    valueTag(ctx, p.x, p.y, 1000, { size: 30, pop, spin: fly * 8, edge: C.cyan });
  }
  const arrive = gulp + 0.42;
  const v = L.base + 1000 * E.outCubic(prog(lt, arrive, arrive + 0.45));
  const bump = lt > arrive ? Math.exp(-(lt - arrive) * 6) * 0.22 : 0;
  const pin = L.idx === 0 ? E.outBack(prog(t, 0.15, 0.5), 1.8) : 1;
  valueTag(ctx, purse.x, purse.y, v, { size: 40, pop: pin * (1 + bump) * (1 - push) });
  if (lt > arrive && lt < arrive + 0.9) {
    const k = prog(lt, arrive, arrive + 0.9);
    ctx.save(); ctx.globalAlpha = 1 - k;
    font(ctx, 46, 800, 'mono'); ctx.fillStyle = C.sun; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.strokeStyle = C.ink; ctx.lineWidth = 8; ctx.lineJoin = 'round';
    ctx.strokeText('+1,000', purse.x + 200, purse.y - 48 - k * 60);
    ctx.fillText('+1,000', purse.x + 200, purse.y - 48 - k * 60);
    ctx.restore();
    burst(ctx, purse.x, purse.y, lt - arrive, { seed: 3 + L.idx, n: 22, colors: [C.sun, C.cyan, C.cream], speed: 600, life: 0.8 });
  }
  // the headline, on a soft ink scrim at the top
  ctx.save();
  const sc = ctx.createLinearGradient(0, 0, 0, 430);
  sc.addColorStop(0, 'rgba(4,24,28,0.6)'); sc.addColorStop(1, 'rgba(4,24,28,0)');
  ctx.globalAlpha = 1 - push; ctx.fillStyle = sc; ctx.fillRect(0, 0, W, 430);
  ctx.restore();
  kicker(ctx, 'REAL GAMEPLAY  /  $1 ROOM', 120, 98, t, 0.05, { color: C.cream, dotColor: C.sun, out: B.logo - 0.5 });
  headline(ctx, [
    { text: 'Eat a coin.', at: 0.1, color: C.cream, shadow: C.ink },
    { text: 'Keep what it carried.', at: 1.5, color: C.sun, shadow: C.ink },
  ], 120, 220, t, { size: 92, out: B.logo - 0.55 });
}

/* ───────────── 2. LOGO (4.8 – 8.4) ─────────────
 * The coin O lands first (Goldie's coin a frame ago), the letters slam in around it; "Coins that eat coins.",
 * the chain; the chomp mark bites a coin; a paper wipe up to the tickets. */
const LOGO = { y: 210, h: 240 };
function sceneLogo(ctx, t) {
  const t0 = B.logo;
  bg(ctx, t);
  const d = drift(t, 0.6);
  const sh = shake(t, [t0, t0 + 0.62], 12);
  ctx.save();
  ctx.translate(d.x + sh.x, d.y + sh.y);
  const land = E.outExpo(prog(t, t0, t0 + 0.3));
  const order = [1, 0, 2, 3, 4, 5, 6, 7, 8];
  const wm = wordmark(ctx, W / 2, LOGO.y, LOGO.h, {
    center: true,
    letter: (i) => {
      if (i === 1) return { p: 1, s: lerp(5.5, 1, land), rot: (1 - land) * 40 };
      const at = t0 + 0.18 + order.indexOf(i) * 0.055;
      const p = prog(t, at, at + 0.22);
      if (p <= 0) return { p: 0 };
      const sp = spring(t - at, 1.8, 6);
      return { p, dy: (1 - Math.min(1, sp)) * -140, s: lerp(1.35, 1, E.outCubic(p)), rot: (1 - E.outCubic(p)) * (i % 2 ? 14 : -14) };
    },
  });
  shockDots(ctx, wm.ox, wm.oy, t - t0, C.sun, 1000, 0.4);
  burst(ctx, wm.ox, wm.oy, t - t0 - 0.02, { seed: 11, n: 30, colors: [C.sun, C.cyan, C.blush, C.cream], speed: 900, life: 1.0 });
  ctx.restore();
  headline(ctx, [{ text: 'Coins that eat coins.', at: t0 + 1.0 }], W / 2, 640, t, { size: 104, align: 'center', out: t0 + 3.05 });
  kicker(ctx, 'ON ROBINHOOD CHAIN', W / 2, 740, t, t0 + 1.95, { align: 'center', dot: false, color: C.tealInk, size: 26, ls: 8, out: t0 + 3.1 });
  // the chomp mark crosses the bottom right and bites
  const ck = prog(t, t0 + 1.9, t0 + 2.3);
  if (ck > 0) {
    const cx = lerp(W + 220, 1600, E.outBack(ck, 1.4)), cy = 900;
    const bite = t < t0 + 2.55 ? 0 : clamp((t - t0 - 2.55) / 0.08);
    chompMark(ctx, cx, cy, 240, { bite, prey: E.inCubic(prog(t, t0 + 2.55, t0 + 2.8)), eye: Math.exp(-Math.pow((t - t0 - 2.3) / 0.05, 2)), time: t });
    if (t > t0 + 2.6) burst(ctx, cx + 60, cy, t - t0 - 2.62, { seed: 5, n: 14, colors: [C.sun, C.cream], speed: 500, life: 0.6, size: 7 });
  }
  hud(ctx, t, 1, false, tw(t, t0 + 0.6, t0 + 1.0));
}

/* ───────────── 3. TICKET + ROOMS (8.4 – 13.2) ─────────────
 * Four room tickets dealt on the beat ($1, $3, $5, $10; the $10 one for NFT holders). The $1 ticket is taken,
 * taped, stamped PAID; Goldie pops out of it with the ticket's whole value on her tag; a hole is punched and
 * the camera dives through it into the arena. */
const ROOMS = [
  { usd: '$1', name: '$1 Room', paint: C.cyan, look: 'goldie' },
  { usd: '$3', name: '$3 Room', paint: C.up, look: 'b3' },
  { usd: '$5', name: '$5 Room', paint: C.sun, look: 'b1' },
  { usd: '$10', name: '$10 Room', paint: C.blush, look: 'b4', nft: true },
];
const RT = { x: 1010, y: 168, w: 780, h: 158, gap: 34, stub: 190 };
function drawRoomTicket(ctx, r, x, y, w, h, t, o = {}) {
  const stub = w - RT.stub;
  paperShadow(ctx, () => ticketPath(ctx, x, y, w, h, 16, stub, 16), 0.9, 0.3);
  ticketPath(ctx, x, y, w, h, 16, stub, 16);
  ctx.fillStyle = C.cream; ctx.fill();
  ctx.save(); ticketPath(ctx, x, y, w, h, 16, stub, 16); ctx.clip();
  ctx.fillStyle = r.paint; ctx.fillRect(x, y, 16, h);
  ctx.fillRect(x + stub, y, w - stub, h);
  ctx.restore();
  ticketPath(ctx, x, y, w, h, 16, stub, 16); ctx.lineWidth = 3.5; ctx.strokeStyle = C.ink; ctx.stroke();
  dashed(ctx, x + stub, y + 22, x + stub, y + h - 22, 'rgba(4,24,28,0.55)', 3, [7, 7]);
  font(ctx, 18, 500, 'mono'); ctx.letterSpacing = '4px'; ctx.fillStyle = C.ink2; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillText(r.nft ? 'ADMIT ONE' : 'ADMIT ONE  /  5-MINUTE ROUND', x + 44, y + 46);
  font(ctx, 68, 800, 'display'); ctx.letterSpacing = '-1.5px'; ctx.fillStyle = C.ink;
  ctx.fillText(r.name, x + 40, y + 118);
  if (r.nft) chip(ctx, 'NFT HOLDERS ONLY', x + 190, y + 40, { size: 15, fill: C.ink, color: C.sun, strokeColor: C.ink, pad: 10 });
  if (!o.noCoin) coin(ctx, x + stub - 70, y + h / 2 + 4, { look: LOOK[r.look], r: 40, expr: 'happy', time: t, seed: 2, lookX: 0.4 });
  font(ctx, 62, 800, 'display'); ctx.letterSpacing = '-1px'; ctx.textAlign = 'center'; ctx.fillStyle = C.ink;
  ctx.fillText(r.usd, x + stub + RT.stub / 2, y + 92);
  font(ctx, 15, 600, 'mono'); ctx.letterSpacing = '2px';
  ctx.fillText('IN $NIBAL', x + stub + RT.stub / 2, y + 124);
  ctx.textAlign = 'left';
}
function ticketPose(i, t) {
  const t0 = B.ticket;
  const deal = t0 + 0.2 + i * 0.3;
  const k = spring(t - deal, 1.5, 6.2);
  let x = RT.x + (1 - clamp(k, 0, 1.2)) * 1100, y = RT.y + i * (RT.h + RT.gap), rot = (1 - clamp(k)) * 0.2 + (i % 2 ? 0.012 : -0.01), s = 1;
  const pick = t0 + 2.1;
  if (i > 0) { const out = E.inCubic(prog(t, pick + (i - 1) * 0.05, pick + 0.4 + (i - 1) * 0.05)); x += out * 1200; rot += out * 0.3; }
  else {
    const m = E.inOutCubic(prog(t, pick, pick + 0.5));
    x = lerp(x, W / 2 - (RT.w * 1.25) / 2 + 60, m); y = lerp(y, 520, m); s = lerp(1, 1.25, m); rot = lerp(rot, -0.025, m);
  }
  return { x, y, rot, s, on: t >= deal - 0.05 };
}
const TK = { stamp: 3.0, pop: 3.15, punch: 3.85, diveA: 4.1, diveB: 4.8 };
function sceneTicket(ctx, t) {
  const t0 = B.ticket;
  bg(ctx, t);
  const d = drift(t, 0.7);
  const dk = E.inCubic(prog(t, t0 + TK.diveA, t0 + TK.diveB));
  const p0 = ticketPose(0, t);
  const hole = { x: RT.w - RT.stub - 52, y: RT.h * 0.5 + 4, r: 38 };
  // the hole on screen (the ticket's transform)
  const c = Math.cos(p0.rot), s = Math.sin(p0.rot);
  const hx = p0.x + d.x + (hole.x * c - hole.y * s) * p0.s, hy = p0.y + d.y + (hole.x * s + hole.y * c) * p0.s;
  ctx.save();
  if (dk > 0) { const z = Math.exp(dk * Math.log(60)); ctx.translate(hx, hy); ctx.scale(z, z); ctx.translate(-hx, -hy); }
  ctx.translate(d.x, d.y);
  for (let i = 3; i >= 0; i--) {
    const p = ticketPose(i, t);
    if (!p.on) continue;
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(p.s, p.s);
    drawRoomTicket(ctx, ROOMS[i], 0, 0, RT.w, RT.h, t, { noCoin: i === 0 && t >= t0 + TK.pop });
    if (i === 0) {
      tape(ctx, 70, -6, 150, 44, -0.35, prog(t, t0 + 2.55, t0 + 2.75));
      tape(ctx, RT.w - 60, RT.h + 4, 150, 44, -0.3, prog(t, t0 + 2.65, t0 + 2.85));
      stamp(ctx, 'PAID', 405, RT.h * 0.5, -0.16, t - (t0 + TK.stamp), C.tealInk, { size: 40, mono: true, scale: 1.05 });
      const pk = E.outBack(prog(t, t0 + TK.punch, t0 + TK.punch + 0.12), 2);
      if (pk > 0) {
        ctx.save();
        ctx.beginPath(); ctx.arc(hole.x, hole.y, hole.r * pk, 0, TAU); ctx.clip();
        ctx.fillStyle = C.trench; ctx.fillRect(hole.x - 60, hole.y - 60, 120, 120);
        ctx.restore();
        ctx.beginPath(); ctx.arc(hole.x, hole.y, hole.r * pk, 0, TAU); ctx.lineWidth = 3; ctx.strokeStyle = C.ink; ctx.stroke();
      }
    }
    ctx.restore();
  }
  // Goldie pops out of the $1 ticket with its value on her tag
  const gk = prog(t, t0 + TK.pop, t0 + TK.pop + 0.4);
  if (gk > 0) {
    const gx = p0.x + 200, gy = p0.y - 40 - E.outBack(gk, 2.2) * 90;
    coin(ctx, gx, gy, { look: LOOK.goldie, r: 86, expr: 'happy', time: t, seed: 4, lookX: 0.5, lookY: 0.3, sy: lerp(0.6, 1, E.outBack(gk, 3)) });
    valueTag(ctx, gx + 300, gy - 30, 1000, { size: 42, pop: E.outBack(prog(t, t0 + TK.pop + 0.2, t0 + TK.pop + 0.5), 2) });
    ctx.save();
    ctx.globalAlpha = tw(t, t0 + TK.pop + 0.4, t0 + TK.pop + 0.7);
    font(ctx, 21, 600, 'mono'); ctx.letterSpacing = '3px'; ctx.fillStyle = C.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('YOUR TICKET = YOUR COIN\'S VALUE', gx + 120, gy + 52);
    ctx.restore();
  }
  ctx.restore();
  headline(ctx, [
    { text: 'Buy a ticket.', at: t0 + 0.1 },
    { text: 'Pay in $NIBAL.', at: t0 + 0.75, color: C.cyanShade },
  ], 120, 330, t, { size: 92, out: t0 + 1.95 });
  ctx.save(); ctx.globalAlpha = tw(t, t0 + 1.0, t0 + 1.3) * (1 - tw(t, t0 + 1.95, t0 + 2.2));
  font(ctx, 22, 500, 'mono'); ctx.letterSpacing = '2px'; ctx.fillStyle = C.ink2; ctx.textBaseline = 'alphabetic';
  ctx.fillText('Rooms from one to ten dollars.', 124, 500);
  ctx.fillText('The $10 room is for NFT holders.', 124, 534);
  ctx.restore();
  kicker(ctx, 'FOUR PAID ROOMS', 120, 160, t, t0 + 0.05, { out: t0 + 1.95 });
  hud(ctx, t, 2, false, tw(t, t0, t0 + 0.3) * (1 - dk));
  // the arena through the hole, filling the screen over the dive
  if (dk > 0) {
    const a = E.inQuad(prog(t, t0 + TK.diveA + 0.3, t0 + TK.diveB));
    ctx.save(); ctx.globalAlpha = a; scenePlayFrame(ctx, t, true); ctx.restore();
  }
}

/* ───────────── 4. PLAY (13.2 – 18.0) ─────────────
 * Real footage in a frame, cut on the beat: run from a bigger coin, split onto a runner, a gulp. */
const WIN = { x: 720, y: 150, w: 1110, h: 624 };
function playShot(t) {
  const t0 = B.play;
  let cur = TL.montage[0];
  for (const c of TL.montage) if (t >= t0 + c[1]) cur = c;
  return { id: cur[0], lt: Math.max(0, t - (t0 + cur[1])), at: t0 + cur[1], label: cur[2] };
}
function scenePlayFrame(ctx, t, full = false) {
  const s = playShot(Math.max(t, B.play));
  const sh = S.shots[s.id];
  const cam = followCam(s.id, s.lt, sh.zoom || 1.15, sh.lead || [0, 0], 0.4);
  return drawFoot(ctx, s.id, s.lt, full ? { x: 0, y: 0, w: W, h: H } : WIN, cam);
}
function scenePlay(ctx, t) {
  const t0 = B.play;
  bg(ctx, t);
  const fk = E.inOutCubic(prog(t, t0, t0 + 0.55));
  const box = { x: lerp(0, WIN.x, fk), y: lerp(0, WIN.y, fk), w: lerp(W, WIN.w, fk), h: lerp(H, WIN.h, fk) };
  ctx.save();
  ctx.translate(box.x + box.w / 2, box.y + box.h / 2); ctx.rotate(lerp(0, 0.012, fk)); ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
  if (fk > 0) {
    paperShadow(ctx, () => rrect(ctx, box.x - 18, box.y - 18, box.w + 36, box.h + 70, 14), fk, 0.3 * fk);
    rrect(ctx, box.x - 18, box.y - 18, box.w + 36, box.h + 70, 14); ctx.fillStyle = C.cream; ctx.fill();
  }
  const s = playShot(t);
  const sh = S.shots[s.id];
  const cam = followCam(s.id, s.lt, sh.zoom || 1.15, sh.lead || [0, 0], 0.4);
  const map = drawFoot(ctx, s.id, s.lt, box, cam);
  if (fk > 0) { rrect(ctx, box.x - 18, box.y - 18, box.w + 36, box.h + 70, 14); ctx.lineWidth = 3 * fk; ctx.strokeStyle = C.ink; ctx.stroke(); }
  ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.save(); ctx.globalAlpha = fk;
  font(ctx, 17, 500, 'mono'); ctx.letterSpacing = '4px'; ctx.fillStyle = C.ink2; ctx.textBaseline = 'middle';
  ctx.fillText('LIVE  /  $1 ROOM  /  REAL GAMEPLAY', box.x, box.y + box.h + 27);
  ctx.restore();
  const lk = t - s.at;
  const sx = box.x + 170, sy = box.y + box.h - 90;
  if (s.label === 'RUN') stamp(ctx, 'RUN!', sx, sy, 0.12, lk - 0.25, C.downShade, { size: 54, fade: 1.1 });
  if (s.label === 'SPLIT') stamp(ctx, 'SPLIT', sx, sy, -0.1, lk - 0.3, C.tealInk, { size: 54, fade: 1.1 });
  if (s.label === 'GULP') {
    const g = sh.events?.gulp ?? 0.8;
    const dg = s.lt - g;
    stamp(ctx, 'EATEN', sx, sy, 0.1, dg, C.tealInk, { size: 54 });
    const hero = trackAt(s.id, s.lt);
    const hp = map(hero.x, hero.y);
    if (dg > 0 && dg < 1.1) {
      ctx.save(); ctx.globalAlpha = 1 - prog(dg, 0.7, 1.1);
      valueTag(ctx, hp.x, hp.y - hero.r * hp.s - 50 - dg * 40, 1000, { size: 30, plus: true, pop: E.outBack(prog(dg, 0, 0.25), 2), edge: C.cyan });
      ctx.restore();
    }
  }
  ctx.restore();
  headline(ctx, [
    { text: 'Eat smaller.', at: t0 + 0.25 },
    { text: 'Run from', at: t0 + 1.4, color: C.cyanShade },
    { text: 'bigger.', at: t0 + 1.55, color: C.cyanShade },
  ], 110, 300, t, { size: 96, out: t0 + 4.45 });
  ctx.save(); ctx.globalAlpha = tw(t, t0 + 2.0, t0 + 2.3) * (1 - tw(t, t0 + 4.45, t0 + 4.7));
  font(ctx, 21, 500, 'mono'); ctx.letterSpacing = '2px'; ctx.fillStyle = C.ink2; ctx.textBaseline = 'alphabetic';
  ctx.fillText('You eat coins about a quarter', 114, 610);
  ctx.fillText('smaller than you.', 114, 642);
  ctx.fillText('Bigger ones eat you.', 114, 674);
  ctx.restore();
  kicker(ctx, 'EAT OR BE EATEN', 110, 130, t, t0 + 0.2, { out: t0 + 4.45 });
  hud(ctx, t, 3, false, tw(t, t0 + 0.3, t0 + 0.6));
}

/* ───────────── 5. ROUND (18.0 – 22.8) ─────────────
 * The round clock spins 5:00 down to the bell; the receipt prints: the ticket, the three coins she ate,
 * the fee on profit only, PAID. */
const RC = { cx: 1380, w: 620, slot: 1010, len: 900 };
const CLK = { cx: 1380, cy: 430, w: 660, h: 340 };
const rt = (k) => B.round + k;
function receiptFeed(t) {
  const N = 22;
  const p = prog(t, rt(2.15), rt(3.5)) * N;
  const i = Math.floor(p), f = p - i;
  return Math.min(1, (i + E.outCubic(clamp(f * 1.6))) / N);
}
function clockLeft(t) {
  if (t < rt(0.3)) return 300;
  if (t < rt(1.3)) return 3 + 297 * (1 - E.outQuart(prog(t, rt(0.3), rt(1.3))));
  if (t < rt(1.9)) return 3 - Math.floor((t - rt(1.3)) / 0.2);
  return 0;
}
function bellGlyph(ctx, x, y, s, rot, color) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
  ctx.fillStyle = color; ctx.strokeStyle = C.ink; ctx.lineWidth = 4; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-34, 26);
  ctx.quadraticCurveTo(-30, 18, -27, 4);
  ctx.bezierCurveTo(-24, -26, -16, -38, 0, -38);
  ctx.bezierCurveTo(16, -38, 24, -26, 27, 4);
  ctx.quadraticCurveTo(30, 18, 34, 26);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, -42, 6, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 32, 8, 0, Math.PI); ctx.fillStyle = C.ink; ctx.fill();
  ctx.restore();
}
function drawRoundClock(ctx, t) {
  const bellAt = rt(1.9);
  if (t < rt(0.05)) return;
  const inK = spring(t - rt(0.05), 1.6, 6.5);
  const out = E.inCubic(prog(t, rt(2.3), rt(2.7)));
  if (out >= 1) return;
  const v = clockLeft(t);
  const bell = t >= bellAt;
  const final = v <= 60;
  const ring = bell ? Math.exp(-(t - bellAt) * 5) * Math.sin((t - bellAt) * 52) : 0;
  const x0 = CLK.cx - CLK.w / 2, y0 = CLK.cy - CLK.h / 2;
  ctx.save();
  ctx.translate(CLK.cx + out * 220, CLK.cy - out * 900 + (1 - clamp(inK)) * 60);
  ctx.rotate(-0.025 + ring * 0.05 - out * 0.35);
  const sc = lerp(0.82, 1, clamp(inK, 0, 1.2)) * 1.12;
  ctx.scale(sc, sc);
  ctx.translate(-CLK.cx, -CLK.cy);
  paperShadow(ctx, () => ticketPath(ctx, x0, y0, CLK.w, CLK.h, 18, CLK.w - 150, 20), 1.1, 0.3);
  ticketPath(ctx, x0, y0, CLK.w, CLK.h, 18, CLK.w - 150, 20);
  ctx.fillStyle = C.cream; ctx.fill();
  ctx.lineWidth = 3.5; ctx.strokeStyle = C.ink; ctx.stroke();
  dashed(ctx, x0 + CLK.w - 150, y0 + 30, x0 + CLK.w - 150, y0 + CLK.h - 30, 'rgba(4,24,28,0.45)', 2.5, [7, 7]);
  ctx.save(); ctx.translate(x0 + CLK.w - 75, CLK.cy); ctx.rotate(-Math.PI / 2);
  font(ctx, 20, 500, 'mono'); ctx.letterSpacing = '4px'; ctx.fillStyle = C.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('$1 ROOM', 0, 0);
  ctx.restore();
  const lx = x0 + 44;
  font(ctx, 20, 500, 'mono'); ctx.letterSpacing = '4px'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillStyle = bell ? C.cyanShade : final ? C.sunText : C.ink2;
  ctx.fillText(bell ? 'THE BELL' : final ? 'LAST SECONDS' : 'ROUND CLOCK', lx, y0 + 62);
  const sec = Math.max(0, Math.ceil(v - 1e-6));
  const txt = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const tick = t >= rt(1.3) && t < bellAt ? Math.exp(-((t - rt(1.3)) % 0.2) * 22) : 0;
  ctx.save();
  ctx.translate(lx - 4, y0 + 212);
  ctx.scale(1 + tick * 0.06, 1 + tick * 0.06);
  font(ctx, 170, 800, 'display'); ctx.letterSpacing = '-5px';
  if (final || bell) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = bell ? C.cyan : C.sun; ctx.globalAlpha = 0.85;
    ctx.fillText(txt, 6, 5);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  ctx.fillStyle = C.ink;
  ctx.fillText(txt, 0, 0);
  ctx.restore();
  const bx = lx, by = y0 + 252, bw = CLK.w - 150 - 88, bh = 26;
  rrect(ctx, bx, by, bw, bh, 6); ctx.fillStyle = C.paper; ctx.fill();
  ctx.save(); rrect(ctx, bx, by, bw, bh, 6); ctx.clip();
  ctx.fillStyle = C.ink; ctx.globalAlpha = 0.85; ctx.fillRect(bx, by, bw * (1 - v / 300), bh);
  ctx.restore();
  rrect(ctx, bx, by, bw, bh, 6); ctx.strokeStyle = C.ink; ctx.lineWidth = 2.5; ctx.stroke();
  font(ctx, 15, 500, 'mono'); ctx.letterSpacing = '2px'; ctx.fillStyle = C.ink2;
  ctx.fillText('5:00', bx, by + bh + 26);
  ctx.textAlign = 'right'; ctx.fillText('BELL', bx + bw, by + bh + 26);
  ctx.textAlign = 'left';
  const bk = E.outBack(prog(t, bellAt, bellAt + 0.25), 2.4);
  if (bk > 0) {
    const gx = x0 + CLK.w - 215, gy = y0 + 95;
    bellGlyph(ctx, gx, gy, bk * 1.1, ring * 0.5, C.sun);
    ctx.save(); ctx.strokeStyle = C.cyanShade; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.globalAlpha = clamp(Math.exp(-(t - bellAt) * 2.2) * 1.4);
    for (let i = 0; i < 2; i++) {
      const r = 52 + i * 18 + (t - bellAt) * 40;
      ctx.beginPath(); ctx.arc(gx, gy, r, -0.6, 0.25); ctx.stroke();
      ctx.beginPath(); ctx.arc(gx, gy, r, Math.PI - 0.25, Math.PI + 0.6); ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}
function sceneRound(ctx, t) {
  bg(ctx, t);
  const d = drift(t, 0.8);
  const sh = shake(t, [rt(1.9), rt(3.7)], 14);
  ctx.save();
  ctx.translate(d.x + sh.x, d.y + sh.y);
  const top = RC.slot - RC.len * receiptFeed(t);
  const x0 = RC.cx - RC.w / 2;
  if (top < RC.slot) {
    ctx.save();
    const sway = Math.sin(t * 2.3) * 0.004;
    ctx.translate(RC.cx, RC.slot); ctx.rotate(sway); ctx.translate(-RC.cx, -RC.slot);
    const path = () => {
      ctx.beginPath();
      const zz = 16, n = Math.floor(RC.w / zz);
      ctx.moveTo(x0, RC.slot);
      ctx.lineTo(x0, top + 10);
      for (let i = 0; i <= n; i++) ctx.lineTo(x0 + i * zz, top + (i % 2 ? 0 : 10));
      ctx.lineTo(x0 + RC.w, RC.slot);
      ctx.closePath();
    };
    paperShadow(ctx, path, 1.0, 0.18);
    path(); ctx.fillStyle = C.cream; ctx.fill();
    ctx.save(); path(); ctx.clip();
    const ly = (y) => top + y;
    const L = x0 + 46, R = x0 + RC.w - 46;
    ctx.textBaseline = 'alphabetic';
    const row = (y, a, b, o = {}) => {
      font(ctx, o.size || 23, 500, 'mono'); ctx.letterSpacing = '1.5px';
      ctx.fillStyle = o.color || C.ink;
      ctx.textAlign = 'left'; ctx.fillText(a, L, ly(y));
      ctx.textAlign = 'right'; ctx.fillText(b, R, ly(y));
      ctx.textAlign = 'left';
    };
    const rule = (y) => dashed(ctx, L, ly(y), R, ly(y), 'rgba(4,24,28,0.5)', 2, [5, 6]);
    font(ctx, 36, 800, 'display'); ctx.letterSpacing = '0px'; ctx.fillStyle = C.ink; ctx.textAlign = 'center';
    ctx.fillText('ROUND OVER', RC.cx, ly(90));
    font(ctx, 18, 500, 'mono'); ctx.letterSpacing = '2px'; ctx.fillStyle = C.ink2;
    ctx.fillText('$1 ROOM  /  GOLDIE', RC.cx, ly(126));
    ctx.textAlign = 'left';
    rule(158);
    row(210, 'YOUR TICKET', '1,000');
    row(254, 'COINS EATEN', '+3,000', { color: C.tealInk });
    ['b0', 'b6', 'b5'].forEach((lk, i) => coin(ctx, L + 214 + i * 30, ly(246), { look: LOOK[lk], r: 12, expr: 'dead', time: 0, seed: i }));
    row(298, 'AT THE BELL', '4,000');
    rule(330);
    row(380, 'PROFIT', '3,000');
    row(424, 'FEE  20% OF PROFIT', '-600', { color: C.cyanShade });
    rule(458);
    font(ctx, 22, 500, 'mono'); ctx.letterSpacing = '3px'; ctx.fillStyle = C.ink; ctx.fillText('PAID', L, ly(540));
    font(ctx, 92, 800, 'display'); ctx.letterSpacing = '-2px'; ctx.textAlign = 'right';
    ctx.fillText('3,400', R, ly(546));
    font(ctx, 19, 600, 'mono'); ctx.letterSpacing = '2px'; ctx.fillStyle = C.sunText;
    ctx.fillText('$NIBAL', R, ly(580));
    ctx.textAlign = 'left';
    rule(608);
    barcode(ctx, L, ly(640), R - L, 86, 21);
    font(ctx, 18, 500, 'mono'); ctx.letterSpacing = '3px'; ctx.fillStyle = C.ink2; ctx.textAlign = 'center';
    ctx.fillText('ALIVE AT THE BELL', RC.cx, ly(772));
    ctx.fillText('SETTLED ON ROBINHOOD CHAIN', RC.cx, ly(804));
    ctx.textAlign = 'left';
    const mk = tw(t, rt(3.85), rt(4.2), E.inOutCubic);
    if (mk > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.strokeStyle = 'rgba(242,193,78,0.75)'; ctx.lineWidth = 22; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(L - 6, ly(246)); ctx.lineTo(L - 6 + (R - L + 12) * mk, ly(246) + Math.sin(mk * 3) * 2); ctx.stroke();
      ctx.restore();
    }
    const g = ctx.createLinearGradient(0, RC.slot - 60, 0, RC.slot);
    g.addColorStop(0, 'rgba(4,24,28,0)'); g.addColorStop(1, 'rgba(4,24,28,0.22)');
    ctx.fillStyle = g; ctx.fillRect(x0, RC.slot - 60, RC.w, 60);
    ctx.restore();
    stamp(ctx, 'PAID', RC.cx - 150, ly(700), -0.2, t - rt(3.7), C.tealInk, { size: 54, round: true, mono: true, scale: 1.2 });
    ctx.restore();
  }
  ctx.save();
  const px = RC.cx - 400;
  paperShadow(ctx, () => rrect(ctx, px, RC.slot - 14, 800, 140, 26), 1.3, 0);
  rrect(ctx, px, RC.slot - 14, 800, 140, 26); ctx.fillStyle = C.ink; ctx.fill();
  ctx.fillStyle = C.deep; ctx.fillRect(RC.cx - RC.w / 2 - 20, RC.slot - 6, RC.w + 40, 12);
  font(ctx, 16, 500, 'mono'); ctx.letterSpacing = '4px'; ctx.fillStyle = C.nightInk2; ctx.textBaseline = 'middle';
  ctx.fillText('COINNIBAL  /  ROUND OVER', px + 40, RC.slot + 50);
  const busy = t > rt(2.15) && t < rt(3.5);
  ctx.fillStyle = busy && Math.sin(t * 30) > 0 ? C.sun : t > rt(3.5) ? C.up : C.current;
  ctx.beginPath(); ctx.arc(px + 760, RC.slot + 48, 8, 0, TAU); ctx.fill();
  ctx.restore();
  drawRoundClock(ctx, t);
  ctx.restore();
  kicker(ctx, 'ROUNDS  /  5 MINUTES', 120, 220, t, rt(0.1), { out: rt(4.4) });
  headline(ctx, [
    { text: 'Five-minute', at: rt(0.15) },
    { text: 'rounds.', at: rt(0.3) },
    { text: 'Alive at the bell?', at: rt(1.75) },
    { text: 'Get paid.', at: rt(2.85), color: C.cyanShade },
  ], 120, 350, t, { size: 92, out: rt(4.4) });
  hud(ctx, t, 4, false, tw(t, rt(0.1), rt(0.4)) * (1 - tw(t, rt(4.5), rt(4.75))));
}

/* ───────────── 6. $NIBAL: the loop and the burn (22.8 – 28.8) ─────────────
 * The token's loop (ticket -> eat -> get paid -> burn) with a coin hopping round it; the profit bar splits
 * 80% yours, 15% burned, 5% team; the burn slice catches fire and a counter climbs; four power-up packs are
 * bought with $NIBAL and half of each drops into the fire. */
const bt = (k) => B.burn + k;
const LOOP = [
  { label: 'TICKET', x: 360 },
  { label: 'EAT', x: 760 },
  { label: 'GET PAID', x: 1160 },
  { label: 'BURN', x: 1560 },
];
const LOOP_Y = 240;
const FEE = { x: 160, y: 500, w: 1600, h: 116 };
const FIRE = { x: 1390, y: 860 };
/** A cartoon flame: three stacked tongues flickering, base at (x, y), height h. */
function flame(ctx, x, y, h, t, a = 1) {
  if (a <= 0) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha *= a;
  const tongue = (s, col, ph) => {
    const f = 1 + Math.sin(t * 13 + ph) * 0.08 + Math.sin(t * 21 + ph * 2) * 0.05;
    const lean = Math.sin(t * 7 + ph) * 0.12;
    ctx.beginPath();
    ctx.moveTo(-h * 0.42 * s, 0);
    ctx.bezierCurveTo(-h * 0.5 * s, -h * 0.5 * s * f, (-0.1 + lean) * h * s, -h * 0.75 * s * f, lean * h * s, -h * 1.25 * s * f);
    ctx.bezierCurveTo((0.12 + lean) * h * s, -h * 0.8 * s * f, h * 0.52 * s, -h * 0.5 * s * f, h * 0.42 * s, 0);
    ctx.quadraticCurveTo(0, h * 0.22 * s, -h * 0.42 * s, 0);
    ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = Math.max(2, h * 0.05); ctx.strokeStyle = C.ink; ctx.stroke();
  };
  tongue(1, C.down, 0);
  tongue(0.72, C.coral, 1.3);
  tongue(0.46, C.sun, 2.1);
  ctx.restore();
}
function loopIcon(ctx, i, x, y, t) {
  if (i === 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(-0.08);
    ticketPath(ctx, -46, -28, 92, 56, 8, 62, 7); ctx.fillStyle = C.cyan; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = C.ink; ctx.stroke();
    font(ctx, 24, 800, 'display'); ctx.fillStyle = C.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('$1', -10, 2);
    ctx.restore();
  }
  if (i === 1) chompMark(ctx, x, y, 96, { bite: 0.5 + 0.5 * Math.sin(t * 9), prey: 0.15, time: t });
  if (i === 2) {
    ctx.save(); ctx.translate(x, y);
    rrect(ctx, -32, -42, 64, 84, 6); ctx.fillStyle = C.cream; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = C.ink; ctx.stroke();
    for (let k = 0; k < 3; k++) dashed(ctx, -20, -26 + k * 13, 20, -26 + k * 13, C.ink2, 2, [3, 3]);
    nibal(ctx, 0, 20, 14);
    ctx.restore();
  }
  if (i === 3) flame(ctx, x, y + 36, 54, t, 1);
}
function puIcon(ctx, i, x, y) {
  ctx.save(); ctx.translate(x, y); ctx.strokeStyle = C.ink; ctx.fillStyle = C.ink; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (i === 0) { ctx.beginPath(); ctx.arc(0, -2, 14, Math.PI, 0); ctx.lineTo(14, 14); ctx.moveTo(-14, -2); ctx.lineTo(-14, 14); ctx.stroke(); ctx.fillRect(-18, 10, 8, 6); ctx.fillRect(10, 10, 8, 6); }
  if (i === 1) { ctx.beginPath(); ctx.moveTo(-16, 14); ctx.quadraticCurveTo(0, -30, 16, 14); ctx.stroke(); ctx.beginPath(); ctx.moveTo(8, 6); ctx.lineTo(16, 14); ctx.lineTo(20, 4); ctx.stroke(); }
  if (i === 2) { ctx.beginPath(); ctx.moveTo(4, -18); ctx.lineTo(-10, 2); ctx.lineTo(2, 2); ctx.lineTo(-4, 18); ctx.lineTo(12, -4); ctx.lineTo(0, -4); ctx.closePath(); ctx.fill(); }
  if (i === 3) { ctx.setLineDash([5, 5]); ctx.beginPath(); ctx.arc(0, 0, 16, 0, TAU); ctx.stroke(); ctx.setLineDash([]); ctx.beginPath(); ctx.arc(-6, -3, 3, 0, TAU); ctx.arc(6, -3, 3, 0, TAU); ctx.fill(); }
  ctx.restore();
}
function sceneBurn(ctx, t) {
  bg(ctx, t);
  const d = drift(t, 0.6);
  const OUT = bt(5.7);
  const gone = tw(t, OUT, OUT + 0.25);
  ctx.save();
  ctx.translate(d.x, d.y);
  // the loop strip
  ctx.save(); ctx.globalAlpha = 1 - gone;
  LOOP.forEach((n, i) => {
    const pk = E.outBack(prog(t, bt(0.05 + i * 0.12), bt(0.35 + i * 0.12)), 1.8);
    if (pk <= 0) return;
    ctx.save(); ctx.translate(n.x, LOOP_Y); ctx.scale(pk, pk);
    paperShadow(ctx, () => rrect(ctx, -150, -78, 300, 156, 22), 0.6, 0.3);
    rrect(ctx, -150, -78, 300, 156, 22); ctx.fillStyle = i === 3 ? C.ink : C.cream; ctx.fill(); ctx.lineWidth = 3.5; ctx.strokeStyle = C.ink; ctx.stroke();
    loopIcon(ctx, i, -78, 0, t);
    font(ctx, 26, 700, 'mono'); ctx.letterSpacing = '2px'; ctx.fillStyle = i === 3 ? C.sun : C.ink; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const words = n.label.split(' ');
    words.forEach((w, j) => ctx.fillText(w, -14, (j - (words.length - 1) / 2) * 30));
    font(ctx, 15, 600, 'mono'); ctx.letterSpacing = '2px'; ctx.fillStyle = i === 3 ? C.nightInk2 : C.ink2; ctx.textAlign = 'center';
    ctx.fillText(String(i + 1).padStart(2, '0'), 118, -54);
    ctx.restore();
    if (i < 3) {
      const ak = prog(t, bt(0.35 + i * 0.12), bt(0.5 + i * 0.12));
      ctx.save(); ctx.strokeStyle = C.ink; ctx.lineWidth = 4; ctx.lineCap = 'round';
      const ax = n.x + 158, bx2 = LOOP[i + 1].x - 158;
      ctx.beginPath(); ctx.moveTo(ax, LOOP_Y); ctx.lineTo(lerp(ax, bx2, ak), LOOP_Y); ctx.stroke();
      if (ak >= 1) { ctx.beginPath(); ctx.moveTo(bx2 - 10, LOOP_Y - 9); ctx.lineTo(bx2, LOOP_Y); ctx.lineTo(bx2 - 10, LOOP_Y + 9); ctx.stroke(); }
      ctx.restore();
    }
  });
  // the return arc: burn -> the next ticket
  const rk = prog(t, bt(0.6), bt(0.9));
  if (rk > 0) {
    ctx.save(); ctx.strokeStyle = C.cyanShade; ctx.lineWidth = 4; ctx.setLineDash([10, 9]); ctx.lineCap = 'round';
    ctx.beginPath();
    const steps = 40;
    for (let s = 0; s <= steps * rk; s++) { const k = s / steps; const x = lerp(LOOP[3].x, LOOP[0].x, k), y = LOOP_Y + 92 + Math.sin(k * Math.PI) * 50; s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke(); ctx.restore();
    ctx.save(); ctx.globalAlpha *= rk;
    font(ctx, 17, 600, 'mono'); ctx.letterSpacing = '4px'; ctx.fillStyle = C.cyanShade; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('AND AGAIN', W / 2, LOOP_Y + 160);
    ctx.restore();
  }
  // a $NIBAL coin hops round the loop
  const hopT = (t - bt(0.75)) / 0.4;
  if (hopT > 0) {
    const n = Math.floor(hopT), f = hopT - n;
    const a = LOOP[n % 4], b = LOOP[(n + 1) % 4];
    let p;
    if (n % 4 === 3) { const k = E.inOutCubic(f); p = { x: lerp(a.x, b.x, k), y: LOOP_Y + 92 + Math.sin(k * Math.PI) * 50 }; }
    else p = arcPt({ x: a.x + 60, y: LOOP_Y - 100 }, { x: b.x + 60, y: LOOP_Y - 100 }, E.inOutCubic(f), 70);
    nibal(ctx, p.x, p.y, 24, { spin: hopT * 3 });
  }
  ctx.restore();
  // the profit bar
  const SEG = [
    { p: 0.8, col: C.teal, txt: C.cream, label: 'YOURS', big: '80%', at: bt(1.0) },
    { p: 0.15, col: C.sun, txt: C.ink, label: 'BURNED', big: '15%', at: bt(1.45) },
    { p: 0.05, col: C.cyan, txt: C.ink, label: 'TEAM', big: '5%', at: bt(1.75) },
  ];
  const ba = tw(t, bt(0.85), bt(1.05)) * (1 - gone);
  const burnBox = { x: FEE.x + FEE.w * 0.8, w: FEE.w * 0.15 };
  ctx.save(); ctx.globalAlpha = ba;
  font(ctx, 19, 500, 'mono'); ctx.letterSpacing = '4px'; ctx.fillStyle = C.ink2; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillText('YOUR PROFIT  /  THE FEE IS 20% OF IT, NOTHING ELSE', FEE.x + 4, FEE.y - 22);
  paperShadow(ctx, () => rrect(ctx, FEE.x, FEE.y, FEE.w, FEE.h, 18), 1, 0.3);
  rrect(ctx, FEE.x, FEE.y, FEE.w, FEE.h, 18); ctx.fillStyle = C.cream; ctx.fill();
  let acc = FEE.x;
  SEG.forEach((s, i) => {
    const x = acc, w = FEE.w * s.p; acc += w;
    if (t < s.at) return;
    const k = spring(t - s.at, 1.3, 6.5);
    ctx.save();
    rrect(ctx, FEE.x, FEE.y, FEE.w, FEE.h, 18); ctx.clip();
    ctx.beginPath(); ctx.rect(x, FEE.y, w * clamp(k, 0, 1.03), FEE.h); ctx.clip();
    ctx.fillStyle = s.col; ctx.fillRect(x, FEE.y, w, FEE.h);
    font(ctx, i === 0 ? 72 : i === 1 ? 52 : 34, 800, 'display'); ctx.letterSpacing = '-1px'; ctx.fillStyle = s.txt; ctx.textBaseline = 'middle';
    ctx.textAlign = i === 0 ? 'left' : 'center';
    ctx.fillText(s.big, i === 0 ? x + 30 : x + w / 2, FEE.y + FEE.h / 2 + 4);
    ctx.restore();
    if (i > 0) dashed(ctx, x, FEE.y + 14, x, FEE.y + FEE.h - 14, 'rgba(4,24,28,0.6)', 3, [8, 8]);
    ctx.save(); ctx.globalAlpha *= tw(t, s.at + 0.1, s.at + 0.35);
    font(ctx, 22, 600, 'mono'); ctx.letterSpacing = '4px'; ctx.fillStyle = i === 1 ? C.downShade : C.ink; ctx.textBaseline = 'alphabetic';
    ctx.textAlign = i === 0 ? 'left' : i === 1 ? 'center' : 'right';
    ctx.fillText(s.label, i === 0 ? x + 4 : i === 1 ? x + w / 2 : FEE.x + FEE.w, FEE.y + FEE.h + 46);
    ctx.restore();
  });
  rrect(ctx, FEE.x, FEE.y, FEE.w, FEE.h, 18); ctx.lineWidth = 3.5; ctx.strokeStyle = C.ink; ctx.stroke();
  const fa = tw(t, bt(2.1), bt(2.4));
  if (fa > 0) for (let k = 0; k < 4; k++) flame(ctx, burnBox.x + burnBox.w * (0.14 + k * 0.24), FEE.y + 6, 56 + 16 * Math.sin(k * 2.1), t + k, fa);
  ctx.restore();
  // the fire pit and the burn counter
  const fu = E.outBack(prog(t, bt(2.0), bt(2.35)), 1.5);
  if (fu > 0) {
    ctx.save(); ctx.globalAlpha = clamp(fu) * (1 - gone);
    ctx.save(); ctx.translate(FIRE.x, FIRE.y); ctx.scale(fu, fu);
    flame(ctx, -46, 30, 110, t, 1); flame(ctx, 46, 30, 96, t + 0.7, 1); flame(ctx, 0, 34, 140, t + 1.4, 1);
    rrect(ctx, -150, 20, 300, 60, 14); ctx.fillStyle = C.ink; ctx.fill();
    font(ctx, 18, 600, 'mono'); ctx.letterSpacing = '4px'; ctx.fillStyle = C.sun; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('GONE FOR GOOD', 0, 51);
    ctx.restore();
    const burned = 450 * E.outCubic(prog(t, bt(2.3), bt(3.2))) + 1340 * E.outCubic(prog(t, bt(3.9), bt(5.3)));
    font(ctx, 20, 600, 'mono'); ctx.letterSpacing = '4px'; ctx.fillStyle = C.downShade; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('$NIBAL BURNED', 1580, 760);
    odometer(ctx, burned, 1580, 860, 92, { color: C.ink, align: 'left' });
    ctx.restore();
  }
  for (let i = 0; i < 9; i++) {
    const a = bt(2.3) + i * 0.09;
    const k = prog(t, a, a + 0.55);
    if (k <= 0 || k >= 1) continue;
    const from = { x: burnBox.x + burnBox.w * (0.2 + (i % 4) * 0.2), y: FEE.y + FEE.h };
    const p = arcPt(from, { x: FIRE.x + ((i % 3) - 1) * 30, y: FIRE.y + 10 }, E.inQuad(k), -40);
    nibal(ctx, p.x, p.y, 16, { spin: k * 9 + i, alpha: 1 - prog(k, 0.85, 1) });
  }
  // power-up packs
  const PU = [['Magnet', C.cyan], ['Leap', C.up], ['Speed', C.sun], ['Invisible', C.spray]];
  PU.forEach(([name, col], i) => {
    const at = bt(3.2) + i * 0.15;
    if (t < at) return;
    const k = spring(t - at, 1.6, 6);
    const x = 150 + i * 268, y = 830 + (1 - clamp(k)) * 300 + gone * 300;
    ctx.save(); ctx.translate(x, y); ctx.rotate(i % 2 ? 0.04 : -0.035);
    paperShadow(ctx, () => rrect(ctx, 0, -80, 240, 170, 16), 0.7, 0.3);
    rrect(ctx, 0, -80, 240, 170, 16); ctx.fillStyle = C.cream; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = C.ink; ctx.stroke();
    ctx.fillStyle = col; rrect(ctx, 14, -66, 60, 60, 12); ctx.fill(); ctx.stroke();
    puIcon(ctx, i, 44, -36);
    font(ctx, 28, 800, 'display'); ctx.letterSpacing = '0px'; ctx.fillStyle = C.ink; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(name, 86, -36);
    font(ctx, 15, 600, 'mono'); ctx.letterSpacing = '2px'; ctx.fillStyle = C.ink2;
    ctx.fillText('POWER-UP PACK', 16, 18);
    nibal(ctx, 30, 56, 14);
    font(ctx, 15, 600, 'mono'); ctx.fillStyle = C.ink; ctx.fillText('PAID IN $NIBAL', 52, 57);
    ctx.restore();
    stamp(ctx, 'HALF BURNED', x + 120, y - 112, -0.08, t - (bt(3.75) + i * 0.12), C.downShade, { size: 23, specks: false });
    for (let j = 0; j < 3; j++) {
      const a2 = bt(3.85) + i * 0.12 + j * 0.07;
      const kk = prog(t, a2, a2 + 0.6);
      if (kk <= 0 || kk >= 1) continue;
      const p = arcPt({ x: x + 120, y: y - 112 }, { x: FIRE.x + (j - 1) * 30, y: FIRE.y + 10 }, E.inQuad(kk), 160);
      nibal(ctx, p.x, p.y, 15, { spin: kk * 8 + j, alpha: 1 - prog(kk, 0.85, 1) });
    }
  });
  ctx.restore();
  kicker(ctx, '$NIBAL  /  THE TOKEN OF THE GAME', 120, 96, t, bt(0.05), { out: OUT });
  hud(ctx, t, 5, false, tw(t, bt(0.1), bt(0.4)) * (1 - gone));
}

/* ───────────── 7. THE NFT COLLECTION (28.8 – 34.8) ─────────────
 * Twelve emblems dealt face down and flipped in a wave (their rarity tiers on the frames); they sweep into
 * a fan, one comes forward as "your" card, HOLDER is stamped on it and the perks are slapped on as stickers.
 * No price, no dates. */
const nt = (k) => B.nft + k;
const GRID = { cols: 6, rows: 2, x: 190, y: 330, cw: 236, gap: 52 };
const PERKS = [
  { a: 'Half the fee', b: '10% of profit, not 20%', icon: '½', col: C.sun, at: 2.3 },
  { a: 'The $10 Room', b: 'for holders only', icon: '$10', col: C.blush, at: 3.3 },
  { a: '20% off power-ups', b: 'and +1 power-up a round', icon: '-20%', col: C.cyan, at: 4.0 },
  { a: 'A free private room', b: 'every day', icon: '1/day', col: C.up, at: 4.5 },
  { a: 'NFT skin + badge', b: 'wear it in the game', icon: '★', col: C.spray, at: 4.9 },
];
function nftCard(ctx, i, x, y, size, flip, rot = 0, lift = 0.7) {
  const sx = Math.cos(flip * Math.PI);
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot); ctx.scale(Math.max(0.02, Math.abs(sx)), 1);
  const w = size, h = size;
  paperShadow(ctx, () => rrect(ctx, -w / 2, -h / 2, w, h, 14), lift, 0.3);
  if (sx < 0) {
    const im = imgOnce(`/cache/nft/${S.nft[i % Math.max(1, S.nft.length)]?.file}`);
    ctx.save(); rrect(ctx, -w / 2, -h / 2, w, h, 14); ctx.clip();
    if (im) ctx.drawImage(im, -w / 2, -h / 2, w, h); else { ctx.fillStyle = C.reef; ctx.fill(); }
    ctx.restore();
  } else {
    rrect(ctx, -w / 2, -h / 2, w, h, 14); ctx.fillStyle = C.trench; ctx.fill();
    ctx.save(); ctx.clip(); ctx.globalAlpha = 0.5; ctx.fillStyle = ctx.createPattern(TEX.dots, 'repeat'); ctx.fillRect(-w / 2, -h / 2, w, h); ctx.restore();
    brandMark(ctx, 0, 0, size * 0.22, 'cyan');
  }
  rrect(ctx, -w / 2, -h / 2, w, h, 14); ctx.lineWidth = 4; ctx.strokeStyle = C.ink; ctx.stroke();
  ctx.restore();
}
function sceneNft(ctx, t) {
  bg(ctx, t);
  const d = drift(t, 0.6);
  ctx.save();
  ctx.translate(d.x, d.y);
  const gather = E.inOutCubic(prog(t, nt(1.55), nt(2.05)));
  const n = GRID.cols * GRID.rows;
  const hero = 4;
  const cardPose = (i) => {
    const c = i % GRID.cols, r = Math.floor(i / GRID.cols);
    const deal = nt(0.05) + i * 0.035;
    const k = spring(t - deal, 1.6, 6.5);
    const gx = GRID.x + c * (GRID.cw + GRID.gap) + GRID.cw / 2, gy = GRID.y + r * (GRID.cw + GRID.gap) + GRID.cw / 2;
    const flip = E.inOutCubic(prog(t, nt(0.55) + (c + r) * 0.06, nt(0.85) + (c + r) * 0.06));
    return { on: t >= deal, x: gx + (1 - clamp(k, 0, 1.2)) * 300, y: gy + (1 - clamp(k, 0, 1.2)) * 700, flip, rot: ((i % 3) - 1) * 0.02 };
  };
  for (let i = 0; i < n; i++) {
    if (i === hero) continue;
    const p = cardPose(i);
    if (!p.on) continue;
    const fi = i < hero ? i : i - 1;
    const fanA = (fi - 5) * 0.075;
    const fx = 520 + Math.sin(fanA) * 560, fy = 600 - Math.cos(fanA) * 120;
    nftCard(ctx, i, lerp(p.x, fx, gather), lerp(p.y, fy, gather), lerp(GRID.cw, 290, gather), p.flip, lerp(p.rot, fanA, gather));
  }
  const hp = cardPose(hero);
  if (hp.on) {
    const g = E.inOutCubic(prog(t, nt(1.6), nt(2.1)));
    const bob = Math.sin(t * 2) * 6 * g;
    const cx = lerp(hp.x, 520, g), cy = lerp(hp.y, 600, g) + bob;
    nftCard(ctx, hero, cx, cy, lerp(GRID.cw, 470, g), hp.flip, lerp(hp.rot, -0.05, g), lerp(0.7, 1.3, g));
    if (g > 0.99) stamp(ctx, 'HOLDER', cx + 70, cy + 150, -0.18, t - nt(2.05), C.sun, { size: 44, mono: true, blend: 'source-over', alpha: 1 });
  }
  PERKS.forEach((p, i) => {
    const at = nt(p.at);
    const k = prog(t, at, at + 0.22);
    if (k <= 0) return;
    const s = lerp(1.5, 1, E.outBack(k, 2));
    const x = 1010, y = 250 + i * 140;
    ctx.save(); ctx.translate(x, y); ctx.rotate(i % 2 ? 0.02 : -0.025); ctx.scale(s, s); ctx.globalAlpha = clamp(k * 3);
    paperShadow(ctx, () => rrect(ctx, 0, -54, 800, 108, 18), 0.6, 0.3);
    rrect(ctx, 0, -54, 800, 108, 18); ctx.fillStyle = C.cream; ctx.fill(); ctx.lineWidth = 3.5; ctx.strokeStyle = C.ink; ctx.stroke();
    ctx.fillStyle = p.col; rrect(ctx, 14, -40, 110, 80, 14); ctx.fill(); ctx.stroke();
    font(ctx, p.icon.length > 3 ? 28 : 38, 800, 'display'); ctx.letterSpacing = '-0.5px'; ctx.fillStyle = C.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(p.icon, 69, 3);
    ctx.textAlign = 'left';
    font(ctx, 42, 800, 'display'); ctx.fillText(p.a, 148, -10);
    font(ctx, 19, 500, 'mono'); ctx.letterSpacing = '2px'; ctx.fillStyle = C.ink2;
    ctx.fillText(p.b.toUpperCase(), 150, 30);
    ctx.restore();
    tape(ctx, x + 780, y - 48, 90, 30, 0.5, prog(t, at + 0.1, at + 0.3));
  });
  ctx.restore();
  kicker(ctx, 'THE COINNIBAL NFT COLLECTION', 120, 110, t, nt(0.0), { out: nt(5.7) });
  headline(ctx, [{ text: 'Coinnibal NFTs.', at: nt(0.1) }], 120, 230, t, { size: 92, out: nt(1.5) });
  ctx.save(); ctx.globalAlpha = tw(t, nt(0.9), nt(1.15)) * (1 - tw(t, nt(1.5), nt(1.7)));
  font(ctx, 20, 500, 'mono'); ctx.letterSpacing = '3px'; ctx.fillStyle = C.ink2; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('ONE COLLECTION  /  COMMON TO LEGENDARY', W - 120, 226);
  ctx.restore();
  ctx.save(); ctx.globalAlpha = tw(t, nt(2.2), nt(2.5)) * (1 - tw(t, nt(5.6), nt(5.8)));
  font(ctx, 22, 600, 'mono'); ctx.letterSpacing = '5px'; ctx.fillStyle = C.tealInk; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('HOLD ONE:', 1014, 170);
  ctx.restore();
  hud(ctx, t, 6, false, tw(t, nt(0.1), nt(0.4)) * (1 - tw(t, nt(5.6), nt(5.8))));
}

/* ───────────── 8. END CARD (34.8 – 40.2) ───────────── */
const et = (k) => B.end + k;
function sceneEnd(ctx, t) {
  nightBg(ctx, t);
  const d = drift(t, 0.7);
  const sh = shake(t, [et(0)], 12);
  const push = 1 + 0.04 * E.inOutCubic(prog(t, et(0), et(5.4)));
  ctx.save();
  ctx.translate(W / 2 + d.x + sh.x, H / 2 + d.y + sh.y); ctx.scale(push, push); ctx.translate(-W / 2, -H / 2);
  const slam = t - et(0);
  const s0 = slam < 0.25 ? lerp(1.25, 1, E.outExpo(Math.max(0, slam) / 0.25)) : 1;
  ctx.save();
  ctx.translate(W / 2, 330); ctx.scale(s0, s0); ctx.translate(-W / 2, -330);
  const wm = wordmark(ctx, W / 2, 220, 210, {
    center: true, diecut: true,
    letter: (i) => { const at = et(0) + Math.abs(i - 4) * 0.03; const p = prog(t, at, at + 0.14); return { p: p > 0 ? 1 : 0, dy: (1 - E.outBack(p, 2)) * -50 }; },
  });
  ctx.restore();
  shockDots(ctx, wm.ox, wm.oy, slam, C.sun, 1100, 0.45);
  const words = [['Eat', et(0.95), C.cream], ['or be', et(1.2), C.cream], ['eaten.', et(1.5), C.sun]];
  font(ctx, 100, 800, 'display'); ctx.letterSpacing = '-2.4px';
  const sp = 30;
  const ws = words.map(([w]) => ctx.measureText(w).width);
  let x = W / 2 - (ws.reduce((a, b) => a + b, 0) + sp * 2) / 2;
  words.forEach(([w, at, col], i) => {
    const k = prog(t, at, at + 0.4);
    if (k > 0) {
      const s = E.outBack(k, 2.2);
      ctx.save();
      ctx.translate(x + ws[i] / 2, 590); ctx.scale(s, s); ctx.rotate((1 - k) * (i % 2 ? 0.1 : -0.1));
      font(ctx, 100, 800, 'display'); ctx.letterSpacing = '-2.4px';
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.globalAlpha = clamp(k * 3);
      ctx.fillStyle = C.abyss; ctx.fillText(w, 4, 5);
      ctx.fillStyle = col; ctx.fillText(w, 0, 0);
      ctx.restore();
    }
    x += ws[i] + sp;
  });
  const uk = E.outBack(prog(t, et(2.1), et(2.5)), 1.4);
  if (uk > 0) {
    const tw0 = 660, th = 104, tx = W / 2 - tw0 / 2, ty = 670 + (1 - uk) * 60;
    ctx.save();
    ctx.globalAlpha = clamp(uk * 2);
    paperShadow(ctx, () => ticketPath(ctx, tx, ty, tw0, th, 12, tw0 - 190, 13), 0.9, 0.3);
    ticketPath(ctx, tx, ty, tw0, th, 12, tw0 - 190, 13); ctx.fillStyle = C.cream; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = C.ink; ctx.stroke();
    dashed(ctx, tx + tw0 - 190, ty + 18, tx + tw0 - 190, ty + th - 18, C.line, 2.5, [6, 6]);
    font(ctx, 52, 800, 'display'); ctx.letterSpacing = '-1px'; ctx.fillStyle = C.ink; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillText(window.SITE_HOST, tx + (tw0 - 190) / 2, ty + th / 2 + 2);
    font(ctx, 26, 600, 'mono'); ctx.letterSpacing = '3px'; ctx.fillStyle = C.sunText;
    ctx.fillText('$NIBAL', tx + tw0 - 95, ty + th / 2 + 2);
    ctx.restore();
  }
  ctx.save(); ctx.globalAlpha = tw(t, et(2.4), et(2.8));
  font(ctx, 21, 500, 'mono'); ctx.letterSpacing = '6px'; ctx.fillStyle = C.nightInk2; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('ON ROBINHOOD CHAIN  /  FREE PRACTICE ROOMS', W / 2, 822);
  ctx.restore();
  ctx.restore();
  // the cast peeks up from the bottom edge; the chomp mark bites on the sting
  [[260, 0, et(2.6), 'b0', 0.15], [520, 1, et(2.72), 'b4', -0.1], [1400, 2, et(2.84), 'b5', 0.08], [1660, 3, et(2.96), 'b3', -0.12]].forEach(([x0, i, at, lk, rot]) => {
    if (t < at) return;
    const k = spring(t - at, 1.6, 5);
    const y = H + 70 - k * 130 + Math.sin(t * 2.2 + i) * 6;
    coin(ctx, x0, y, { look: LOOK[lk], r: 78, expr: i % 2 ? 'love' : 'happy', lookX: x0 < W / 2 ? 0.6 : -0.6, lookY: -0.8, time: t + i, seed: i, rot });
  });
  const ck = E.outBack(prog(t, et(3.0), et(3.35)), 1.6);
  if (ck > 0) {
    chompMark(ctx, W / 2, 955, 150 * ck, { bite: t < et(3.6) ? 0.15 : clamp((t - et(3.6)) / 0.06), prey: E.inCubic(prog(t, et(3.6), et(3.8))), time: t, eye: Math.exp(-Math.pow((t - et(4.4)) / 0.05, 2)) });
  }
  const fo = prog(t, et(5.0), et(5.4));
  if (fo > 0) { ctx.save(); ctx.globalAlpha = fo; ctx.fillStyle = C.abyss; ctx.fillRect(0, 0, W, H); ctx.restore(); }
}

/* ───────────── composition ───────────── */
/** Paper wipe: the next scene slides up over the last with a torn edge. */
function wipeUp(ctx, t, a, b, drawA, drawB) {
  const k = E.inOutCubic(prog(t, a, b));
  drawA(ctx, t);
  if (k <= 0) return;
  const y = H * (1 - k);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, H + 20); ctx.lineTo(0, y);
  for (let x = 0; x <= W; x += 24) ctx.lineTo(x, y + (hash(x * 0.37) - 0.5) * 18);
  ctx.lineTo(W, H + 20); ctx.closePath();
  ctx.clip();
  ctx.translate(0, (1 - k) * 120);
  drawB(ctx, t);
  ctx.restore();
}
/** Whip pan: A leaves left, B enters from the right (motion blur from SCENE_BLUR). */
function whip(ctx, t, a, b, drawA, drawB) {
  const k = E.inOutCubic(prog(t, a, b));
  ctx.save(); ctx.translate(-k * W, 0); drawA(ctx, t); ctx.restore();
  ctx.save(); ctx.translate((1 - k) * W, 0); drawB(ctx, t); ctx.restore();
}
/** Ink flood: a blob of trench ink grows from (x, y); B shows inside it. */
function inkFlood(ctx, t, a, b, x, y, drawA, drawB) {
  const k = E.inCubic(prog(t, a, b));
  drawA(ctx, t);
  if (k <= 0) return;
  ctx.save();
  blobPath(ctx, x, y, 40 + k * 2400, 7, 0.12, 120, t * 3);
  ctx.clip();
  drawB(ctx, t);
  ctx.restore();
}

window.SCENE_DRAW = (ctx, t) => {
  if (t < B.logo) return sceneHook(ctx, t);
  if (t < B.ticket - 0.3) return sceneLogo(ctx, t);
  if (t < B.ticket) return wipeUp(ctx, t, B.ticket - 0.3, B.ticket, sceneLogo, (c) => sceneTicket(c, B.ticket));
  if (t < B.play) return sceneTicket(ctx, t);
  if (t < B.round - 0.3) return scenePlay(ctx, t);
  if (t < B.round) return whip(ctx, t, B.round - 0.3, B.round, scenePlay, (c) => sceneRound(c, B.round));
  if (t < B.burn - 0.3) return sceneRound(ctx, t);
  if (t < B.burn) return wipeUp(ctx, t, B.burn - 0.3, B.burn, sceneRound, (c) => sceneBurn(c, B.burn));
  if (t < B.nft - 0.3) return sceneBurn(ctx, t);
  if (t < B.nft) return whip(ctx, t, B.nft - 0.3, B.nft, sceneBurn, (c) => sceneNft(c, B.nft));
  if (t < B.end - 0.45) return sceneNft(ctx, t);
  if (t < B.end) return inkFlood(ctx, t, B.end - 0.45, B.end - 0.05, 520, 600, sceneNft, (c) => nightBg(c, t));
  return sceneEnd(ctx, t);
};
window.SCENE_BLUR = (t) => {
  const win = [[B.ticket - 0.3, B.ticket], [B.round - 0.3, B.round], [B.nft - 0.3, B.nft], [B.play - 0.5, B.play]];
  for (const [a, b] of win) if (t >= a && t <= b) return { k: 5, shutter: 1 / 90 };
  return { k: 1, shutter: 0 };
};
window.SCENE_DARK = (t) => t < B.logo || t >= B.end - 0.2;
window.SCENE_ASSETS = (t) => {
  const out = [];
  if (t < B.logo) { const L = hookLayout(t); out.push(footUrl(L.id, L.lt)); }
  if (t >= B.ticket + TK.diveA && t < B.round) { const s = playShot(Math.max(t, B.play)); out.push(footUrl(s.id, s.lt)); }
  return out;
};
