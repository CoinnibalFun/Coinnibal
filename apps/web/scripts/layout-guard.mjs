#!/usr/bin/env node
// Layout guard: a fast Playwright check that the web app holds up at the core viewports.
//   - no horizontal page scroll on the site pages, the lobby and the in-game HUD;
//   - no two key HUD pieces (timer, pond tag, standings, worth, minimap, power-ups, menu buttons,
//     Split / Tip / sticker buttons, the thumb stick, the dock and the key hints) drawn over each other;
//   - every HUD piece inside the visible screen, clear of an emulated notch / home bar on phones.
// It needs a Chromium (the CI job skips the browser download), so it is a script, not a vitest test:
//
//   pnpm -F @elymum/web layout:guard             starts its own stack (fake chain) on ports 8897 / 5197
//   pnpm -F @elymum/web layout:guard -- --base http://localhost:5173    against a running dev stack
//
// About a minute on a laptop. Exits 1 with a list of problems when the layout regresses.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const SERVER_PORT = Number(opt('--server-port', '8897'));
const WEB_PORT = Number(opt('--web-port', '5197'));
const BASE = opt('--base', '').replace(/\/$/, '') || `http://localhost:${WEB_PORT}`;
const OWN_STACK = !argv.includes('--base');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The core viewports; phones get a notch and a home bar (env(safe-area-inset-*)). */
const VIEWPORTS = [
  { name: '360x640', w: 360, h: 640, touch: true },
  { name: '375x667', w: 375, h: 667, touch: true },
  { name: '390x844', w: 390, h: 844, touch: true, safe: { top: 47, bottom: 34, left: 0, right: 0 } },
  { name: '844x390', w: 844, h: 390, touch: true, safe: { top: 0, bottom: 21, left: 47, right: 47 } },
  { name: '768x1024', w: 768, h: 1024, touch: true },
  { name: '1280x720', w: 1280, h: 720, touch: false },
  { name: '1440x900', w: 1440, h: 900, touch: false },
  { name: '2560x1440', w: 2560, h: 1440, touch: false },
];

/** HUD pieces that must never cover one another (leaf stickers, not their columns). */
const PIECES = [
  '.g-round',
  '.g-pond',
  '.g-standings',
  '.g-till',
  '.g-map__disc',
  '.g-topbar',
  '.g-pu__chip',
  '.g-boost',
  '.g-touch__btn',
  '.g-stick',
  '.g-dock',
  '.g-keys-peek',
  '.g-boosts-dock .g-peek__tab',
];

const kids = [];
async function startStack() {
  if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) throw new Error(`${BASE} already serves a stack: pass --base to use it, or pick other ports`);
  const data = mkdtempSync(join(tmpdir(), 'elymum-layout-guard-'));
  kids.push(
    spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: join(ROOT, 'apps/server'),
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, TRUST_PROXY: '1', NODE_ENV: 'development', DEV_FAKE_CHAIN: '1', DEV_FAKE_TOKEN: '1', GAME_ACCESS: 'public', PORT: String(SERVER_PORT), DATA_DIR: data },
    }),
    spawn('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], {
      cwd: join(ROOT, 'apps/web'),
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, GAME_SERVER: `http://127.0.0.1:${SERVER_PORT}` },
    }),
  );
  for (let i = 0; i < 90; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) return () => rmSync(data, { recursive: true, force: true });
    await sleep(1000);
  }
  throw new Error('the stack did not come up');
}
function stopStack() {
  for (const k of kids) {
    try {
      process.kill(-k.pid, 'SIGTERM');
    } catch {}
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (stopStack(), process.exit(130)));

/** In the page: horizontal overflow of the document (px past the right edge, 0 when none). */
const overflowX = () => {
  const d = document.scrollingElement || document.documentElement;
  return Math.max(0, d.scrollWidth - d.clientWidth);
};

/** In the page: pairs of HUD pieces that overlap, and pieces outside the safe screen. */
function hudProblems([pieces, safe]) {
  const W = innerWidth;
  const H = innerHeight;
  const seen = [];
  for (const sel of pieces)
    for (const el of document.querySelectorAll(`.g-hud ${sel}`)) {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      seen.push({ sel, el, r });
    }
  // the guard must see the HUD it guards: a renamed class would make it pass on nothing
  const out = seen.length < 6 ? [`only ${seen.length} HUD pieces found (${[...new Set(seen.map((p) => p.sel))].join(', ')}): the guard's selectors are stale`] : [];
  const name = (p) => `${p.sel}${p.el.getAttribute('aria-label') ? `[${p.el.getAttribute('aria-label')}]` : ''}`;
  for (let i = 0; i < seen.length; i++) {
    const a = seen[i];
    const s = safe ?? { top: 0, bottom: 0, left: 0, right: 0 };
    if (a.r.left < s.left - 1 || a.r.top < s.top - 1 || a.r.right > W - s.right + 1 || a.r.bottom > H - s.bottom + 1)
      out.push(`${name(a)} leaves the safe screen (${Math.round(a.r.left)},${Math.round(a.r.top)} ${Math.round(a.r.width)}x${Math.round(a.r.height)})`);
    for (let j = i + 1; j < seen.length; j++) {
      const b = seen[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (x > 3 && y > 3) out.push(`${name(a)} overlaps ${name(b)} by ${Math.round(x)}x${Math.round(y)}px`);
    }
  }
  return out;
}

async function newPage(browser, vp) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1, isMobile: vp.touch, hasTouch: vp.touch, locale: 'en-US', reducedMotion: 'reduce' });
  await ctx.addInitScript(() => {
    localStorage.setItem('elymum.settings.v1', JSON.stringify({ name: 'WWWWWWWWWWWWWWWW', skin: 4, theme: 'light', quality: 'low', sound: false, showMinimap: true, showChat: true, showFps: true }));
    localStorage.setItem('elymum.brief', '1');
    localStorage.setItem('elymum.autoQuality', 'off');
  });
  const page = await ctx.newPage();
  if (vp.safe) await (await ctx.newCDPSession(page)).send('Emulation.setSafeAreaInsetsOverride', { insets: vp.safe }).catch(() => {});
  return { ctx, page };
}

const problems = [];
async function checkViewport(browser, vp) {
  const { ctx, page } = await newPage(browser, vp);
  try {
    for (const path of ['/', '/mint', '/faucet']) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      await sleep(400);
      const o = await page.evaluate(overflowX);
      if (o > 1) problems.push(`${vp.name} ${path}: the page scrolls sideways by ${o}px`);
    }
    await page.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__elymum?.useUi.getState().connected, null, { timeout: 30000 });
    await sleep(600);
    let o = await page.evaluate(overflowX);
    if (o > 1) problems.push(`${vp.name} lobby: the page scrolls sideways by ${o}px`);
    await page.evaluate(() => window.__elymum.engine.play('practice'));
    await page.waitForFunction(() => window.__elymum.useUi.getState().screen === 'playing', null, { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector('.gm-intro__card'), null, { timeout: 12000 }).catch(() => {});
    // the fullest HUD: power-ups owned and running, chat and kill feed lines
    await page.evaluate(() => {
      const E = window.__elymum.engine;
      const s = window.__elymum.useUi.getState();
      window.__elymum.useUi.setState({ boosts: { ...(s.boosts ?? {}), usable: true, signedIn: true, disabled: [], cooldownMs: { magnet: 0, leap: 0, speed: 0, invis: 0 }, charges: { magnet: 3, leap: 2, speed: 3, invis: 3 } } });
      for (let i = 0; i < 3; i++) E.onMessage({ t: 'kf', killer: 'WWWWWWWWWWWWWWWW', killerSkin: 1, victim: 'MMMMMMMMMMMMMMMM', victimSkin: 2, cause: 'eat' });
      for (let i = 0; i < 3; i++) E.onMessage({ t: 'chat', pid: 7, from: 'WWWWWWWWWWWWWWWW', skin: 3, text: 'gg wp '.repeat(12) });
      E.onMessage({ t: 'powerup', type: 1, ms: 30000 });
      E.onMessage({ t: 'powerup', type: 2, ms: 30000 });
    });
    await sleep(900);
    o = await page.evaluate(overflowX);
    if (o > 1) problems.push(`${vp.name} hud: the page scrolls sideways by ${o}px`);
    for (const p of await page.evaluate(hudProblems, [PIECES, vp.safe ?? null])) problems.push(`${vp.name} hud: ${p}`);
    if (process.env.LAYOUT_GUARD_SHOTS) await page.screenshot({ path: join(process.env.LAYOUT_GUARD_SHOTS, `hud-${vp.name}.png`) });
  } catch (e) {
    problems.push(`${vp.name}: ${e.message.split('\n')[0]}`);
  } finally {
    await ctx.close().catch(() => {});
  }
}

const t0 = Date.now();
const cleanup = OWN_STACK ? await startStack() : null;
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  // two at a time: the HUD pages draw the game, which is the slow part
  const queue = [...VIEWPORTS];
  await Promise.all([0, 1].map(async () => {
    while (queue.length) await checkViewport(browser, queue.shift());
  }));
} finally {
  await browser.close();
  stopStack();
  cleanup?.();
}
if (problems.length) {
  console.error(`layout guard: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`layout guard: ${VIEWPORTS.length} viewports clean (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
