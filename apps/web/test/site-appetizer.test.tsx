import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { followIntent, typedHandle } from '../src/site/appetizer/AppetizerSheet';
import { resetOurPost } from '../src/site/appetizer/PostBox';
import { readAppetizer, readStep, resetSteps, saveAppetizer } from '../src/site/appetizer/stored';
import { setMatchingQueries } from '../src/test/media';
import { Landing } from '../src/site/landing/Landing';
import { resetSiteSettings } from '../src/site/settings';
import { storageKey } from '../src/storageKey';
import { SETTINGS, installDomStubs, json, mockFetch, type Call } from './site-helpers';

const WALLET = '0x52908400098527886E0F7030069857D2E4169EE7';
const CARD = { code: 'Ab3dE5gH9k', no: 42, handle: 'Satoshi_Nibbles', at: Date.UTC(2026, 10, 22, 10) };
const OUR_POST = 'https://x.com/Coinnibalfun/status/2123416055406354866';

let restore = () => {};
beforeEach(() => {
  installDomStubs();
  resetSiteSettings();
  localStorage.clear();
  resetSteps();
  resetOurPost();
  history.replaceState(null, '', '/');
});
afterEach(() => {
  restore();
  setMatchingQueries([]);
});

/** Our post as `GET /api/appetizer/post` shows it. */
const OUR_VIEW = {
  url: OUR_POST,
  handle: 'Coinnibalfun',
  name: 'Coinnibal',
  avatar: 'https://pbs.twimg.com/profile_images/1/me_400x400.png',
  text: 'The kitchen is open. Grab a seat before the coinnibals arrive.',
  photo: { url: 'https://pbs.twimg.com/media/Gabc123.jpg', width: 1200, height: 675 },
  at: Date.UTC(2026, 10, 20, 12),
};

function serve(open: boolean, claim?: (call: Call) => unknown, extra: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
  const m = mockFetch({ 'GET /api/site/settings': { settings: { ...SETTINGS, appetizerOpen: open, ...settings } }, ...(claim ? { 'POST /api/appetizer': claim } : {}), ...extra });
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
const serveButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: /Serve my early card/ }) as HTMLButtonElement;
/** Clicks "Follow @coinnibalfun" (a new tab on X: nothing to follow here). */
const follow = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByTestId('ap-follow'));
/** The order form, followed and filled. */
async function ordered(dialog: HTMLElement, handle = 'Satoshi_Nibbles') {
  follow(dialog);
  await waitFor(() => expect(serveButton(dialog).disabled).toBe(false));
  fill(dialog, WALLET, handle);
}

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
    expect(slip.textContent).toContain('Now serving');
    expect(slip.textContent).toContain('Early cards are out');
    expect(slip.textContent).toContain('Claim yours');
    expect(slip.closest('#appetizer')).toBeTruthy();
    expect(slip.closest('.ld-hero')).toBeTruthy();
  });

  it('says plainly it is an early card and not a WL spot', async () => {
    serve(true);
    const dialog = await openSheet();
    expect(within(dialog).getByTestId('ap-lede').textContent).toBe('An early card for early fans. Not a WL spot.');
    expect(dialog.textContent).toContain('Early card');
  });

  it('needs the follow first: the serve button stays locked until "Follow" was clicked, and remembers it', async () => {
    serve(true, () => ({ card: CARD, existing: false }));
    const dialog = await openSheet();
    // no post set (appetizerPostUrl null): no like step
    expect(within(dialog).queryByTestId('ap-like')).toBeNull();
    const link = within(dialog).getByTestId('ap-follow');
    expect(link.textContent).toContain('Follow @coinnibalfun');
    expect(link.getAttribute('href')).toBe('https://x.com/intent/follow?screen_name=coinnibalfun');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(within(dialog).getByText('Required: no follow, no card.')).toBeTruthy();
    expect(serveButton(dialog).disabled).toBe(true);
    expect(within(dialog).getByTestId('ap-locked').textContent).toBe('Follow @coinnibalfun first: the card needs it.');
    follow(dialog);
    await waitFor(() => expect(serveButton(dialog).disabled).toBe(false));
    expect(within(dialog).queryByTestId('ap-locked')).toBeNull();
    expect(within(dialog).getByTestId('ap-step-follow').className).toContain('is-done');
    // kept in the same entry as the card: a reload keeps the step done
    expect(JSON.parse(localStorage.getItem(storageKey('appetizer.v1'))!)).toEqual({ followed: true });
    resetSteps();
    expect(readStep('followed')).toBe(true);
    expect(followIntent('@someone')).toBe('https://x.com/intent/follow?screen_name=someone');
  });

  it('with our post set (appetizerPostUrl): like and comment is step 2, also required, and sent along', async () => {
    const m = serve(true, () => ({ card: CARD, existing: false }), {}, { appetizerPostUrl: OUR_POST, launchPostUrl: 'https://x.com/coinnibalfun/status/1' });
    const dialog = await openSheet();
    const like = within(dialog).getByTestId('ap-like');
    // X's own like dialog and reply composer for our post
    expect(like.getAttribute('href')).toBe('https://x.com/intent/like?tweet_id=2123416055406354866');
    expect(within(dialog).getByTestId('ap-reply').getAttribute('href')).toBe('https://x.com/intent/tweet?in_reply_to=2123416055406354866');
    expect(within(dialog).getByText('Like and comment on our post')).toBeTruthy();
    follow(dialog);
    await waitFor(() => expect(within(dialog).getByTestId('ap-step-follow').className).toContain('is-done'));
    expect(serveButton(dialog).disabled).toBe(true);
    expect(within(dialog).getByTestId('ap-locked').textContent).toBe('Do steps 1 and 2 first: the card needs them.');
    fireEvent.click(like);
    await waitFor(() => expect(serveButton(dialog).disabled).toBe(false));
    fill(dialog, WALLET, 'Satoshi_Nibbles');
    fireEvent.click(serveButton(dialog));
    expect(await within(dialog).findByTestId('ap-share-link')).toBeTruthy();
    expect(m.calls.find((c) => c.method === 'POST' && c.path === '/api/appetizer')?.body).toEqual({ wallet: WALLET, handle: 'Satoshi_Nibbles', followed: true, liked: true });
  });

  it('shows our post inside step 2 on narrower screens: read once the sheet opens, the box opens it on X and counts', async () => {
    const m = serve(true, () => ({ card: CARD, existing: false }), { 'GET /api/appetizer/post': { post: OUR_VIEW } }, { appetizerPostUrl: OUR_POST });
    render(<Landing />);
    await screen.findByTestId('ld-appetizer');
    // the landing alone never asks for it
    await new Promise((r) => setTimeout(r, 50));
    expect(m.calls.some((c) => c.path === '/api/appetizer/post')).toBe(false);
    fireEvent.click(screen.getByTestId('ld-appetizer'));
    const dialog = await screen.findByRole('dialog', undefined, { timeout: 5000 });
    expect(dialog.className).not.toContain('ap-sheet--cols');
    const box = await within(dialog).findByTestId('ap-xpost');
    expect(box.closest('[data-testid="ap-step-like"]')).toBeTruthy();
    expect(box.className).toContain('is-compact');
    await waitFor(() => expect(box.textContent).toContain('The kitchen is open.'));
    expect(box.textContent).toContain('@Coinnibalfun');
    expect(box.getAttribute('href')).toBe(OUR_POST);
    expect(box.getAttribute('target')).toBe('_blank');
    // compact: no picture, the step's own button right under it
    expect(box.querySelector('.ap-xpost__photo')).toBeNull();
    expect(within(dialog).getByTestId('ap-like')).toBeTruthy();
    follow(dialog);
    await waitFor(() => expect(within(dialog).getByTestId('ap-step-follow').className).toContain('is-done'));
    expect(serveButton(dialog).disabled).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(serveButton(dialog).disabled).toBe(false));
    expect(within(dialog).getByTestId('ap-step-like').className).toContain('is-done');
    expect(m.calls.filter((c) => c.path === '/api/appetizer/post')).toHaveLength(1);
  });

  it('on wide screens our post sits beside the checklist (two columns), with its picture and "Like + comment on X"', async () => {
    setMatchingQueries(['(min-width: 960px)']);
    serve(true, undefined, { 'GET /api/appetizer/post': { post: OUR_VIEW } }, { appetizerPostUrl: OUR_POST });
    const dialog = await openSheet();
    expect(dialog.className).toContain('ap-sheet--cols');
    const box = await within(dialog).findByTestId('ap-xpost');
    expect(box.closest('.ap-cols__post')).toBeTruthy();
    expect(box.closest('[data-testid="ap-step-like"]')).toBeNull();
    await waitFor(() => expect(box.querySelector('.ap-xpost__photo')?.getAttribute('src')).toBe(OUR_VIEW.photo.url));
    expect(box.textContent).toContain('Like + comment on X');
    expect(box.textContent).toContain('20 Nov 2026');
    fireEvent.click(box);
    await waitFor(() => expect(within(dialog).getByTestId('ap-step-like').className).toContain('is-done'));
  });

  it('when X cannot show our post the box still links to it; with no post set there is no box and one column', async () => {
    setMatchingQueries(['(min-width: 960px)']);
    serve(true, undefined, { 'GET /api/appetizer/post': { post: null } }, { appetizerPostUrl: OUR_POST });
    const dialog = await openSheet();
    const box = await within(dialog).findByTestId('ap-xpost');
    await waitFor(() => expect(box.textContent).toContain('Open the post on X to like it and leave a comment.'));
    expect(box.getAttribute('href')).toBe(OUR_POST);
    cleanup();
    restore();
    resetSiteSettings();
    resetOurPost();
    const m = serve(true);
    const plain = await openSheet();
    expect(plain.className).not.toContain('ap-sheet--cols');
    expect(within(plain).queryByTestId('ap-xpost')).toBeNull();
    expect(m.calls.some((c) => c.path === '/api/appetizer/post')).toBe(false);
  });

  it('checks the wallet and the handle before ordering', async () => {
    const m = serve(true, () => ({ card: CARD, existing: false }));
    const dialog = await openSheet();
    follow(dialog);
    await waitFor(() => expect(serveButton(dialog).disabled).toBe(false));
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

  it('serves the card: the share link and the buttons, the post step still to do, never the wallet', async () => {
    const m = serve(true, () => ({ card: CARD, existing: false }));
    const dialog = await openSheet();
    await ordered(dialog, '@Satoshi_Nibbles');
    fireEvent.click(serveButton(dialog));
    expect(await within(dialog).findByTestId('ap-share-link')).toBeTruthy();
    const post = m.calls.find((c) => c.method === 'POST' && c.path === '/api/appetizer');
    expect(post?.body).toEqual({ wallet: WALLET, handle: 'Satoshi_Nibbles', followed: true });
    expect(within(dialog).getByTestId('ap-share-link').textContent).toBe(`${location.host}/appetizer/${CARD.code}`);
    expect(within(dialog).getByTestId('ap-served-lede').textContent).toBe(
      'Table for @Satoshi_Nibbles, early card No. 0042. Last step: post it on X and paste the link below. Your card is complete once the link is in.',
    );
    expect(within(dialog).getByText('Served · one step left')).toBeTruthy();
    expect(within(dialog).getByLabelText("Paste your post's link (required)")).toBeTruthy();
    const x = within(dialog).getByTestId('ap-post-x').getAttribute('href') ?? '';
    const text = new URL(x).searchParams.get('text') ?? '';
    expect(text).toBe(`The Appetizer is out \u{1F37D}\u{FE0F} @coinnibalfun\nGrabbed my seat before the coinnibals showed up \u{1FA99}\nhttps://${location.host}/appetizer/${CARD.code}`);
    // post and paste in one place: the key that writes the post sits in the link's own form, the hint under the field
    const form = within(dialog).getByTestId('ap-post-x').closest('form')!;
    expect(form).toBeTruthy();
    expect(within(form).getByLabelText("Paste your post's link (required)")).toBeTruthy();
    expect(within(form).getByText('(Paste the link of the post where you shared your card)')).toBeTruthy();
    expect(within(form).getByRole('button', { name: 'Save link' })).toBeTruthy();
    // never a perk: the post says nothing of the WL, a reward or a chance
    expect(text).not.toMatch(/\bWL\b|whitelist|reward|chance|perk|airdrop/i);
    expect(within(dialog).getByRole('button', { name: /Download card/ })).toBeTruthy();
    // the wallet is nowhere: not in the sheet, the page, the post, the link or the browser's storage
    for (const s of [document.body.innerHTML, x, location.href, JSON.stringify({ ...localStorage })]) {
      expect(s.toLowerCase()).not.toContain(WALLET.toLowerCase());
      expect(s).not.toContain('9EE7');
    }
    expect(readAppetizer()).toEqual(CARD);
    // the slip now names the visitor's card and the step left
    await waitFor(() => expect(screen.getByTestId('ld-appetizer').textContent).toContain('Your early card No. 0042'));
    expect(screen.getByTestId('ld-appetizer').textContent).toContain('Post it to finish');
  });

  it('records the post link (required) and completes the card', async () => {
    const m = serve(true, () => ({ card: CARD, existing: false }), { [`POST /api/appetizer/${CARD.code}/post`]: { ok: true, verified: true } });
    const dialog = await openSheet();
    await ordered(dialog);
    fireEvent.click(serveButton(dialog));
    const link = await within(dialog).findByLabelText(/Paste your post's link/);
    fireEvent.change(link, { target: { value: 'not a link' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save link' }));
    expect(await within(dialog).findByText('That is not a link to an X post.')).toBeTruthy();
    fireEvent.change(link, { target: { value: 'https://x.com/Satoshi_Nibbles/status/1234567890' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save link' }));
    expect(await within(dialog).findByText('Complete! Your early card is posted. Enjoy your Appetizer!')).toBeTruthy();
    expect(within(dialog).getByText('Complete')).toBeTruthy();
    expect(m.calls.find((c) => c.path === `/api/appetizer/${CARD.code}/post`)?.body).toEqual({ url: 'https://x.com/Satoshi_Nibbles/status/1234567890' });
    expect(readAppetizer()?.posted).toBe(true);
    await waitFor(() => expect(screen.getByTestId('ld-appetizer').textContent).toContain('See your card'));
  });

  it.each([
    ['post_unverified', 422, { error: 'post_unverified', message: 'x' }, 'Your card is not in that post. Post it with "Post on X" (keep the link in it), then paste that post\'s link.'],
    ['bad_post', 400, { error: 'bad_post', message: 'x' }, 'That post was not found under @Satoshi_Nibbles. Paste the link to your own post.'],
    ['unchecked', 200, { ok: true, verified: false }, 'Saved! X did not answer just now, so the kitchen will check your post by hand.'],
  ] as const)('says how the post link went: %s', async (_name, status, body, message) => {
    serve(true, () => ({ card: CARD, existing: false }), { [`POST /api/appetizer/${CARD.code}/post`]: () => json(status, body) });
    const dialog = await openSheet();
    await ordered(dialog);
    fireEvent.click(serveButton(dialog));
    fireEvent.change(await within(dialog).findByLabelText(/Paste your post's link/), { target: { value: 'https://x.com/Satoshi_Nibbles/status/1234567890' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save link' }));
    expect(await within(dialog).findByText(message)).toBeTruthy();
    expect(!!readAppetizer()?.posted).toBe(status === 200);
  });

  it.each([
    ['closed', 403, 'The kitchen is closed for now. Follow @coinnibalfun to hear when it opens again.'],
    ['follow_required', 400, 'Follow @coinnibalfun first: the card needs it.'],
    ['bad_wallet', 400, 'That is not a wallet address. It starts with 0x, then 40 letters and numbers.'],
    ['bad_handle', 400, 'That is not an X handle. Use 1 to 15 letters, numbers or underscores.'],
    ['handle_taken', 409, 'This handle already has an early card.'],
    ['wallet_taken', 409, 'This wallet already has its early card, under another handle.'],
    ['rate_limited', 429, 'Too many orders from here. Wait a little and try again.'],
    ['network', 0, 'Cannot reach the kitchen right now. Check your connection and try again.'],
  ] as const)('says what went wrong: %s', async (code, status, message) => {
    serve(true, () => {
      if (code === 'network') throw new TypeError('Failed to fetch');
      return json(status, { error: code, message: 'server words', ...(code === 'wallet_taken' ? { field: 'wallet' } : {}) });
    });
    const dialog = await openSheet();
    await ordered(dialog);
    fireEvent.click(serveButton(dialog));
    expect(await within(dialog).findByText(message)).toBeTruthy();
    expect(within(dialog).queryByTestId('ap-share-link')).toBeNull();
    expect(readAppetizer()).toBeNull();
    if (code === 'closed') expect(serveButton(dialog).disabled).toBe(true);
  });

  it('a returning visitor sees their card again, and #appetizer opens it', async () => {
    saveAppetizer({ ...CARD, posted: true });
    expect(localStorage.getItem(storageKey('appetizer.v1'))).not.toContain('wallet');
    history.replaceState(null, '', '/#appetizer');
    serve(true);
    render(<Landing />);
    const dialog = await screen.findByRole('dialog', undefined, { timeout: 5000 });
    expect(within(dialog).getByRole('heading', { name: 'Your early card' })).toBeTruthy();
    expect(within(dialog).getByTestId('ap-share-link').textContent).toContain(`/appetizer/${CARD.code}`);
    expect(within(dialog).getByText('Complete! Your early card is posted. Enjoy your Appetizer!')).toBeTruthy();
    expect(screen.getByTestId('ld-appetizer').textContent).toContain('Your early card No. 0042');
    // forgetting it brings the order form back, the follow still done
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /Clear it from this browser/ })));
    expect(readAppetizer()).toBeNull();
    expect(within(dialog).getByLabelText('Wallet address')).toBeTruthy();
    expect(serveButton(dialog).disabled).toBe(false);
  });
});
