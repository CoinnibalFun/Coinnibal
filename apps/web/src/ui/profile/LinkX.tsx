import { xAvatarPath } from '@coinnibal/shared';
import { useEffect, useState } from 'react';
import { Button, Field } from '../../design';
import { sound } from '../../audio';
import { SERVER } from '../../config';
import { useT } from '../../i18n';
import { openModal, toast, updateSettings, useUi } from '../../store';
import { useChainData } from '../../wallet/chain';
import { signInWithWallet } from '../../wallet/signIn';
import { useAddress } from '../../wallet/store';
import { newXCode, unlinkX, useXLinkSync, verifyXPost, wearXPicture } from '../../wallet/xlink';
import { XMark } from '../game/ShareOnX';

/** The section's anchor (the lobby's "Link X" jumps here). */
export const LINK_X_ID = 'pf-x';

/**
 * "Link X": tie an X account to the coin with one post, no X login. 1. get a code, 2. post it on X (the composer opens
 * with the text written), 3. paste the post's link and verify. Linked: the X picture and @handle, "Use my X picture"
 * and Unlink. Linking is consent to be tagged by whoever eats you, and the card says so plainly.
 */
export function LinkXCard() {
  const t = useT();
  const owner = useAddress();
  const token = useUi((s) => (s.auth && owner && s.auth.address.toLowerCase() === owner.toLowerCase() ? s.auth.token : null));
  const x = useXLinkSync(owner, token);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<null | 'code' | 'verify' | 'unlink' | 'picture'>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // the code's minutes left tick down while it is on screen
  useEffect(() => {
    if (!x.code) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [x.code]);

  const run = async (what: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const head = (
    <h3 id="pf-x-h" className="kl-h3">
      <XMark size={18} />
      {t('x.title')}
    </h3>
  );
  const consent = <p className="pf-x__consent">{t('x.consent')}</p>;

  if (!owner || !token) {
    return (
      <section id={LINK_X_ID} className="pf-box pf-x" aria-labelledby="pf-x-h" data-testid="link-x" data-state={owner ? 'verify' : 'guest'}>
        {head}
        <p className="kl-note">{owner ? t('x.verify') : t('x.guest')}</p>
        {owner ? (
          <Button variant="secondary" size="md" lead="key" onClick={() => void signInWithWallet(true)}>
            {t('wl.verify')}
          </Button>
        ) : (
          <Button variant="teal" size="md" lead="wallet" onClick={() => openModal('wallet')}>
            {t('wl.connect')}
          </Button>
        )}
      </section>
    );
  }

  if (x.link) {
    const link = x.link;
    return (
      <section id={LINK_X_ID} className="pf-box pf-x" aria-labelledby="pf-x-h" data-testid="link-x" data-state="linked">
        {head}
        <div className="pf-x__linked">
          {link.avatar && link.userId ? (
            <img className="pf-x__avatar" src={`${SERVER.http}${xAvatarPath(link.userId)}`} alt="" width={56} height={56} draggable={false} />
          ) : (
            <span className="pf-x__avatar pf-x__avatar--none" aria-hidden="true">
              <XMark size={24} />
            </span>
          )}
          <span className="pf-x__who">
            <strong className="pf-x__handle mono">@{link.handle}</strong>
            {link.name && <span className="pf-x__name">{link.name}</span>}
          </span>
        </div>
        {consent}
        {error && (
          <p className="pf-x__error" role="alert">
            {error}
          </p>
        )}
        <span className="pf-x__row">
          {link.avatar && (
            <Button
              variant="secondary"
              size="md"
              lead="user"
              loading={busy === 'picture'}
              disabled={!!busy}
              onClick={() =>
                void run('picture', async () => {
                  const profile = await wearXPicture(token);
                  useChainData.setState({ profile });
                  updateSettings({ picture: true });
                  toast('success', t('x.pictureOn'), undefined, 2500);
                })
              }
            >
              {t('x.picture')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="md"
            loading={busy === 'unlink'}
            disabled={!!busy}
            onClick={() =>
              void run('unlink', async () => {
                await unlinkX(owner, token);
                toast('success', t('x.unlinked'), undefined, 2500);
              })
            }
          >
            {t('x.unlink')}
          </Button>
        </span>
      </section>
    );
  }

  const code = x.code;
  const minutes = code ? Math.max(1, Math.ceil((code.expiresAt - now) / 60_000)) : 0;
  return (
    <section id={LINK_X_ID} className="pf-box pf-x" aria-labelledby="pf-x-h" data-testid="link-x" data-state={code ? 'code' : 'unlinked'}>
      {head}
      <p className="kl-note">{t('x.intro')}</p>
      <ol className="pf-x__steps">
        <li className={code ? 'is-done' : 'is-now'}>
          <span className="pf-x__n mono" aria-hidden="true">
            1
          </span>
          <span className="pf-x__step">
            <strong>{t('x.step1')}</strong>
            {code ? (
              <span className="pf-x__code" data-testid="x-code">
                <span className="mono">{code.code}</span>
                <span className="pf-x__exp mono">{t('x.expires', { min: minutes })}</span>
              </span>
            ) : (
              <Button variant="primary" size="md" loading={busy === 'code'} disabled={!!busy} onClick={() => void run('code', async () => void (await newXCode(owner, token)))}>
                {t('x.getCode')}
              </Button>
            )}
          </span>
        </li>
        <li className={code ? 'is-now' : ''}>
          <span className="pf-x__n mono" aria-hidden="true">
            2
          </span>
          <span className="pf-x__step">
            <strong>{t('x.step2')}</strong>
            {code && (
              <a className="kb-btn kb-btn--secondary kb-btn--md pf-x__post" href={code.intentUrl} target="_blank" rel="noopener noreferrer" onClick={() => sound.click()} data-testid="x-post">
                <span className="kb-btn__label">
                  <span className="kb-btn__text">{t('x.post')}</span>
                </span>
                <XMark size={18} />
              </a>
            )}
          </span>
        </li>
        <li className={code ? 'is-now' : ''}>
          <span className="pf-x__n mono" aria-hidden="true">
            3
          </span>
          <span className="pf-x__step">
            <strong>{t('x.step3')}</strong>
            {code && (
              <form
                className="pf-x__verify"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!url.trim()) return;
                  void run('verify', async () => {
                    const link = await verifyXPost(owner, token, url.trim());
                    setUrl('');
                    toast('success', t('x.linked', { handle: link.handle }), undefined, 3000);
                  });
                }}
              >
                <Field label={t('x.urlLabel')} placeholder="https://x.com/you/status/…" value={url} inputMode="url" autoComplete="off" spellCheck={false} disabled={!!busy} onChange={(e) => setUrl(e.target.value)} />
                <span className="pf-x__row">
                  <Button type="submit" variant="primary" size="md" icon="check" loading={busy === 'verify'} disabled={!!busy || !url.trim()}>
                    {t('x.verifyBtn')}
                  </Button>
                  <Button type="button" variant="ghost" size="md" disabled={!!busy} onClick={() => void run('code', async () => void (await newXCode(owner, token)))}>
                    {t('x.newCode')}
                  </Button>
                </span>
              </form>
            )}
          </span>
        </li>
      </ol>
      {consent}
      {error && (
        <p className="pf-x__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
