import { drawAppetizerCard, type AppetizerCardArt, type AppetizerFonts } from '@coinnibal/art';
import { APPETIZER_IMAGE, appetizerPath, isEvmAddress, isXStatusUrl, normalizeXHandle, type AppetizerCard } from '@coinnibal/shared';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Field, Icon, Sheet, useReducedMotion } from '../../design';
import { loadLatinFaces } from '../../design/fonts/faces';
import { useT } from '../../i18n';
import { SiteApiError, saveBlob, site } from '../api';
import { XIcon } from '../Shell';
import { siteHost, xIntent } from '../settings';
import { saveAppetizer, saveStep, useAppetizerStep, useStoredAppetizer, type StoredAppetizer } from './stored';
import './appetizer.css';

/** The site's faces, as the browser names them (the server registers its own: `AppetizerFonts`). */
const FONTS: AppetizerFonts = {
  display: "'Fraunces Variable', 'Fraunces', Georgia, serif",
  body: "'DM Sans Variable', 'DM Sans', system-ui, sans-serif",
  mono: "'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace",
};

let fontsReady: Promise<void> | null = null;
/** Waits for the card's faces once (so the first drawing is not in a stand-in face). */
function cardFonts(): Promise<void> {
  fontsReady ??= loadLatinFaces([
    ['Fraunces Variable', 'normal'],
    ['Geist Mono Variable', 'normal'],
  ]).catch(() => undefined);
  return fontsReady;
}

/** The handle as typed (case kept, a leading `@` or a profile link dropped), or null when it is not an X handle. */
export function typedHandle(s: string): string | null {
  if (!normalizeXHandle(s)) return null;
  let h = s.trim();
  const m = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#]+)/i.exec(h);
  if (m) h = m[1];
  return h.replace(/^@/, '');
}

/** The card's share page, the link that goes in the post (X shows the card picture from its tags). */
export const shareLink = (code: string): string => `https://${siteHost()}${appetizerPath(code)}`;

const art = (card: Pick<AppetizerCard, 'no' | 'handle' | 'at'>): AppetizerCardArt => ({ no: card.no, handle: card.handle, at: card.at, host: siteHost() });

function draw(canvas: HTMLCanvasElement, card: AppetizerCardArt, stamp?: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (canvas.width !== APPETIZER_IMAGE.width) canvas.width = APPETIZER_IMAGE.width;
  if (canvas.height !== APPETIZER_IMAGE.height) canvas.height = APPETIZER_IMAGE.height;
  drawAppetizerCard(ctx, card, FONTS, stamp === undefined ? {} : { stamp });
}

/**
 * The card on a canvas, redrawn when it changes and again once the fonts are in. `serve`: the reveal plays (the cloche
 * lifts off the plate, then the SERVED stamp comes down and thumps); reduced motion draws the finished card at once.
 */
function CardCanvas({ card, label, serve = false }: { card: AppetizerCardArt; label: string; serve?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const [fonts, setFonts] = useState(0);
  const [phase, setPhase] = useState<'still' | 'lift' | 'done'>(serve && !reduced ? 'lift' : 'still');
  const playing = phase === 'lift';
  useEffect(() => {
    let live = true;
    void cardFonts().then(() => live && setFonts((n) => n + 1));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    if (!playing) {
      draw(c, card);
      return;
    }
    // the stamp waits under the cloche, then falls from 1.9x and lands at 780 ms
    const t0 = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const t = now - t0;
      const k = Math.min(1, Math.max(0, (t - 560) / 220));
      draw(c, card, t < 560 ? 0 : 1.9 - 0.9 * k * k);
      if (t < 780) raf = requestAnimationFrame(frame);
      else setPhase('done');
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [card.no, card.handle, card.at, card.host, fonts, playing]);
  return (
    <div className={`ap-card${phase === 'lift' ? ' is-serving' : ''}${phase === 'done' ? ' is-served' : ''}`}>
      <canvas ref={ref} className="ap-card__canvas" width={APPETIZER_IMAGE.width} height={APPETIZER_IMAGE.height} role="img" aria-label={label} />
      {phase === 'lift' && (
        <svg className="ap-cloche" viewBox="0 0 200 120" aria-hidden="true">
          <path className="ap-cloche__dome" d="M14 104 C 14 44, 186 44, 186 104 Z" />
          <path className="ap-cloche__shine" d="M44 84 C 48 64, 64 54, 82 50" />
          <rect className="ap-cloche__knob" x="90" y="32" width="20" height="16" rx="7" />
          <rect className="ap-cloche__rim" x="4" y="102" width="192" height="12" rx="6" />
        </svg>
      )}
    </div>
  );
}

type Errors = { wallet?: string; handle?: string; form?: string };

/** `https://x.com/intent/follow?screen_name=<handle>`: X's follow button for the project's account. */
export const followIntent = (xHandle: string): string => `https://x.com/intent/follow?screen_name=${encodeURIComponent(xHandle.replace(/^@/, ''))}`;

/**
 * The Appetizer sheet (lazy, from AppetizerSlip): a short checklist. 1 follow the project on X, 2 like and comment on
 * our X post (`SiteSettings.appetizerPostUrl`; hidden while it is null), 3 wallet and handle (the card drawn live as the handle is
 * typed), then the served card and 4 its post on X with the post's link (required: the card is complete once the link
 * is in). The follow and the like are on trust (no X API): their buttons must have been clicked, which this browser
 * remembers.
 */
export default function AppetizerSheet({ open, onClose, xHandle, postUrl }: { open: boolean; onClose: () => void; xHandle: string; postUrl: string | null }) {
  const t = useT();
  const kept = useStoredAppetizer();
  // the card of this visit (kept even where the browser cannot store it), else the one this browser keeps
  const [claimed, setClaimed] = useState<{ card: StoredAppetizer; existing: boolean; fresh: boolean } | null>(null);
  const card = claimed?.card ?? kept;
  const ourX = `@${xHandle.replace(/^@/, '')}`;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      className="ap-sheet"
      kicker={card ? (card.posted ? t('ld.ap.completeKicker') : t('ld.ap.servedKicker')) : t('ld.ap.kicker')}
      title={card ? t('ld.ap.servedTitle') : t('ld.ap.title')}
      closeLabel={t('ld.ap.close')}
    >
      {card ? (
        <Served
          card={card}
          fresh={!!claimed?.fresh}
          existing={!!claimed?.existing}
          ourX={ourX}
          step={postUrl ? 4 : 3}
          onPosted={(c) => setClaimed({ card: c, existing: false, fresh: false })}
          onForget={() => {
            saveAppetizer(null);
            setClaimed(null);
          }}
        />
      ) : (
        <Order
          ourX={ourX}
          xHandle={xHandle}
          postUrl={postUrl}
          onServed={(c, existing) => {
            saveAppetizer(c);
            setClaimed({ card: c, existing, fresh: true });
          }}
        />
      )}
    </Sheet>
  );
}

/** One numbered step of the checklist: its number (a check once done), its title, its hint and its action. */
function Step({ n, done, title, hint, children, testId }: { n: number; done: boolean; title: string; hint?: string; children?: ReactNode; testId?: string }) {
  const t = useT();
  return (
    <li className={`ap-step${done ? ' is-done' : ''}`} data-testid={testId}>
      <span className="ap-step__n num" aria-hidden="true">
        {done ? <Icon name="check" size={18} /> : n}
      </span>
      <div className="ap-step__body">
        <p className="ap-step__title">
          <span className="kb-sr">{t('ld.ap.stepN', { n })}: </span>
          {title}
          {done && <span className="kb-sr"> ({t('ld.ap.done')})</span>}
        </p>
        {hint && <p className="ap-step__hint">{hint}</p>}
        {children}
      </div>
    </li>
  );
}

/** A step's outbound button (X's follow intent, our X post): a new tab, and the step counts as done. */
function StepLink({ href, done, onOpen, children, testId }: { href: string; done: boolean; onOpen: () => void; children: ReactNode; testId: string }) {
  const t = useT();
  return (
    <div className="ap-step__act">
      <a className={`kb-btn ${done ? 'kb-btn--secondary' : 'kb-btn--teal'} kb-btn--sm`} href={href} target="_blank" rel="noreferrer" onClick={onOpen} data-testid={testId}>
        <XIcon size={16} />
        <span className="kb-btn__label">
          <span className="kb-btn__text">{children}</span>
        </span>
      </a>
      {done && (
        <span className="ap-step__done" role="status">
          <Icon name="check" size={16} /> {t('ld.ap.done')}
        </span>
      )}
    </div>
  );
}

function Order({ ourX, xHandle, postUrl, onServed }: { ourX: string; xHandle: string; postUrl: string | null; onServed: (card: StoredAppetizer, existing: boolean) => void }) {
  const t = useT();
  const formId = useId();
  const followed = useAppetizerStep('followed');
  const liked = useAppetizerStep('liked');
  const [wallet, setWallet] = useState('');
  const [handle, setHandle] = useState('');
  const [touched, setTouched] = useState({ wallet: false, handle: false });
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const typed = typedHandle(handle);
  const likeStep = !!postUrl;
  const ready = followed && (!likeStep || liked);

  const check = (w = wallet, h = handle): Errors => ({
    wallet: !w.trim() ? t('ld.ap.err.walletEmpty') : isEvmAddress(w.trim()) ? undefined : t('ld.ap.err.wallet'),
    handle: !h.trim() ? t('ld.ap.err.handleEmpty') : typedHandle(h) ? undefined : t('ld.ap.err.handle'),
  });
  const shown = (e: Errors): Errors => ({ wallet: touched.wallet ? e.wallet : undefined, handle: touched.handle ? e.handle : undefined });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || closed || !ready) return;
    const found = check();
    setTouched({ wallet: true, handle: true });
    if (found.wallet || found.handle) {
      setErrors(found);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const res = await site.appetizer.claim({ wallet: wallet.trim(), handle: typed!, followed: true, ...(likeStep ? { liked } : {}) });
      onServed({ code: res.card.code, no: res.card.no, handle: res.card.handle, at: res.card.at }, res.existing);
    } catch (err) {
      const code = err instanceof SiteApiError ? String(err.code) : 'network';
      if (code === 'bad_wallet') setErrors({ wallet: t('ld.ap.err.wallet') });
      else if (code === 'wallet_taken') setErrors({ wallet: t('ld.ap.err.walletTaken') });
      else if (code === 'bad_handle') setErrors({ handle: t('ld.ap.err.handle') });
      else if (code === 'handle_taken') setErrors({ handle: t('ld.ap.err.taken') });
      else if (code === 'follow_required') setErrors({ form: t('ld.ap.err.follow', { ourX }) });
      else if (code === 'closed') {
        setClosed(true);
        setErrors({ form: t('ld.ap.err.closed', { ourX }) });
      } else if (code === 'rate_limited') setErrors({ form: t('ld.ap.err.rate') });
      else if (code === 'network') setErrors({ form: t('ld.ap.err.network') });
      else setErrors({ form: t('ld.ap.err.other') });
    } finally {
      setBusy(false);
    }
  };

  // the server's word on a field wins over the live check until that field is edited
  const now = check();
  const live = shown({ wallet: errors.wallet ?? now.wallet, handle: errors.handle ?? now.handle });
  const orderN = likeStep ? 3 : 2;
  return (
    <form id={formId} className="ap-order" onSubmit={(e) => void submit(e)} noValidate>
      <p className="ap-lede ap-lede--early" data-testid="ap-lede">
        {t('ld.ap.lede')}
      </p>
      <p className="ap-howto">{t('ld.ap.howto')}</p>
      <ol className="ap-steps">
        <Step n={1} done={followed} title={t('ld.ap.s.follow', { ourX })} hint={t('ld.ap.s.followHint')} testId="ap-step-follow">
          <StepLink href={followIntent(xHandle)} done={followed} onOpen={() => saveStep('followed')} testId="ap-follow">
            {t('ld.ap.follow', { ourX })}
          </StepLink>
        </Step>
        {likeStep && (
          <Step n={2} done={liked} title={t('ld.ap.s.like')} hint={t('ld.ap.s.likeHint')} testId="ap-step-like">
            <StepLink href={postUrl} done={liked} onOpen={() => saveStep('liked')} testId="ap-like">
              {t('ld.ap.like')}
            </StepLink>
          </Step>
        )}
        <Step n={orderN} done={false} title={t('ld.ap.s.order')}>
          <CardCanvas card={{ no: 0, handle: typed ?? '', at: 0, host: siteHost() }} label={t('ld.ap.previewAria', { handle: `@${typed ?? ''}` })} />
          <div className="ap-fields">
            <Field
              label={t('ld.ap.wallet')}
              hint={t('ld.ap.walletHint')}
              error={live.wallet}
              value={wallet}
              placeholder="0x…"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              maxLength={60}
              className="ap-field ap-field--wallet"
              onChange={(e) => {
                setWallet(e.target.value);
                setErrors((x) => ({ ...x, wallet: undefined, form: closed ? x.form : undefined }));
              }}
              onBlur={() => wallet && setTouched((x) => ({ ...x, wallet: true }))}
            />
            <Field
              label={t('ld.ap.handle')}
              hint={t('ld.ap.handleHint')}
              error={live.handle}
              value={handle}
              prefix="@"
              placeholder="yourhandle"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={100}
              className="ap-field"
              onChange={(e) => {
                // the box already shows the @
                setHandle(e.target.value.replace(/^\s*@/, ''));
                setErrors((x) => ({ ...x, handle: undefined, form: closed ? x.form : undefined }));
              }}
              onBlur={() => handle && setTouched((x) => ({ ...x, handle: true }))}
            />
          </div>
        </Step>
        <Step n={orderN + 1} done={false} title={t('ld.ap.s.post')} />
      </ol>
      {errors.form && (
        <p className="ap-alert" role="alert">
          <Icon name="info" size={16} />
          <span>{errors.form}</span>
        </p>
      )}
      {/* held at the foot of the sheet while the form scrolls under it */}
      <div className="ap-serve-bar">
        {!ready && !closed && (
          <p className="ap-locked" data-testid="ap-locked">
            <Icon name="lock" size={16} />
            <span>{likeStep ? t('ld.ap.locked2') : t('ld.ap.locked1', { ourX })}</span>
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" icon="arrow" block loading={busy} disabled={closed || !ready} data-testid="ap-serve">
          {t('ld.ap.serve')}
        </Button>
      </div>
    </form>
  );
}

function Served({
  card,
  fresh,
  existing,
  ourX,
  step,
  onPosted,
  onForget,
}: {
  card: StoredAppetizer;
  fresh: boolean;
  existing: boolean;
  ourX: string;
  /** The post step's number in the checklist. */
  step: number;
  onPosted: (card: StoredAppetizer) => void;
  onForget: () => void;
}) {
  const t = useT();
  const no = String(card.no).padStart(4, '0');
  const handle = `@${card.handle}`;
  const link = shareLink(card.code);
  const postText = `${t('ld.ap.postText', { ourX, no })}\n${link}`;
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // this visit's answer: X showed the post (true), or did not answer and the link was kept unchecked (false)
  const [verified, setVerified] = useState<boolean | null>(null);
  const download = () => {
    const c = document.createElement('canvas');
    draw(c, art(card));
    try {
      c.toBlob((b) => b && saveBlob(b, `coinnibal-early-card-${no}.png`), 'image/png');
    } catch {
      /* a tainted or unsupported canvas: nothing to save */
    }
  };
  const sendLink = async (e: FormEvent) => {
    e.preventDefault();
    const u = url.trim();
    if (!isXStatusUrl(u)) {
      setError(t('ld.ap.err.link'));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const r = await site.appetizer.post(card.code, u);
      setVerified(r.verified !== false);
      const next = { ...card, posted: true };
      saveAppetizer(next);
      onPosted(next);
    } catch (err) {
      const code = err instanceof SiteApiError ? String(err.code) : 'network';
      setError(
        code === 'bad_post'
          ? t('ld.ap.err.linkPost', { handle })
          : code === 'post_unverified'
            ? t('ld.ap.err.linkUnverified')
            : code === 'rate_limited'
              ? t('ld.ap.err.rate')
              : code === 'network'
                ? t('ld.ap.err.network')
                : code === 'closed'
                  ? t('ld.ap.err.closed', { ourX })
                  : t('ld.ap.err.other'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ap-served">
      <CardCanvas card={art(card)} serve={fresh} label={t('ld.ap.cardAria', { handle, no })} />
      <p className="ap-lede" data-testid="ap-served-lede">
        {card.posted ? t('ld.ap.completeLede', { handle, no }) : existing ? t('ld.ap.servedAgain', { no }) : t('ld.ap.servedLede', { handle, no })}
      </p>
      <ol className="ap-steps" start={step}>
        <Step n={step} done={!!card.posted} title={t('ld.ap.s.post')} testId="ap-step-post">
          <div className="ap-share">
            <a className="kb-btn kb-btn--primary kb-btn--md" href={xIntent(postText)} target="_blank" rel="noreferrer" data-testid="ap-post-x">
              <span className="kb-btn__label">
                <span className="kb-btn__text">{t('ld.ap.postX')}</span>
              </span>
              <Icon name="share" size={20} className="kb-btn__icon" />
            </a>
            <Button variant="secondary" icon="download" onClick={download}>
              {t('ld.ap.download')}
            </Button>
          </div>
          <p className="ap-link mono" data-testid="ap-share-link">
            {link.replace(/^https:\/\//, '')}
          </p>
          {card.posted ? (
            <p className="ap-thanks" role="status">
              <Icon name="check" size={18} />
              <span>{verified === false ? t('ld.ap.thanksUnchecked') : t('ld.ap.thanks')}</span>
            </p>
          ) : (
            <form className="ap-post" onSubmit={(e) => void sendLink(e)} noValidate>
              <Field
                label={t('ld.ap.link')}
                hint={t('ld.ap.linkHint', { handle: card.handle })}
                error={error}
                value={url}
                inputMode="url"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="https://x.com/…"
                maxLength={300}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setError(undefined);
                }}
              />
              <Button type="submit" variant="teal" loading={busy} disabled={!url.trim()}>
                {t('ld.ap.linkSave')}
              </Button>
            </form>
          )}
        </Step>
      </ol>
      <button type="button" className="ap-forget" onClick={onForget}>
        {t('ld.ap.forget')}
      </button>
    </div>
  );
}
