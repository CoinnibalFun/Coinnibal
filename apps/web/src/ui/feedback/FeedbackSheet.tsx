import { FEEDBACK_LIMITS } from '@coinnibal/shared';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button, Icon, Sheet } from '../../design';
import { useT } from '../../i18n';
import { closeModal, useUi } from '../../store';
import { FeedbackError, feedbackContext, sendFeedback } from './feedback';
import './feedback.css';

type Phase = { kind: 'edit' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'failed'; why: string };

/**
 * "Feedback" (modal `feedback`): a message to the team from the lobby's masthead, the in-game top bar or the settings
 * sheet. The message is required, a way to reach the player is optional; the page, the room kind, the screen size and
 * the app build ride along by themselves (the server takes the wallet from the session). Guests can send too.
 */
export function FeedbackSheet() {
  const t = useT();
  const open = useUi((s) => s.modal === 'feedback');
  const signedIn = useUi((s) => !!s.auth);
  const [text, setText] = useState('');
  const [contact, setContact] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
  const id = useId();
  // a fresh sheet after a sent message (a failed one keeps its text to try again)
  useEffect(() => {
    if (!open && phase.kind === 'sent') {
      setText('');
      setContact('');
      setPhase({ kind: 'edit' });
    }
  }, [open, phase.kind]);

  const ready = text.trim().length > 0 && phase.kind !== 'sending';
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    setPhase({ kind: 'sending' });
    const s = useUi.getState();
    const ctx = feedbackContext({ screen: s.screen, room: s.room }, { pathname: location.pathname, width: innerWidth, height: innerHeight });
    try {
      await sendFeedback({ text: text.trim(), contact: contact.trim(), ...ctx }, s.auth?.token ?? null);
      setPhase({ kind: 'sent' });
    } catch (err) {
      setPhase({ kind: 'failed', why: err instanceof FeedbackError ? err.message : t('api.wrong') });
    }
  };

  const sent = phase.kind === 'sent';
  const footer = sent ? (
    <>
      <Button variant="primary" onClick={closeModal} data-autofocus>
        {t('fb.close')}
      </Button>
      <Button variant="ghost" onClick={() => (setText(''), setContact(''), setPhase({ kind: 'edit' }))}>
        {t('fb.another')}
      </Button>
    </>
  ) : (
    <Button variant="primary" type="submit" form={`${id}-form`} disabled={!ready} loading={phase.kind === 'sending'} icon="arrow" data-testid="fb-send">
      {phase.kind === 'sending' ? t('fb.sending') : t('fb.send')}
    </Button>
  );

  return (
    <Sheet open={open} onClose={closeModal} closeLabel={t('fb.close')} kicker={t('fb.kicker')} title={t('fb.title')} className="g-sheet fb-sheet" footer={footer}>
      {sent ? (
        <div className="fb-thanks" role="status" data-testid="fb-thanks">
          <Icon name="check" size={28} className="fb-thanks__icon" />
          <p>{t('fb.thanks')}</p>
        </div>
      ) : (
        <form id={`${id}-form`} className="fb-form" onSubmit={(e) => void submit(e)} data-testid="fb-form" noValidate>
          <p className="fb-lede">{t('fb.lede')}</p>
          <div className="kb-field fb-field">
            <div className="fb-field__head">
              <label className="kb-field__label mono" htmlFor={`${id}-text`}>
                {t('fb.text')}
              </label>
              <span className="fb-count mono num" aria-hidden="true">
                {t('fb.count', { n: text.length.toLocaleString('en-US'), max: FEEDBACK_LIMITS.text.toLocaleString('en-US') })}
              </span>
            </div>
            <div className="kb-field__box fb-field__box">
              <textarea
                id={`${id}-text`}
                className="kb-field__input fb-text"
                value={text}
                required
                rows={5}
                maxLength={FEEDBACK_LIMITS.text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  // Ctrl / Cmd + Enter sends; a plain Enter is a new line (the game's keys stay off in a text box)
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
                }}
                data-autofocus
                data-testid="fb-text"
              />
            </div>
          </div>
          <div className="kb-field fb-field">
            <label className="kb-field__label mono" htmlFor={`${id}-contact`}>
              {t('fb.contact')}
            </label>
            <div className="kb-field__box">
              <input
                id={`${id}-contact`}
                className="kb-field__input fb-contact"
                value={contact}
                maxLength={FEEDBACK_LIMITS.contact}
                placeholder={t('fb.contactPlaceholder')}
                autoComplete="off"
                onChange={(e) => setContact(e.target.value)}
                data-testid="fb-contact"
              />
            </div>
          </div>
          <p className="fb-context">{signedIn ? t('fb.contextWallet') : t('fb.context')}</p>
          {phase.kind === 'failed' && (
            <p className="fb-error" role="alert" data-testid="fb-error">
              {t('fb.failed', { why: phase.why })}
            </p>
          )}
        </form>
      )}
    </Sheet>
  );
}
