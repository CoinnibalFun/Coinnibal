// UX audit (2026-11): the error states of the ticket flow on the local hardhat chain, as screenshots.
//   pnpm demo:localnet
//   node apps/web/scripts/ux-audit/errors.mjs [phone|desktop] [case...]
// Cases: reject (the wallet refuses the transaction), notokens (ETH, no game tokens), nogas (tokens, no ETH),
// wrongnet (the wallet is on another chain and refuses to switch), rpcdown (the chain RPC is unreachable from
// the page), serverdown (the game server goes away mid-game), replaced (the socket is closed with CLOSE_REPLACED,
// 4000: the same wallet opened the game in another tab). Screenshots and a JSON log go to out/ux-audit/.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { installEvmWallet, newDevKey } from '../evm-wallet.mjs';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const OUT = `${ROOT}out/ux-audit/`;
mkdirSync(OUT, { recursive: true });
const BASE = (process.env.BASE || 'http://localhost:5173').replace(/\/$/, '');
const which = process.argv[2] === 'desktop' ? 'desktop' : 'phone';
const ALL = ['reject', 'notokens', 'nogas', 'wrongnet', 'rpcdown', 'serverdown', 'replaced'];
const cases = process.argv.slice(3).length ? process.argv.slice(3) : ALL;
const VP = which === 'phone' ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } };
const log = [];
const note = (step, data) => {
  log.push({ step, ...data });
  console.log(step, JSON.stringify(data).slice(0, 700));
};
const fund = (addr, eth, tokens) => execFileSync('node', [`${ROOT}scripts/localnet-fund.mjs`, addr, String(eth), String(tokens)], { stdio: 'ignore' });

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });

async function setup({ eth = 1, tokens = 20000, allowTransactions = true, chainId = 31337, rejectSwitch = false } = {}) {
  const ctx = await b.newContext(VP);
  const { address } = await installEvmWallet(ctx, { privateKey: newDevKey(), autoConnect: false, allowTransactions, chainId });
  if (rejectSwitch) {
    // the player presses "Cancel" on the wallet's network switch
    await ctx.addInitScript(() => {
      const orig = window.__coinnibalWalletRequest;
      window.__coinnibalWalletRequest = (m, params) =>
        m === 'wallet_switchEthereumChain' || m === 'wallet_addEthereumChain' ? Promise.resolve({ error: { code: 4001, message: 'User rejected the request.' } }) : orig(m, params);
    });
  }
  if (eth || tokens) fund(address, eth, tokens);
  await ctx.addInitScript(() => localStorage.setItem('coinnibal.brief', '1'));
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  return { ctx, p, address, errors };
}

async function signIn(p) {
  await p.goto(`${BASE}/play`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__coinnibal?.useUi.getState().connected, null, { timeout: 120000 });
  await p.getByRole('button', { name: /connect wallet/i }).first().click();
  await p.waitForTimeout(700);
  await p.getByText('Dev Wallet').first().click();
  await p.waitForFunction(() => !!window.__coinnibal.useUi.getState().auth, null, { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(2500);
}

async function openTicket(p) {
  await p.locator('[role="radio"][data-kb-value="arena:1"]').click();
  await p.waitForTimeout(500);
  const t0 = Date.now();
  while (Date.now() - t0 < 150_000) {
    const cta = (await p.locator('.kl-cta').first().textContent().catch(() => '')) ?? '';
    if (!/closed|opens|break/i.test(cta)) break;
    await p.waitForTimeout(2000);
  }
  await p.locator('.kl-cta').click();
  await p.waitForSelector('.tf-sheet', { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(800);
}

const read = (p, sel) => p.locator(sel).first().innerText().catch(() => null);
const state = (p) =>
  p.evaluate(() => {
    const s = window.__coinnibal?.useUi.getState();
    return { screen: s?.screen, room: s?.room?.id ?? null, connected: s?.connected, toasts: (s?.toasts ?? []).map((t) => t.text) };
  });

for (const c of cases) {
  const tag = `e-${which}-${c}`;
  try {
    if (c === 'reject') {
      const { ctx, p, errors } = await setup({ allowTransactions: false });
      await signIn(p);
      await openTicket(p);
      await p.locator('.tf-sheet .tf-pay').click();
      await p.waitForTimeout(3000);
      await p.screenshot({ path: `${OUT}${tag}.png` });
      note(c, { error: await read(p, '.tf-error'), status: await read(p, '.tf-status'), pay: await read(p, '.tf-pay'), errors });
      await ctx.close();
    } else if (c === 'notokens') {
      const { ctx, p, errors } = await setup({ tokens: 0 });
      await signIn(p);
      await p.screenshot({ path: `${OUT}${tag}-lobby.png` });
      // the ticket button is disabled without tokens: what does the player see?
      await p.locator('[role="radio"][data-kb-value="arena:1"]').click();
      await p.waitForTimeout(800);
      await p.screenshot({ path: `${OUT}${tag}.png` });
      note(c, { cta: await read(p, '.kl-cta'), disabled: await p.locator('.kl-cta').isDisabled().catch(() => null), slot: await read(p, '.kl-cta-slot'), errors });
      await ctx.close();
    } else if (c === 'nogas') {
      const { ctx, p, errors } = await setup({ eth: 0, tokens: 20000 });
      await signIn(p);
      await openTicket(p);
      await p.screenshot({ path: `${OUT}${tag}.png` });
      const pay = p.locator('.tf-sheet .tf-pay');
      const disabled = await pay.isDisabled().catch(() => null);
      if (disabled === false) {
        await pay.click();
        await p.waitForTimeout(3500);
        await p.screenshot({ path: `${OUT}${tag}-after.png` });
      }
      note(c, { disabled, warn: await read(p, '.tf-warn'), error: await read(p, '.tf-error'), errors });
      await ctx.close();
    } else if (c === 'wrongnet') {
      const { ctx, p, errors } = await setup({ chainId: 1, rejectSwitch: true });
      await signIn(p);
      await p.screenshot({ path: `${OUT}${tag}-lobby.png` });
      await openTicket(p);
      await p.locator('.tf-sheet .tf-pay').click().catch(() => {});
      await p.waitForTimeout(3000);
      await p.screenshot({ path: `${OUT}${tag}.png` });
      note(c, { error: await read(p, '.tf-error'), status: await read(p, '.tf-status'), errors });
      await ctx.close();
    } else if (c === 'rpcdown') {
      const { ctx, p, errors } = await setup();
      // every read the page makes to the chain RPC fails (the wallet's own RPC is in Node and still works)
      await p.route(/127\.0\.0\.1:8545|localhost:8545/, (r) => r.abort('connectionrefused'));
      await signIn(p);
      await p.waitForTimeout(3000);
      await p.screenshot({ path: `${OUT}${tag}-lobby.png` });
      await openTicket(p);
      await p.screenshot({ path: `${OUT}${tag}.png` });
      note(c, { sheet: await read(p, '.tf-sheet'), cta: await read(p, '.kl-cta'), body: (await p.locator('body').innerText()).slice(0, 600), errors });
      await ctx.close();
    } else if (c === 'serverdown') {
      const { ctx, p, errors } = await setup();
      await signIn(p);
      await openTicket(p);
      await p.locator('.tf-sheet .tf-pay').click();
      await p.waitForFunction(() => window.__coinnibal.useUi.getState().screen === 'playing', null, { timeout: 60000 }).catch(() => {});
      await p.waitForTimeout(2000);
      // the game server goes away: new sockets are refused, the open one drops
      await p.routeWebSocket(/\/ws/, (ws) => ws.close({ code: 1006, reason: 'down' }));
      await p.evaluate(() => window.__coinnibal.engine.net.ws.close());
      for (const s of [2, 8, 20]) {
        await p.waitForTimeout(s * 1000);
        await p.screenshot({ path: `${OUT}${tag}-${s}s.png` });
        note(`${c}-${s}s`, { state: await state(p), body: (await p.locator('body').innerText()).slice(0, 500) });
      }
      // the server is back
      await p.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      await p.routeWebSocket(/\/ws/, (ws) => ws.connectToServer());
      await p.waitForTimeout(12000);
      await p.screenshot({ path: `${OUT}${tag}-back.png` });
      note(`${c}-back`, { state: await state(p), errors });
      await ctx.close();
    } else if (c === 'replaced') {
      const { ctx, p, errors } = await setup();
      await signIn(p);
      await openTicket(p);
      await p.locator('.tf-sheet .tf-pay').click();
      await p.waitForFunction(() => window.__coinnibal.useUi.getState().screen === 'playing', null, { timeout: 60000 }).catch(() => {});
      await p.waitForTimeout(2000);
      // the server closes this socket with CLOSE_REPLACED (4000): another tab of the same wallet took the coin
      await p.evaluate(() => {
        const ws = window.__coinnibal.engine.net.ws;
        const onclose = ws.onclose;
        ws.onclose = null;
        ws.close();
        onclose({ code: 4000 });
      });
      await p.waitForTimeout(3000);
      await p.screenshot({ path: `${OUT}${tag}.png` });
      note(c, { state: await state(p), body: (await p.locator('body').innerText()).slice(0, 400) });
      // "Play here" takes the game back
      await p.getByRole('button', { name: /play here/i }).click().catch(() => {});
      await p.waitForTimeout(5000);
      await p.screenshot({ path: `${OUT}${tag}-back.png` });
      note(`${c}-back`, { state: await state(p), errors });
      await ctx.close();
    }
  } catch (err) {
    note(`${c}-failed`, { message: String(err?.message ?? err).slice(0, 400) });
  }
}
writeFileSync(`${OUT}e-${which}-log.json`, JSON.stringify(log, null, 2));
await b.close();
