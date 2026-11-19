import { FEEDBACK_LIMITS, type FeedbackEntry, type RoomInfo } from '@coinnibal/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupSummary, parseAdminHash } from '../src/admin/groups';
import { FeedbackTab } from '../src/admin/site/FeedbackTab';
import { APP_VERSION } from '../src/config';
import { Kb, Tabs } from '../src/design';
import { setEngine } from '../src/game/instance';
import { adminApi } from '../src/site/api';
import { useUi } from '../src/store';
import { FeedbackSheet } from '../src/ui/feedback/FeedbackSheet';
import { feedbackContext, feedbackRoom } from '../src/ui/feedback/feedback';
import { GameHud, SettingsSheet } from '../src/ui/game';
import { installDomStubs, json, mockFetch, type Call } from './site-helpers';

const ui0 = useUi.getState();
let restore = () => {};
let calls: Call[] = [];
beforeEach(() => installDomStubs());
afterEach(() => {
  restore();
  act(() => useUi.setState(ui0, true));
  setEngine(null);
});

const W = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const room = (o: Partial<RoomInfo>): RoomInfo => ({ id: 'r', mode: 'arena', name: 'R', width: 1, height: 1, players: 0, bots: 0, maxPlayers: 10, ...o });

describe('feedback: what the sheet adds by itself', () => {
  it('names the room kind only in a game', () => {
    expect(feedbackRoom('lobby', room({ mode: 'arena' }))).toBeNull();
    expect(feedbackRoom('playing', null)).toBeNull();
    expect(feedbackRoom('playing', room({ mode: 'practice' }))).toBe('practice');
    expect(feedbackRoom('dead', room({ mode: 'private' }))).toBe('private');
    expect(feedbackRoom('playing', room({ mode: 'private', custom: {} as never }))).toBe('custom');
    expect(feedbackRoom('spectating', room({ mode: 'arena' }))).toBe('arena');
    expect(feedbackRoom('roundover', room({ mode: 'arena', test: true }))).toBe('test');
  });

  it('sends the page path, the room, the viewport and the build (never the wallet: the server reads the session)', () => {
    const ctx = feedbackContext({ screen: 'playing', room: room({ mode: 'practice' }) }, { pathname: '/play', width: 390.4, height: 844 });
    expect(ctx).toEqual({ page: '/play', room: 'practice', viewport: '390x844', build: APP_VERSION });
    expect(ctx).not.toHaveProperty('wallet');
    expect(feedbackContext({ screen: 'lobby', room: null }, { pathname: `/${'x'.repeat(400)}`, width: 1e9, height: -3 })).toMatchObject({ room: null, viewport: '99999x0' });
    expect(feedbackContext({ screen: 'lobby', room: null }, { pathname: `/${'x'.repeat(400)}`, width: 1, height: 1 }).page).toHaveLength(FEEDBACK_LIMITS.page);
  });
});

describe('feedback: the sheet', () => {
  const sheet = () =>
    render(
      <Kb>
        <FeedbackSheet />
      </Kb>,
    );

  it('needs a message, sends it with the session and the context, then thanks the player', async () => {
    ({ calls, restore } = mockFetch({ 'POST /api/feedback': (c: Call) => json(201, { ok: true, echo: c.body }) }));
    act(() => useUi.setState({ modal: 'feedback', screen: 'lobby', auth: { address: W, token: 'tok', profile: null } }));
    sheet();
    const send = screen.getByTestId('fb-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByText(/your wallet\.$/)).toBeTruthy();
    const box = screen.getByTestId('fb-text') as HTMLTextAreaElement;
    expect(box.maxLength).toBe(1000);
    expect((screen.getByTestId('fb-contact') as HTMLInputElement).maxLength).toBe(100);
    fireEvent.change(box, { target: { value: '  The timer is hard to read.  ' } });
    fireEvent.change(screen.getByTestId('fb-contact'), { target: { value: '@me' } });
    expect(screen.getByText('30 / 1,000')).toBeTruthy();
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await screen.findByTestId('fb-thanks');
    expect(screen.getByText('Thank you. Your message reached the team.')).toBeTruthy();
    const call = calls.find((c) => c.method === 'POST' && c.path === '/api/feedback')!;
    expect(call.auth).toBe('Bearer tok');
    expect(call.body).toEqual({ text: 'The timer is hard to read.', contact: '@me', page: '/', room: null, viewport: `${innerWidth}x${innerHeight}`, build: APP_VERSION });
    // "Send another" starts over
    fireEvent.click(screen.getByRole('button', { name: 'Send another' }));
    expect((screen.getByTestId('fb-text') as HTMLTextAreaElement).value).toBe('');
  });

  it('a guest sends without a session; a refusal says why in plain words and keeps the text', async () => {
    ({ calls, restore } = mockFetch({ 'POST /api/feedback': json(429, { error: 'rate_limited', message: 'You sent several messages just now. Try again in a few minutes.' }) }));
    act(() => useUi.setState({ modal: 'feedback', auth: null }));
    sheet();
    expect(screen.getByText('Sent with it: this page, your screen size and the app version.')).toBeTruthy();
    fireEvent.change(screen.getByTestId('fb-text'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('fb-send'));
    const err = await screen.findByTestId('fb-error');
    expect(err.textContent).toBe('Your message was not sent. You sent several messages just now. Try again in a few minutes.');
    expect(err.getAttribute('role')).toBe('alert');
    expect((screen.getByTestId('fb-text') as HTMLTextAreaElement).value).toBe('Hello');
    expect(calls[0].auth).toBeNull();
    // no server at all
    restore();
    globalThis.fetch = vi.fn(async () => Promise.reject(new TypeError('offline'))) as typeof fetch;
    fireEvent.click(screen.getByTestId('fb-send'));
    await waitFor(() => expect(screen.getByTestId('fb-error').textContent).toMatch(/Cannot reach the server/));
  });
});

describe('feedback: where the button is', () => {
  it('the in-game top bar has a Feedback key (desktop), and the settings sheet links to the sheet', () => {
    act(() => useUi.setState({ screen: 'playing', room: room({ mode: 'practice', name: 'Rookie Pond #1' }), me: { pid: 1, name: 'Daphne', skin: 4 } }));
    const { unmount } = render(
      <Kb>
        <GameHud />
      </Kb>,
    );
    fireEvent.click(screen.getByTestId('hud-feedback'));
    expect(useUi.getState().modal).toBe('feedback');
    unmount();
    act(() => useUi.setState({ modal: 'settings' }));
    render(
      <Kb>
        <SettingsSheet />
      </Kb>,
    );
    fireEvent.click(screen.getByTestId('settings-feedback'));
    expect(useUi.getState().modal).toBe('feedback');
  });
});

const entry = (o: Partial<FeedbackEntry>): FeedbackEntry => ({ id: 'aaaaaaaaaaaa', at: Date.UTC(2026, 10, 19, 10, 0), text: 'Hi', contact: '', wallet: null, page: '/play', room: null, viewport: '390x844', build: '0.1.0', read: false, ...o });

describe('feedback: the admin drawer', () => {
  const api = adminApi('admin-token');

  it('lists the messages newest first as plain text, marks them read and deletes them', async () => {
    const items = [
      entry({ id: 'bbbbbbbbbbbb', text: '<b>not bold</b>\nsecond line', contact: 'me@example.com', wallet: null }),
      entry({ id: 'aaaaaaaaaaaa', text: 'The bell is great.', wallet: W, room: 'arena', read: true }),
    ];
    ({ calls, restore } = mockFetch({
      'GET /api/admin/feedback': { items, total: 2, unread: 1 },
      'PUT /api/admin/feedback/bbbbbbbbbbbb': (c: Call) => ({ entry: { ...items[0], read: (c.body as { read: boolean }).read }, unread: 0 }),
      'DELETE /api/admin/feedback/aaaaaaaaaaaa': { unread: 0 },
    }));
    vi.stubGlobal('confirm', () => true);
    const onUnread = vi.fn();
    render(
      <Kb>
        <FeedbackTab api={api} onUnread={onUnread} />
      </Kb>,
    );
    const rows = await screen.findAllByTestId('admin-feedback-item');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('1 unread · 2 kept')).toBeTruthy();
    expect(onUnread).toHaveBeenCalledWith(1);
    // plain text: the markup shows as typed, nothing is turned into HTML or a link
    const text = rows[0].querySelector('.ad-fb__text')!;
    expect(text.textContent).toBe('<b>not bold</b>\nsecond line');
    expect(text.querySelector('b')).toBeNull();
    expect(rows[0].querySelector('a')).toBeNull();
    expect(within(rows[0]).getByText('me@example.com')).toBeTruthy();
    expect(within(rows[0]).getByText('guest')).toBeTruthy();
    expect(within(rows[1]).getByText('0xAbCd…Ef01')).toBeTruthy();
    expect(within(rows[1]).getByText('/play · arena')).toBeTruthy();
    expect(calls[0].auth).toBe('Bearer admin-token');

    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Mark read' }));
    await within(rows[0]).findByRole('button', { name: 'Mark unread' });
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ read: true });
    expect(onUnread).toHaveBeenLastCalledWith(0);

    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getAllByTestId('admin-feedback-item')).toHaveLength(1));
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/admin/feedback/aaaaaaaaaaaa')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('is a drawer of its own (#feedback) with the unread count as a badge and in its summary line', () => {
    expect(parseAdminHash('#feedback').group).toBe('feedback');
    expect(groupSummary('feedback', { net: {} as never, status: null, feedbackUnread: 3 })).toEqual({ now: '3 unread messages.', next: 'Read them below, newest first.' });
    expect(groupSummary('feedback', { net: {} as never, status: null, feedbackUnread: 0 }).next).toBeNull();
    render(
      <Kb>
        <Tabs items={[{ id: 'safety', label: 'Safety' }, { id: 'feedback', label: 'Feedback', badge: 3 }]} value="safety" onChange={() => {}} label="Admin sections" />
      </Kb>,
    );
    expect(screen.getByRole('tab', { name: 'Feedback 3' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Safety' }).querySelector('.kb-tab__badge')).toBeNull();
  });
});
