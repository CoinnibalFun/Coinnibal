import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { xLinkIntentUrl, xLinkPostText } from '@elymum/shared';
import { Kb } from '../src/design';
import { translate } from '../src/i18n';
import { labelName } from '../src/render/renderer';
import { useUi } from '../src/store';
import { KillShare, SHARE_COIN, SHARE_VARIANTS, killShareText, resultShareText, victimLabel } from '../src/ui/game/ShareOnX';
import { LinkXCard } from '../src/ui/profile/LinkX';
import { resetWallets, useWallet } from '../src/wallet/store';
import { useXLink } from '../src/wallet/xlink';
import { ALICE, detail, fakeProvider } from './evm-helpers';

HTMLCanvasElement.prototype.getContext = (() => null) as never;
const initial = useUi.getState();
const t = (k: Parameters<typeof translate>[0], v?: Record<string, string | number>) => translate(k, v);
const textOf = (el: HTMLElement) => new URL((el as HTMLAnchorElement).href).searchParams.get('text');

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => useUi.setState(initial, true));
  useXLink.setState({ wallet: null, link: null, code: null, loaded: false });
  resetWallets();
  localStorage.clear();
});

describe('Link X in the share posts', () => {
  it('a kill of a linked player tags @handle (the server sent it); never a bot, never a bad handle', () => {
    expect(victimLabel(t, { victim: 'Penny', victimX: 'penny_x' })).toBe('@penny_x');
    expect(victimLabel(t, { victim: '@Penny', victimX: 'not a handle' })).toBe('Penny');
    expect(victimLabel(t, { victim: 'Botty', victimIsBot: true, victimX: 'penny_x' })).toBe('Botty (BOT)');
    useUi.setState({ screen: 'playing', share: { kind: 'kill', id: 'KiLL123456', victim: 'Penny', victimX: 'penny_x', at: Date.now() } });
    render(
      <Kb>
        <KillShare />
      </Kb>,
    );
    expect(screen.getByTestId('kill-share').textContent).toContain('You ate @penny_x!');
    const post = killShareText(t, useUi.getState().share!);
    expect(SHARE_VARIANTS.kill.map((k) => t(k, { name: '@penny_x' }))).toContain(post);
    expect(post).toContain('@penny_x');
  });

  it('a result names linked coins by @handle in its eaten list', () => {
    const post = resultShareText(t, { rank: 1, n: 5, room: 'Pond', eaten: [{ name: 'Penny', xHandle: 'penny_x' }, { name: 'Rocky', n: 2 }, { name: 'Zed', bot: true, xHandle: 'zed' }] });
    expect(SHARE_VARIANTS.resultAte.map((k) => t(k, { rank: 1, n: 5, room: 'Pond', names: '@penny_x, Rocky ×2, Zed (BOT)' }))).toContain(post);
    expect(post).not.toContain('@zed');
  });

  it('the coin name tag carries the handle after the name (people only)', () => {
    expect(labelName({ name: 'Penny', xHandle: 'penny_x' })).toBe('Penny · @penny_x');
    expect(labelName({ name: 'Penny' })).toBe('Penny');
    expect(labelName({ name: 'Bot', xHandle: 'x', isBot: true })).toBe('Bot');
  });
});

describe('the Link X card', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('a guest is asked to connect a wallet first', () => {
    render(
      <Kb>
        <LinkXCard />
      </Kb>,
    );
    const card = screen.getByTestId('link-x');
    expect(card.dataset.state).toBe('guest');
    expect(card.textContent).toContain('Connect your wallet to link X');
  });

  it('get a code, post it, paste the link, verify; then the linked account and Unlink; the consent line throughout', async () => {
    useWallet.setState({ status: 'connected', address: ALICE, chainId: 46630, current: detail(fakeProvider({ accounts: [ALICE] })) });
    useUi.setState({ auth: { address: ALICE, token: 'tok', profile: null } });
    const code = { code: 'ELYMUM-7F3K9Q', text: xLinkPostText('ELYMUM-7F3K9Q'), intentUrl: xLinkIntentUrl('ELYMUM-7F3K9Q'), expiresAt: Date.now() + 30 * 60_000 };
    const link = { handle: 'penny_x', name: 'Penny', userId: '44', avatar: true, linkedAt: Date.now() };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url, 'http://x').pathname;
        calls.push(`${init?.method ?? 'GET'} ${path}${init?.body ? ` ${init.body}` : ''}`);
        if (path === '/api/x' && (init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ link: null, code: null }));
        if (path === '/api/x/code') return new Response(JSON.stringify({ code }), { status: 201 });
        if (path === '/api/x/verify') {
          const body = JSON.parse(String(init?.body)) as { url: string };
          if (!body.url.includes('/status/')) return new Response(JSON.stringify({ error: 'x_bad_url', message: 'Paste the link of your post (x.com/<you>/status/…).' }), { status: 400 });
          return new Response(JSON.stringify({ link, code: null }));
        }
        if (path === '/api/x' && init?.method === 'DELETE') return new Response(JSON.stringify({ link: null, code: null }));
        return new Response('{}', { status: 404 });
      }),
    );
    render(
      <Kb>
        <LinkXCard />
      </Kb>,
    );
    const card = () => screen.getByTestId('link-x');
    await waitFor(() => expect(card().dataset.state).toBe('unlinked'));
    expect(card().textContent).toContain('Players who eat you can tag you on X.');
    fireEvent.click(screen.getByRole('button', { name: 'Get my code' }));
    await waitFor(() => expect(card().dataset.state).toBe('code'));
    expect(screen.getByTestId('x-code').textContent).toContain('ELYMUM-7F3K9Q');
    expect(screen.getByTestId('x-post').getAttribute('href')).toBe(code.intentUrl);
    // a wrong link: the server's refusal in words
    const field = screen.getByLabelText('Link to your post');
    fireEvent.change(field, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Paste the link of your post'));
    fireEvent.change(field, { target: { value: 'https://x.com/penny_x/status/1854012345678901234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(card().dataset.state).toBe('linked'));
    expect(card().textContent).toContain('@penny_x');
    expect(card().textContent).toContain('Players who eat you can tag you on X.');
    expect(card().querySelector('img')?.getAttribute('src')).toMatch(/\/api\/x\/avatar\/44$/);
    expect(calls).toContain('POST /api/x/verify {"url":"https://x.com/penny_x/status/1854012345678901234"}');
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(card().dataset.state).toBe('unlinked'));
  });
});
