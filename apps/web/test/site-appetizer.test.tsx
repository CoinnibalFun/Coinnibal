import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { typedHandle } from '../src/site/appetizer/AppetizerSheet';
import { readAppetizer, saveAppetizer } from '../src/site/appetizer/stored';
import { Landing } from '../src/site/landing/Landing';
import { resetSiteSettings } from '../src/site/settings';
import { storageKey } from '../src/storageKey';
import { SETTINGS, installDomStubs, json, mockFetch, type Call } from './site-helpers';

const WALLET = '0x52908400098527886E0F7030069857D2E4169EE7';
const CARD = { code: 'Ab3dE5gH9k', no: 42, handle: 'Satoshi_Nibbles', at: Date.UTC(2026, 10, 22, 10) };

let restore = () => {};
beforeEach(() => {
  installDomStubs();
  resetSiteSettings();
  localStorage.clear();
  history.replaceState(null, '', '/');
});
afterEach(() => restore());

function serve(open: boolean, claim?: (call: Call) => unknown, extra: Record<string, unknown> = {}) {
  const m = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, appetizerOpen: open } }, ...(claim ? { 'POST /api/appetizer': claim } : {}), ...extra });
  restore = m.restore;
  return m;
}

/** Renders the landing, waits for the settings, opens the slip and waits for the lazy sheet. */
async function openSheet() {
  render(<Landing />);
  const slip = await screen.findByTestId('ld-appetizer');
  await waitFor(() => expect(document.querySelector('.ld-ap')).toBeTruthy());
  fireEvent.click(slip);
  return screen.findByRole('dialog', undefined, { timeout: 5000 });
}

const fill = (dialog: HTMLElement, wallet: string, handle: string) => {
  fireEvent.change(within(dialog).getByLabelText('Wallet address'), { target: { value: wallet } });
  fireEvent.change(within(dialog).getByLabelText('X handle'), { target: { value: handle } });
};
const serveButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: /Serve my Appetizer/ });

describe('the Appetizer on the landing', { timeout: 30_000 }, () => {
  it('shows the slip in the hero while it is open, and nothing while it is closed', async () => {
    serve(false);
    const { unmount } = render(<Landing />);
    await waitFor(() => expect(document.querySelector('.ld-ap')).toBeNull());
    expect(document.getElementById('appetizer')).toBeNull();
    unmount();
    resetSiteSettings();
    serve(true);
    render(<Landing />);
    const slip = await screen.findByTestId('ld-appetizer');
    expect(slip.textContent).toContain('Appetizers are out');
    expect(slip.closest('#appetizer')).toBeTruthy();
    expect(slip.closest('.ld-hero')).toBeTruthy();
  });

  it('checks the wallet and the handle before ordering', async () => {
    const m = serve(true, () => ({ card: CARD, existing: false }));
    const dialog = await openSheet();
    fireEvent.click(serveButton(dialog));
    expect(await within(dialog).findByText('Enter your wallet address.')).toBeTruthy();
    expect(within(dialog).getByText('Enter your X handle.')).toBeTruthy();
    fill(dialog, '0x1234', 'not a handle!');
    fireEvent.click(serveButton(dialog));
    expect(await within(dialog).findByText(/That is not a wallet address/)).toBeTruthy();
    expect(within(dialog).getByText(/That is not an X handle/)).toBeTruthy();
    expect(m.calls.some((c) => c.method === 'POST')).toBe(false);
    // a handle as a profile link or with its @ is fine, its case kept
    expect(typedHandle('https://x.com/Satoshi_Nibbles')).toBe('Satoshi_Nibbles');
    expect(typedHandle('@Ana')).toBe('Ana');
    expect(typedHandle('sixteen_letters_')).toBeNull();
  });

  it('serves the card: the share link and the buttons, never the wallet', async () => {
    const m = serve(true, () => ({ card: CARD, existing: false }));
    const dialog = await openSheet();
    fill(dialog, WALLET, '@Satoshi_Nibbles');
    fireEvent.click(serveButton(dialog));
    expect(await within(dialog).findByTestId('ap-share-link')).toBeTruthy();
    const post = m.calls.find((c) => c.method === 'POST' && c.path === '/api/appetizer');
    expect(post?.body).toEqual({ wallet: WALLET, handle: 'Satoshi_Nibbles' });
    expect(within(dialog).getByTestId('ap-share-link').textContent).toBe(`${location.host}/appetizer/${CARD.code}`);
    expect(within(dialog).getByTestId('ap-served-lede').textContent).toBe('Table for @Satoshi_Nibbles, card No. 0042. Post it and show it off.');
    const x = within(dialog).getByTestId('ap-post-x').getAttribute('href') ?? '';
    const text = new URL(x).searchParams.get('text') ?? '';
    expect(text).toContain('card No. 0042');
    expect(text).toContain(`https://${location.host}/appetizer/${CARD.code}`);
    expect(within(dialog).getByRole('button', { name: /Download card/ })).toBeTruthy();
    // the wallet is nowhere: not in the sheet, the page, the post, the link or the browser's storage
    for (const s of [document.body.innerHTML, x, location.href, JSON.stringify({ ...localStorage })]) {
      expect(s.toLowerCase()).not.toContain(WALLET.toLowerCase());
      expect(s).not.toContain('9EE7');
    }
    expect(readAppetizer()).toEqual(CARD);
    // the slip now names the visitor's card
    await waitFor(() => expect(screen.getByTestId('ld-appetizer').textContent).toContain('Your card No. 0042'));
  });

  it('records the post link and thanks the visitor', async () => {
    const m = serve(true, () => ({ card: CARD, existing: false }), { [`POST /api/appetizer/${CARD.code}/post`]: { ok: true } });
    const dialog = await openSheet();
    fill(dialog, WALLET, 'Satoshi_Nibbles');
    fireEvent.click(serveButton(dialog));
    const link = await within(dialog).findByLabelText(/Paste the link/);
    fireEvent.change(link, { target: { value: 'not a link' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save link' }));
    expect(await within(dialog).findByText('That is not a link to an X post.')).toBeTruthy();
    fireEvent.change(link, { target: { value: 'https://x.com/Satoshi_Nibbles/status/1234567890' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save link' }));
    expect(await within(dialog).findByText('Thanks for sharing. Enjoy your Appetizer!')).toBeTruthy();
    expect(m.calls.find((c) => c.path === `/api/appetizer/${CARD.code}/post`)?.body).toEqual({ url: 'https://x.com/Satoshi_Nibbles/status/1234567890' });
    expect(readAppetizer()?.posted).toBe(true);
  });

  it.each([
    ['closed', 403, 'The kitchen is closed for now. Follow @coinnibalfun to hear when it opens again.'],
    ['bad_wallet', 400, 'That is not a wallet address. It starts with 0x, then 40 letters and numbers.'],
    ['bad_handle', 400, 'That is not an X handle. Use 1 to 15 letters, numbers or underscores.'],
    ['handle_taken', 409, 'This handle already has an Appetizer.'],
    ['wallet_taken', 409, 'This wallet already has its Appetizer, under another handle.'],
    ['rate_limited', 429, 'Too many orders from here. Wait a little and try again.'],
    ['network', 0, 'Cannot reach the kitchen right now. Check your connection and try again.'],
  ] as const)('says what went wrong: %s', async (code, status, message) => {
    serve(true, () => {
      if (code === 'network') throw new TypeError('Failed to fetch');
      return json(status, { error: code, message: 'server words', ...(code === 'wallet_taken' ? { field: 'wallet' } : {}) });
    });
    const dialog = await openSheet();
    fill(dialog, WALLET, 'Satoshi_Nibbles');
    fireEvent.click(serveButton(dialog));
    expect(await within(dialog).findByText(message)).toBeTruthy();
    expect(within(dialog).queryByTestId('ap-share-link')).toBeNull();
    expect(readAppetizer()).toBeNull();
    if (code === 'closed') expect((serveButton(dialog) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a returning visitor sees their card again, and #appetizer opens it', async () => {
    saveAppetizer({ ...CARD, posted: true });
    expect(localStorage.getItem(storageKey('appetizer.v1'))).not.toContain('wallet');
    history.replaceState(null, '', '/#appetizer');
    serve(true);
    render(<Landing />);
    const dialog = await screen.findByRole('dialog', undefined, { timeout: 5000 });
    expect(within(dialog).getByRole('heading', { name: 'Your Appetizer' })).toBeTruthy();
    expect(within(dialog).getByTestId('ap-share-link').textContent).toContain(`/appetizer/${CARD.code}`);
    expect(within(dialog).getByText('Thanks for sharing. Enjoy your Appetizer!')).toBeTruthy();
    expect(screen.getByTestId('ld-appetizer').textContent).toContain('Your card No. 0042');
    // forgetting it brings the order form back
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /Clear it from this browser/ })));
    expect(readAppetizer()).toBeNull();
    expect(within(dialog).getByLabelText('Wallet address')).toBeTruthy();
  });
});
