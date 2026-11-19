// UX audit helper: the connection banner over the lobby and over a game, and the "How to get tokens" sheet, at
// phone and desktop size (screenshots to out/ux-audit/). It sets the store's `netDown` the way the socket would, and
// opens the sheet the way its links do (stack: pnpm demo:localnet).
//   node apps/web/scripts/ux-audit/banner-check.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = new URL('../../../../out/ux-audit/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const BASE = (process.env.BASE || 'http://localhost:5173').replace(/\/$/, '');
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
for (const [name, vp, mobile] of [
  ['phone', { width: 390, height: 844 }, true],
  ['desktop', { width: 1440, height: 900 }, false],
]) {
  const ctx = await b.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await ctx.addInitScript(() => localStorage.setItem('coinnibal.brief', '1'));
  const p = await ctx.newPage();
  await p.goto(`${BASE}/play`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__coinnibal?.useUi.getState().connected, null, { timeout: 120000 });
  await p.waitForTimeout(1200);
  await p.evaluate(() => window.__coinnibal.useUi.setState({ netDown: { kind: 'replaced', attempt: 0, retryAt: null } }));
  await p.waitForTimeout(600);
  const bg = await p.evaluate(() => {
    const el = document.querySelector('.g-conn');
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  console.log(name, 'scrim', bg);
  await p.screenshot({ path: `${OUT}banner-${name}-replaced.png` });
  // "How to get tokens"
  await p.evaluate(() => window.__coinnibal.useUi.setState({ netDown: null, modal: 'tokens' }));
  await p.waitForTimeout(900);
  await p.screenshot({ path: `${OUT}gettokens-${name}.png` });
  await p.evaluate(() => window.__coinnibal.useUi.setState({ modal: null }));
  await p.waitForTimeout(500);
  // a practice game, then the socket drops
  await p.evaluate(() => window.__coinnibal.useUi.setState({ netDown: null }));
  await p.evaluate(() => window.__coinnibal.engine.play('practice'));
  await p.waitForFunction(() => window.__coinnibal.useUi.getState().screen === 'playing', null, { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(1500);
  await p.evaluate(() => window.__coinnibal.useUi.setState({ netDown: { kind: 'lost', attempt: 3, retryAt: performance.now() + 4000 } }));
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}banner-${name}-lost.png` });
  await ctx.close();
}
await b.close();
