// UX audit (2026-11): a new player's real-money journey on the local hardhat chain, as screenshots.
//   pnpm demo:localnet            (ROUND_SECONDS=120 makes the bell come sooner)
//   node apps/web/scripts/ux-audit/journey.mjs phone|desktop
// Steps: land → connect → sign in → the ticket in USD → approve + buy → play → the bell / death → the
// receipt with the fee breakdown → the mint and its perks. Screenshots go to out/ux-audit/ (not tracked);
// a JSON log of what the UI said at each step goes next to them.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { installEvmWallet, newDevKey } from '../evm-wallet.mjs';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const OUT = `${ROOT}out/ux-audit/`;
mkdirSync(OUT, { recursive: true });
const BASE = (process.env.BASE || 'http://localhost:5173').replace(/\/$/, '');
const which = process.argv[2] === 'desktop' ? 'desktop' : 'phone';
const VP = which === 'phone' ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } };
const log = [];
const note = (step, data) => {
  log.push({ step, at: new Date().toISOString(), ...data });
  console.log(step, JSON.stringify(data).slice(0, 600));
};

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await b.newContext(VP);
const key = newDevKey();
const { address } = await installEvmWallet(ctx, { privateKey: key, autoConnect: false });
execFileSync('node', [`${ROOT}scripts/localnet-fund.mjs`, address, '1', '20000'], { stdio: 'inherit' });
await ctx.addInitScript(() => localStorage.setItem('coinnibal.brief', '1'));
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
let n = 0;
const shot = async (name, full = false) => {
  n++;
  const file = `${OUT}j-${which}-${String(n).padStart(2, '0')}-${name}.png`;
  await p.screenshot({ path: file, fullPage: full });
  return file;
};
const ui = () =>
  p.evaluate(() => {
    const s = window.__coinnibal?.useUi.getState();
    return { screen: s?.screen, room: s?.room?.id ?? null, auth: !!s?.auth, toasts: (s?.toasts ?? []).map((t) => t.text), cta: document.querySelector('.kl-cta')?.textContent ?? null };
  });
const text = (sel) => p.locator(sel).first().innerText().catch(() => null);

try {
  // 1. land
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await shot('landing');
  // 2. the game page, guest
  await p.goto(`${BASE}/play`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__coinnibal?.useUi.getState().connected, null, { timeout: 120000 });
  await p.waitForTimeout(1500);
  await shot('play-guest');
  // 3. connect
  await p.getByRole('button', { name: /connect wallet/i }).first().click();
  await p.waitForTimeout(800);
  await shot('connect-modal');
  note('connect-modal', { text: await text('[role="dialog"]') });
  await p.getByText('Dev Wallet').first().click();
  await p.waitForFunction(() => !!window.__coinnibal.useUi.getState().auth, null, { timeout: 20000 }).catch(() => note('no-auth', {}));
  await p.waitForTimeout(2500);
  await shot('signed-in');
  note('signed-in', await ui());
  // 4. pick the $1 arena and wait for its joins to open
  await p.locator('[role="radio"][data-kb-value="arena:1"]').click();
  await p.waitForTimeout(600);
  await shot('ticket-picked');
  note('ticket-picked', { usd: await text('[data-testid="ticket-usd"]'), cta: (await ui()).cta });
  const t0 = Date.now();
  while (Date.now() - t0 < 150_000) {
    const cta = (await ui()).cta ?? '';
    if (!/closed|opens|break/i.test(cta)) break;
    await p.waitForTimeout(2000);
  }
  await p.locator('.kl-cta').click();
  await p.waitForSelector('.tf-sheet', { timeout: 10000 });
  await p.waitForTimeout(800);
  await shot('ticket-review');
  note('ticket-review', { sheet: await text('.tf-sheet') });
  // the sheet's lower half (fee lines, the approval choice)
  await p.locator('.tf-end').scrollIntoViewIfNeeded().catch(() => {});
  await shot('ticket-review-bottom');
  // 5. approve + join: frames while the transactions confirm
  await p.locator('.tf-sheet .tf-pay').click();
  for (let i = 0; i < 8; i++) {
    await p.waitForTimeout(450);
    if ((await p.locator('.tf-sheet').count()) === 0) break;
    await shot(`tx-${i}`);
    note(`tx-${i}`, { status: await text('.tf-status'), error: await text('.tf-error') });
  }
  await p.waitForFunction(() => window.__coinnibal.useUi.getState().screen === 'playing', null, { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(2500);
  await shot('playing');
  note('playing', await ui());
  // a few moves so the coin is not idle (AFK)
  const vp = p.viewportSize();
  for (let i = 0; i < 6; i++) {
    await p.mouse.move(vp.width * (0.3 + 0.4 * Math.random()), vp.height * (0.3 + 0.4 * Math.random()));
    await p.waitForTimeout(700);
  }
  await shot('playing-moving');
  // 6/7. the bell (or a death): the round-over sheet with the payout and the fee lines
  const t1 = Date.now();
  while (Date.now() - t1 < 200_000) {
    const s = await ui();
    if (s.screen !== 'playing') break;
    if (await p.locator('[data-testid="round-board"], .g-receipt').count()) break;
    await p.mouse.move(vp.width * (0.3 + 0.4 * Math.random()), vp.height * (0.3 + 0.4 * Math.random()));
    await p.waitForTimeout(2500);
  }
  await p.waitForTimeout(3000);
  await shot('round-over');
  await shot('round-over-full', true);
  note('round-over', { ui: await ui(), receipt: await text('.g-receipt'), board: await text('[data-testid="round-board"]'), body: (await p.locator('body').innerText()).slice(0, 1500) });
  await p.waitForTimeout(8000);
  await shot('after-settle');
  note('after-settle', { receipt: await text('.g-receipt'), toasts: (await ui()).toasts });
  // 9. mint and perks
  await p.goto(`${BASE}/mint`, { waitUntil: 'load' });
  await p.waitForTimeout(3500);
  await shot('mint');
  await shot('mint-full', true);
  note('mint', { phase: await text('[data-testid="mt-phase"]'), price: await text('[data-testid="mt-price"]'), perks: await text('[data-testid="mt-perks"]'), blocker: await text('[data-testid="mt-blocker"]') });
} catch (err) {
  note('error', { message: String(err?.message ?? err).slice(0, 500) });
  await shot('failure').catch(() => {});
}
note('errors', { errors });
writeFileSync(`${OUT}j-${which}-log.json`, JSON.stringify(log, null, 2));
await b.close();
