// UX audit helper: screenshots of a page at phone and desktop size, plus the visible buttons and links.
//   node apps/web/scripts/ux-audit/explore.mjs <path> <tag>   (stack: pnpm demo:localnet)
//   NOWALLET=1: no injected wallet (a phone browser); CLICK=<regex>: press that button first
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { installEvmWallet, newDevKey } from '../evm-wallet.mjs';

const OUT = new URL('../../../../out/ux-audit/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const BASE = (process.env.BASE || 'http://localhost:5173').replace(/\/$/, '');
const [path = '/', tag = 'page'] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
for (const [name, vp, mobile] of [
  ['phone', { width: 390, height: 844 }, true],
  ['desktop', { width: 1440, height: 900 }, false],
]) {
  // the phone is an iPhone in Safari (no wallet extension there): what the deep links are for
  const userAgent = mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' : undefined;
  const ctx = await b.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, ...(userAgent ? { userAgent } : {}) });
  if (!process.env.NOWALLET) await installEvmWallet(ctx, { privateKey: newDevKey() });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  if (process.env.CLICK) {
    await p.getByRole('button', { name: new RegExp(process.env.CLICK, 'i') }).first().click().catch(() => {});
    await p.waitForTimeout(1200);
  }
  await p.screenshot({ path: `${OUT}${tag}-${name}.png` });
  await p.screenshot({ path: `${OUT}${tag}-full-${name}.png`, fullPage: true });
  const btns = await p.$$eval('button, a', (els) =>
    els.filter((e) => e.offsetParent).map((e) => `${e.tagName}:${(e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50)}|${e.getAttribute('href') || ''}`),
  );
  console.log(name, JSON.stringify(btns.slice(0, 80)));
  console.log('errors', errs);
  await ctx.close();
}
await b.close();
