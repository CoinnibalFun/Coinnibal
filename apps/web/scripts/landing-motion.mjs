#!/usr/bin/env node
// Motion guard for the landing's scroll reveals (site/landing/reveal.ts + reveal.css): a Playwright check that the
// print rhythm never gets in the way of reading. It needs a Chromium, so it is a script, not a vitest test:
//
//   pnpm -F @elymum/web motion:guard                                  its own stack (fake chain) on ports 8896 / 5196
//   pnpm -F @elymum/web motion:guard -- --base http://localhost:5173  against a running dev stack
//   ... --server-port 8930 --web-port 5330                            its own stack on other ports
//   ... --perf                                                        also: 4x CPU throttle, no long task, no layout shift
//   ... --shots DIR                                                   save the reduced-motion full pages there
//
// At 1440x900, 390x844 (touch) and 360x780 (touch):
//   - reading: scrolling down in 200 px steps (700 ms at each), every text element in the top 80 % of the viewport is
//     fully opaque, no target above that line still waits, and the page never scrolls sideways;
//   - ink never waits: 600 ms after a heading's top reaches 85 % of the viewport it is opaque and fed out;
//   - nothing blocks a tap: the sound button, Shuffle and every FAQ question are the top element at their centre;
//   - every bite paints over the plate above it (its cut starts above its section, z-index 5);
//   - an anchor jump (the hero's link to the NFT perks) finishes the plates it passed and plays the one it lands on;
//   - reduced motion: nothing is armed and nothing finite is playing.
// Exits 1 with a list of problems.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const SERVER_PORT = Number(opt('--server-port', '8896'));
const WEB_PORT = Number(opt('--web-port', '5196'));
const BASE = opt('--base', '').replace(/\/$/, '') || `http://localhost:${WEB_PORT}`;
const OWN_STACK = !argv.includes('--base');
const PERF = argv.includes('--perf');
const SHOTS = opt('--shots', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { name: '1440x900', w: 1440, h: 900, touch: false },
  { name: '390x844', w: 390, h: 844, touch: true },
  { name: '360x780', w: 360, h: 780, touch: true },
];

const kids = [];
async function startStack() {
  if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) throw new Error(`${BASE} already serves a stack: pass --base to use it, or pick other ports`);
  const data = mkdtempSync(join(tmpdir(), 'elymum-motion-guard-'));
  mkdirSync(join(data, 'site'), { recursive: true });
  writeFileSync(join(data, 'site/settings.json'), JSON.stringify({ wlOpen: true, collabOpen: true, mintOpen: true, gameAccess: 'public', launch: 1 }));
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
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) return () => {
      try {
        rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {}
    };
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

async function open(browser, vp, reduced = false) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: vp.touch, hasTouch: vp.touch, locale: 'en-US', reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(500);
  return { ctx, page };
}

/** In the page: text that should be readable but is not, armed targets above the 80 % line, sideways scroll. */
function readingProblems() {
  const H = innerHeight;
  const out = [];
  const opacity = (el) => {
    let o = 1;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  for (const el of document.querySelectorAll('main :is(h1, h2, h3, p, li, summary, .kb-plate__title)')) {
    if (el.closest('[aria-hidden="true"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.top < 0 || r.top > H * 0.8) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    const o = opacity(el);
    if (o < 0.99) out.push(`"${el.textContent.trim().slice(0, 40)}" at ${Math.round(r.top)}px has opacity ${o.toFixed(2)}`);
  }
  for (const el of document.querySelectorAll("[data-reveal='wait'], [data-seam='wait']")) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.top < H * 0.8) out.push(`${el.id ? `#${el.id}` : el.className.split(' ')[0]} still waits with its top at ${Math.round(r.top)}px`);
  }
  const d = document.scrollingElement || document.documentElement;
  if (d.scrollWidth > d.clientWidth + 1) out.push(`the page scrolls sideways by ${d.scrollWidth - d.clientWidth}px`);
  return out;
}

const problems = [];
async function checkViewport(browser, vp) {
  const say = (p) => problems.push(`${vp.name}: ${p}`);
  // (1) reading while scrolling down
  {
    const { ctx, page } = await open(browser, vp);
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y <= total - vp.h; y += 200) {
      await page.evaluate((y) => window.scrollTo(0, y), y);
      await sleep(700);
      for (const p of await page.evaluate(readingProblems)) say(`at ${y}px: ${p}`);
    }
    // (2) every bite paints over the plate above it
    const bites = await page.evaluate(() =>
      [...document.querySelectorAll('.ld-bite')].map((b) => {
        const sec = b.parentElement.getBoundingClientRect();
        const cut = b.querySelector('.ld-bite__cut').getBoundingClientRect();
        return { id: b.parentElement.id, above: cut.top < sec.top - 10, z: getComputedStyle(b).zIndex };
      }),
    );
    if (bites.length !== 2) say(`${bites.length} bites on the page (2 expected: Feast and FAQ)`);
    for (const b of bites) if (!b.above || b.z !== '5') say(`the bite at #${b.id} does not paint over the plate above it (z-index ${b.z})`);
    // (3) nothing blocks a tap
    for (const sel of ['.ld-sound', '.ld-fan__deal', '.ld-qa__q']) {
      const n = await page.locator(sel).count();
      for (let i = 0; i < n; i++) {
        const el = page.locator(sel).nth(i);
        await el.scrollIntoViewIfNeeded();
        await sleep(150);
        const ok = await el.evaluate((e) => {
          const r = e.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !!top && e.contains(top);
        });
        if (!ok) say(`${sel} #${i + 1} is covered at its centre`);
      }
    }
    await ctx.close();
  }
  // (4) ink never waits: a heading is readable 600 ms after its top reaches 85 % of the viewport
  {
    const { ctx, page } = await open(browser, vp);
    for (const id of ['ld-feast-h', 'ld-round-h', 'ld-arenas-h', 'ld-nft-h', 'why-nft-h', 'ld-faq-h']) {
      const top = await page.evaluate((id) => document.getElementById(id).getBoundingClientRect().top + scrollY, id);
      await page.evaluate((y) => window.scrollTo(0, y), top - vp.h * 0.85);
      await sleep(600);
      const s = await page.evaluate((id) => {
        const h = document.getElementById(id);
        const cs = getComputedStyle(h);
        // the feed's clip: inset(top right bottom left); the bottom inset is how much type is still unprinted
        const m = /inset\(([-\d.]+)px ([-\d.]+)px ([-\d.]+)px/.exec(cs.clipPath);
        return { o: Number(cs.opacity), hidden: m ? Math.max(0, Number(m[3])) : 0, hh: h.getBoundingClientRect().height };
      }, id);
      if (s.o < 0.99 || s.hidden > s.hh * 0.05) say(`#${id} is not readable 600 ms after it reached 85 % (opacity ${s.o.toFixed(2)}, ${Math.round(s.hidden)}px still unprinted)`);
    }
    await ctx.close();
  }
  // (5) an anchor jump finishes what it passed, plays where it lands
  {
    const { ctx, page } = await open(browser, vp);
    await page.click('[data-testid="ld-why-link"]');
    await sleep(900);
    const s = await page.evaluate(() => ({
      passed: ['#feast', '#round', '#arenas'].map((id) => [id, document.querySelector(id).getAttribute('data-seam')]),
      stages: [...document.querySelectorAll('#feast [data-reveal], #round [data-reveal], #arenas [data-reveal]')].map((e) => e.getAttribute('data-reveal')),
      why: document.querySelector('.ld-nft__why').getAttribute('data-reveal'),
    }));
    for (const [id, a] of s.passed) if (a !== 'set') say(`after the jump to #why-nft, ${id} is '${a}' (it was passed: 'set' expected)`);
    if (s.stages.some((a) => a === 'wait')) say(`after the jump to #why-nft, ${s.stages.filter((a) => a === 'wait').length} passed stage(s) still wait`);
    if (s.why !== 'in') say(`after the jump, the NFT perks are '${s.why}' ('in' expected: they play where the visitor lands)`);
    await ctx.close();
  }
  // (6) reduced motion: nothing armed, nothing finite playing, the finished page
  {
    const { ctx, page } = await open(browser, vp, true);
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y <= total; y += vp.h) {
      await page.evaluate((y) => window.scrollTo(0, y), y);
      await sleep(120);
    }
    const s = await page.evaluate(() => ({
      armed: document.querySelectorAll('[data-reveal], [data-seam]').length,
      playing: document
        .getAnimations()
        .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity && a.effect?.target?.closest?.('.ld-main'))
        .map((a) => a.animationName ?? a.transitionProperty ?? 'animation'),
    }));
    if (s.armed) say(`reduced motion: ${s.armed} element(s) armed`);
    if (s.playing.length) say(`reduced motion: still playing ${s.playing.join(', ')}`);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(SHOTS, `landing-reduced-${vp.name}.png`), fullPage: true });
    }
    await ctx.close();
  }
}

async function perf(browser) {
  const vp = VIEWPORTS[1];
  const { ctx, page } = await open(browser, vp);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.evaluate(() => {
    window.__long = [];
    window.__shift = 0;
    new PerformanceObserver((l) => l.getEntries().forEach((e) => e.duration > 50 && window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask' });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => !e.hadRecentInput && (window.__shift += e.value))).observe({ type: 'layout-shift' });
  });
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= total; y += 320) {
    await page.mouse.wheel(0, 320);
    await sleep(160);
  }
  await sleep(1500);
  const s = await page.evaluate(() => ({ long: window.__long, shift: window.__shift }));
  if (s.long.length) problems.push(`perf (4x CPU, ${vp.name}): long task(s) of ${s.long.join(', ')} ms while the seams played`);
  if (s.shift > 0.001) problems.push(`perf: the reveals shifted the layout (CLS ${s.shift.toFixed(3)})`);
  await ctx.close();
}

let cleanup = () => {};
try {
  if (OWN_STACK) cleanup = await startStack();
  const browser = await chromium.launch();
  try {
    for (const vp of VIEWPORTS) await checkViewport(browser, vp);
    if (PERF) await perf(browser);
  } finally {
    await browser.close();
  }
} catch (e) {
  problems.push(`guard error: ${e.message.split('\n')[0]}`);
} finally {
  stopStack();
  cleanup();
}
if (problems.length) {
  console.log(`✗ landing motion: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('✓ landing motion: readable while it prints, nothing blocked, nothing stuck, reduced motion still');
