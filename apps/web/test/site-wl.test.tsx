import type { PublicWlTask, WlEntryPublic } from '@coinnibal/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteApp } from '../src/site/mount';
import { navigate } from '../src/site/router';
import { useSession } from '../src/site/session';
import { resetSiteSettings } from '../src/site/settings';
import { buildSteps, stepError, submitBody } from '../src/site/wl/steps';
import { WlPage } from '../src/site/wl/WlPage';
import { SETTINGS, installDomStubs, json, mockFetch, type Call } from './site-helpers';

const WALLET = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const POST = 'https://x.com/riso_rita/status/1849000000000000001';

const TASKS: PublicWlTask[] = [
  { id: 'follow_x', kind: 'follow_x', title: 'Follow @coinnibalfun', body: 'Follow us.', target: 'https://x.com/coinnibalfun', required: true, available: true },
  { id: 'post_x', kind: 'post_x', title: 'Post about Coinnibal on X', body: 'Post and paste the link.', target: null, required: true, available: true },
  { id: 'engage_launch', kind: 'engage_x', title: 'Like, repost and reply', body: '', target: null, required: false, available: false },
  { id: 't_join', kind: 'join_link', title: 'Join the Discord', body: '', target: 'https://discord.gg/coinnibal', required: true, available: true },
  { id: 't_text', kind: 'text', title: 'Why Coinnibal?', body: '', target: null, required: false, available: true },
  { id: 'x_handle', kind: 'text', title: 'Your X handle', body: 'The account you used.', target: null, required: true, available: true },
  { id: 'wallet', kind: 'wallet', title: 'Your EVM wallet', body: 'Sign in.', target: null, required: true, available: true },
];

const entry = (status: WlEntryPublic['status']): WlEntryPublic => ({ id: 'w1', wallet: WALLET, xHandle: 'riso_rita', status, tasks: [], createdAt: Date.UTC(2026, 9, 17), updatedAt: Date.UTC(2026, 9, 17) });

let restore = () => {};
beforeEach(() => {
  installDomStubs();
  resetSiteSettings();
  localStorage.clear();
  useSession.setState({ session: null, signing: false, error: null });
});
afterEach(() => restore());

describe('WL steps (logic)', () => {
  it('pins the handle first and the wallet sign-in last, keeping the admin order between', () => {
    expect(buildSteps(TASKS).map((s) => s.kind)).toEqual(['handle', 'follow_x', 'post_x', 'engage_x', 'join_link', 'text', 'sign']);
  });

  it('applies the server rules inline', () => {
    const steps = buildSteps(TASKS);
    const [handle, follow, post, engage, join, text, sign] = steps;
    expect(stepError(handle, {}, '', false)).toMatch(/Enter your X handle/);
    expect(stepError(handle, {}, 'not a handle!', false)).toMatch(/not an X handle/);
    expect(stepError(handle, {}, '@Riso_Rita', false)).toBeNull();
    expect(stepError(handle, {}, 'https://x.com/riso_rita', false)).toBeNull();
    expect(stepError(follow, {}, '', false)).toMatch(/Tick this/);
    expect(stepError(follow, { follow_x: true }, '', false)).toBeNull();
    expect(stepError(post, { post_x: 'https://example.com/x' }, '', false)).toMatch(/not a link to an X post/);
    expect(stepError(post, { post_x: POST }, '', false)).toBeNull();
    expect(stepError(engage, {}, '', false)).toBeNull(); // not live yet: skipped
    expect(stepError(join, {}, '', false)).toMatch(/joined/);
    expect(stepError(text, { t_text: 'x'.repeat(501) }, '', false)).toMatch(/500/);
    expect(stepError(sign, {}, '', false)).toMatch(/Sign in/);
    expect(stepError(sign, {}, '', true)).toBeNull();
    expect(submitBody(steps, { follow_x: true, post_x: ` ${POST} `, t_join: true, t_text: '' }, '@Riso_Rita', '')).toEqual({
      xHandle: 'riso_rita',
      answers: { follow_x: true, post_x: POST, t_join: true },
    });
  });
});

describe('/wl', { timeout: 30_000 }, () => {
  it('walks the stepper task by task, validates inline, submits and shows the status', async () => {
    let sent: unknown = null;
    ({ restore } = mockFetch({
      'GET /api/site/settings': { settings: SETTINGS },
      'GET /api/site/tasks': { tasks: TASKS },
      'GET /api/site/wl': { entry: null },
      'POST /api/site/wl': (c: Call) => {
        sent = c.body;
        expect(c.auth).toBe('Bearer tok');
        return json(201, { entry: entry('pending') });
      },
    }));
    render(<WlPage />);
    await screen.findByRole('heading', { name: 'Join the WL in 7 steps.' });
    // the way back to an earlier entry: the same plain sentence as on the closed WL
    expect(screen.getByRole('button', { name: 'Sign in to see an earlier entry' })).toBeTruthy();
    // every kind renders its step
    for (const t of ['Your X handle', 'Follow @coinnibalfun', 'Post about Coinnibal on X', 'Like, repost and reply', 'Join the Discord', 'Why Coinnibal?', 'Your EVM wallet']) expect(screen.getAllByText(t).length).toBeGreaterThan(0);

    const next = () => fireEvent.click(within(document.querySelector<HTMLElement>('.wl-step.is-active')!).getByRole('button', { name: /^(Next|Skip for now)$/ }));
    fireEvent.change(screen.getByLabelText('Your X handle'), { target: { value: 'bad handle!' } });
    next();
    expect(screen.getByText(/That is not an X handle/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Your X handle'), { target: { value: '@Riso_Rita' } });
    next();
    // follow: the link points at the target, the tick is required
    expect(screen.getByRole('link', { name: /Follow @coinnibalfun/ }).getAttribute('href')).toBe('https://x.com/coinnibalfun');
    next();
    expect(screen.getByText('Tick this once you follow.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'I follow' }));
    next();
    // post: an intent link with the text, and an X status link
    expect(screen.getByRole('link', { name: /Post on X/ }).getAttribute('href')).toMatch(/^https:\/\/x\.com\/intent\/post\?text=.*coinnibalfun/);
    fireEvent.change(screen.getByLabelText('Link to your post'), { target: { value: 'https://example.com/post' } });
    next();
    expect(screen.getByText(/not a link to an X post/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Link to your post'), { target: { value: POST } });
    next();
    // engage: not live yet
    expect(screen.getByText('Opens when the post is live.')).toBeTruthy();
    next();
    // join link
    expect(screen.getByRole('link', { name: /Open the invite/ }).getAttribute('href')).toBe('https://discord.gg/coinnibal');
    fireEvent.click(screen.getByRole('button', { name: 'I joined' }));
    next();
    // optional text
    fireEvent.change(screen.getByLabelText(/Your answer/), { target: { value: 'Coins.' } });
    next();
    // sign-in step: the send button waits for the session
    const send = screen.getByRole('button', { name: 'Join the WL' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    act(() => useSession.setState({ session: { address: WALLET, token: 'tok', admin: false } }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Join the WL' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Join the WL' }));
    await screen.findByRole('heading', { name: "You're in the queue." });
    expect(sent).toEqual({ xHandle: 'riso_rita', answers: { follow_x: true, post_x: POST, t_join: true, t_text: 'Coins.' } });
    expect(screen.getByTestId('wl-status').textContent).toBe('pending');
  });

  it('shows a handle the server already has next to the handle step', async () => {
    ({ restore } = mockFetch({
      'GET /api/site/settings': { settings: SETTINGS },
      'GET /api/site/tasks': { tasks: TASKS.filter((t) => t.kind === 'wallet' || t.id === 'x_handle') },
      'GET /api/site/wl': { entry: null },
      'POST /api/site/wl': json(409, { error: 'handle_taken', message: 'This X handle has already applied.', field: 'xHandle' }),
    }));
    useSession.setState({ session: { address: WALLET, token: 'tok', admin: false } });
    render(<WlPage />);
    fireEvent.change(await screen.findByLabelText('Your X handle'), { target: { value: 'riso_rita' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Join the WL' }));
    expect(await screen.findByText('This X handle has already applied.')).toBeTruthy();
    expect(screen.getByLabelText('Your X handle')).toBeTruthy();
  });

  it.each([
    ['approved', "You're on the list."],
    ['rejected', 'Not this time.'],
  ] as const)('shows a returning applicant their status (%s)', async (status, title) => {
    ({ restore } = mockFetch({
      'GET /api/site/settings': { settings: SETTINGS },
      'GET /api/site/tasks': { tasks: TASKS },
      'GET /api/site/wl': { entry: entry(status) },
    }));
    useSession.setState({ session: { address: WALLET, token: 'tok', admin: false } });
    render(<WlPage />);
    expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByTestId('wl-status').textContent).toBe(status);
  });

  it('when the WL is off: the site\'s shared closed notice (guide, home, X), and an earlier applicant can still sign in', async () => {
    ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, wlOpen: false } }, 'GET /api/site/tasks': { tasks: TASKS } }));
    render(<WlPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Not open yet.' })).toBeTruthy();
    expect(screen.getByTestId('closed-page')).toBeTruthy();
    // "WL" is defined once, in plain words
    expect(screen.getByText('This is where you will join the WL (the whitelist). People on the WL can mint the NFT before everyone else. The guide explains how the game works.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Read the guide/ }).getAttribute('href')).toBe('/docs');
    expect(screen.getByRole('link', { name: /Back to home/ }).getAttribute('href')).toBe('/');
    expect(screen.getAllByRole('link', { name: /@coinnibalfun/ })[0].getAttribute('href')).toBe('https://x.com/coinnibalfun');
    // the sign-in (and its "install a wallet" line) only after a click on "Sign in to see an earlier entry"
    expect(document.body.textContent).not.toMatch(/MetaMask|No browser wallet/);
    const again = screen.getByRole('button', { name: 'Sign in to see an earlier entry' });
    expect(again.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(again);
    expect(again.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Sign in with the wallet you applied with to see your status.')).toBeTruthy();
  });

  it('the tab of a closed WL reads like every other closed page; an earlier applicant\'s status keeps "WL"', async () => {
    const closed = { ...SETTINGS, wlOpen: false };
    history.pushState(null, '', '/wl');
    try {
      ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: closed }, 'GET /api/site/tasks': { tasks: TASKS } }));
      const view = render(<SiteApp />);
      expect(await screen.findByRole('heading', { level: 1, name: 'Not open yet.' })).toBeTruthy();
      // the settings landed after the page claimed its title: SiteApp's title effect ran again and kept the claim
      await waitFor(() => expect(document.title).toBe('Not open yet · Coinnibal'));
      // leaving the page drops the claim
      act(() => navigate('/'));
      await waitFor(() => expect(document.title).toBe('Coinnibal · Coins eating coins'));
      view.unmount();
      restore();

      // the WL closed, but this wallet applied before: its status page, under the WL's own title
      history.pushState(null, '', '/wl');
      resetSiteSettings();
      ({ restore } = mockFetch({ 'GET /api/site/settings': { settings: closed }, 'GET /api/site/tasks': { tasks: TASKS }, 'GET /api/site/wl': { entry: entry('pending') } }));
      useSession.setState({ session: { address: WALLET, token: 'tok', admin: false } });
      render(<SiteApp />);
      expect(await screen.findByTestId('wl-status')).toBeTruthy();
      await waitFor(() => expect(document.title).toBe('WL · Coinnibal'));
    } finally {
      history.pushState(null, '', '/');
    }
  });

  it('the wallet step shows the full EVM address that goes on the list', async () => {
    ({ restore } = mockFetch({
      'GET /api/site/settings': { settings: SETTINGS },
      'GET /api/site/tasks': { tasks: TASKS.filter((t) => t.kind === 'wallet' || t.id === 'x_handle') },
      'GET /api/site/wl': { entry: null },
    }));
    useSession.setState({ session: { address: WALLET, token: 'tok', admin: false } });
    render(<WlPage />);
    fireEvent.change(await screen.findByLabelText('Your X handle'), { target: { value: 'riso_rita' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect((await screen.findByTestId('wl-wallet')).textContent).toContain(WALLET);
  });
});
