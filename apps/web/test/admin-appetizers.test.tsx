import type { AppetizerEntry } from '@coinnibal/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_GROUPS, GROUP_LABEL, groupSummary, parseAdminHash } from '../src/admin/groups';
import { AppetizersTab } from '../src/admin/site/AppetizersTab';
import { SettingsTab } from '../src/admin/site/SettingsTab';
import { startRows } from '../src/admin/Start';
import { Kb } from '../src/design';
import { adminApi } from '../src/site/api';
import { SETTINGS, installDomStubs, mockFetch, type Call } from './site-helpers';

const api = adminApi('admin-token');
const W1 = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const W2 = '0x1111111111111111111111111111111111111111';
const card = (over: Partial<AppetizerEntry>): AppetizerEntry => ({ code: 'AAAAAAAAAA', no: 1, handle: 'Nibbler_01', at: Date.UTC(2026, 10, 20, 12), wallet: W1, post: null, postedAt: null, views: 0, ...over });

let restore = () => {};
let calls: Call[] = [];
beforeEach(() => installDomStubs());
afterEach(() => {
  restore();
  vi.unstubAllGlobals();
});

const ui = (el: ReactElement) => render(<Kb>{el}</Kb>);

describe('admin: the Appetizers drawer', () => {
  it('lists the cards newest first: number, handle link, full wallet with copy, claimed, post, views, and the totals', async () => {
    const items = [card({ code: 'BBBBBBBBBB', no: 2, handle: 'CoinFan', wallet: W2, post: 'https://x.com/CoinFan/status/42', postedAt: 2, views: 7 }), card({})];
    ({ calls, restore } = mockFetch({ 'GET /api/admin/appetizers': { items, total: 2, posted: 1 } }));
    ui(<AppetizersTab api={api} />);
    const rows = await screen.findAllByTestId('admin-appetizer-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('admin-appetizers-totals').textContent).toBe('2 cards · 1 posted');
    expect(within(rows[0]).getByText('0002')).toBeTruthy();
    expect(within(rows[0]).getByRole('link', { name: '@CoinFan' }).getAttribute('href')).toBe('https://x.com/CoinFan');
    expect(within(rows[0]).getByText(W2)).toBeTruthy();
    expect(within(rows[0]).getByRole('link', { name: 'Post' }).getAttribute('href')).toBe('https://x.com/CoinFan/status/42');
    expect(within(rows[0]).getByText('7')).toBeTruthy();
    expect(within(rows[1]).getByText(W1)).toBeTruthy();
    expect(within(rows[1]).getByText('—')).toBeTruthy();
    expect(within(rows[1]).queryByRole('link', { name: 'Post' })).toBeNull();
    expect(calls[0]).toMatchObject({ path: '/api/admin/appetizers?offset=0&limit=100', auth: 'Bearer admin-token' });

    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Copy wallet' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(W1));
  });

  it('searches by handle or wallet on the server', async () => {
    ({ calls, restore } = mockFetch({
      'GET /api/admin/appetizers': (c: Call) => ({ items: c.path.includes('q=coin') ? [card({ handle: 'CoinFan' })] : [card({}), card({ code: 'CCCCCCCCCC', no: 2 })], total: 2, posted: 0 }),
    }));
    ui(<AppetizersTab api={api} />);
    expect(await screen.findAllByTestId('admin-appetizer-row')).toHaveLength(2);
    fireEvent.change(screen.getByPlaceholderText('Search handle or wallet'), { target: { value: 'coin' } });
    await waitFor(() => expect(screen.getAllByTestId('admin-appetizer-row')).toHaveLength(1));
    expect(calls.at(-1)!.path).toBe('/api/admin/appetizers?offset=0&limit=100&q=coin');
  });

  it('deletes a card after a confirm, and not without one', async () => {
    ({ calls, restore } = mockFetch({
      'GET /api/admin/appetizers': { items: [card({ code: 'BBBBBBBBBB', no: 2 }), card({})], total: 2, posted: 0 },
      'DELETE /api/admin/appetizers/AAAAAAAAAA': { ok: true, total: 1, posted: 0 },
    }));
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    ui(<AppetizersTab api={api} />);
    const rows = await screen.findAllByTestId('admin-appetizer-row');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('No. 0001 (@Nibbler_01)'));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getAllByTestId('admin-appetizer-row')).toHaveLength(1));
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/admin/appetizers/AAAAAAAAAA')).toBe(true);
    expect(screen.getByTestId('admin-appetizers-totals').textContent).toBe('1 card · 0 posted');
  });

  it('exports the CSV with the admin session', async () => {
    ({ calls, restore } = mockFetch({
      'GET /api/admin/appetizers': { items: [], total: 0, posted: 0 },
      'GET /api/admin/appetizers.csv': () => new Response('no,handle,wallet,claimed,post,views\r\n', { status: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="coinnibal-appetizers-2026-11-22.csv"' } }),
    }));
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    ui(<AppetizersTab api={api} />);
    expect(await screen.findByText(/No cards yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(calls.find((c) => c.path === '/api/admin/appetizers.csv')?.auth).toBe('Bearer admin-token');
  });

  it('is a drawer of its own (#appetizers) with its totals in the summary line and a row on the start screen', () => {
    expect(ADMIN_GROUPS).toContain('appetizers');
    expect(GROUP_LABEL.appetizers).toBe('Appetizers');
    expect(parseAdminHash('#appetizers').group).toBe('appetizers');
    expect(groupSummary('appetizers', { net: {} as never, status: null, appetizers: { total: 12, posted: 3 } }).now).toBe('12 cards handed out · 3 posted on X.');
    expect(groupSummary('appetizers', { net: {} as never, status: null, appetizers: null }).now).toMatch(/Sign in/);
    const base = { net: { chain: null, info: null } as never, status: null, registry: null, signed: null, access: null, accessEnv: null, feedback: null, deployLeft: 0, fresh: false };
    const row = (appetizers: { total: number; posted: number } | null | undefined) => startRows({ ...base, appetizers }).find((r) => r.id === 'appetizers')!;
    expect(row({ total: 1, posted: 0 })).toMatchObject({ label: 'Appetizers', value: '1 card · 0 posted.', tone: 'ok' });
    expect(row(null).value).toBe('Sign in to see.');
    expect(row(undefined).value).toBe('Not on this server yet.');
  });

  it('Settings: the Appetizer switch saves appetizerOpen alone', async () => {
    const live = { ...SETTINGS, appetizerOpen: true };
    ({ calls, restore } = mockFetch({
      'GET /api/admin/settings': { settings: live, gameAccessEnv: null },
      'PUT /api/admin/settings': (c: Call) => ({ settings: { ...live, ...(c.body as object) }, gameAccessEnv: null }),
    }));
    ui(<SettingsTab api={api} />);
    const sw = (await screen.findByRole('switch', { name: /Appetizer cards open/ })) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Settings saved.');
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ appetizerOpen: false });
  });
});
