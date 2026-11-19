import { FEEDBACK_LIMITS, shortAddress, type FeedbackEntry, type FeedbackRoom } from '@coinnibal/shared';
import { useCallback, useEffect, useState } from 'react';
import { Button, Chip } from '../../design';
import type { AdminApi } from '../../site/api';
import { Empty, errText, fmtDate, useFlash } from './common';

/** Messages per page of the drawer. */
const PAGE = 50;

const ROOM: Record<FeedbackRoom, string> = { practice: 'practice', private: 'private room', custom: 'custom room', arena: 'arena', test: 'test arena' };

/**
 * The unread count for the drawer's badge (and the panel's first screen): read now, then every minute while the
 * admin session lasts; the drawer reports its own changes at once (`set`). Null until known (no session yet).
 */
export function useFeedbackUnread(api: AdminApi | null): [number | null, (n: number) => void] {
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    if (!api) {
      setUnread(null);
      return;
    }
    let live = true;
    const read = () =>
      api.feedback({ limit: 1 }).then(
        (r) => live && setUnread(r.unread),
        () => {},
      );
    void read();
    const id = setInterval(read, 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [api]);
  return [unread, setUnread];
}

/**
 * Feedback: what players send from the game page (its Feedback button), newest first: the time, the wallet (a guest
 * has none), the page and room, the message and how to reach them. Mark read / unread, or delete. Everything is shown
 * as plain text (never HTML, never a link).
 */
export function FeedbackTab({ api, onUnread }: { api: AdminApi; onUnread?: (n: number) => void }) {
  const [items, setItems] = useState<FeedbackEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  const [only, setOnly] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useFlash();

  const counts = useCallback(
    (n: number) => {
      setUnread(n);
      onUnread?.(n);
    },
    [onUnread],
  );
  const load = useCallback(
    (offset = 0) => {
      api.feedback({ limit: PAGE, offset, unread: only }).then(
        (r) => {
          setItems((old) => (offset > 0 && old ? [...old, ...r.items] : r.items));
          setTotal(r.total);
          setMore(r.items.length === PAGE);
          counts(r.unread);
        },
        (e) => setFlash('err', errText(e)),
      );
    },
    [api, only, counts, setFlash],
  );
  useEffect(() => load(0), [load]);

  const act = async (e: FeedbackEntry, what: 'read' | 'delete') => {
    if (what === 'delete' && !window.confirm('Delete this message? It cannot be brought back.')) return;
    setBusy(e.id);
    try {
      if (what === 'delete') {
        const r = await api.deleteFeedback(e.id);
        setItems((list) => list?.filter((x) => x.id !== e.id) ?? null);
        setTotal((n) => Math.max(0, n - 1));
        counts(r.unread);
      } else {
        const r = await api.setFeedbackRead(e.id, !e.read);
        // the unread view drops a message once it is read
        setItems((list) => (only && r.entry.read ? list?.filter((x) => x.id !== e.id) : list?.map((x) => (x.id === e.id ? r.entry : x))) ?? null);
        counts(r.unread);
      }
    } catch (err) {
      setFlash('err', errText(err));
    } finally {
      setBusy(null);
    }
  };

  const readAll = async () => {
    setBusy('all');
    try {
      counts((await api.readAllFeedback()).unread);
      setFlash('ok', 'Every message is marked read.');
      load(0);
    } catch (err) {
      setFlash('err', errText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="ad-card" aria-labelledby="ad-fb-h" data-testid="admin-feedback">
      <div className="ad-card__bar">
        <h2 className="ad-card__title" id="ad-fb-h">
          Messages
        </h2>
        <span className="ad-note">{items ? `${unread} unread · ${total} kept` : 'Loading…'}</span>
      </div>
      <p className="ad-card__lede">What players send with the Feedback button in the game. Newest first; the newest {FEEDBACK_LIMITS.kept.toLocaleString('en-US')} are kept.</p>
      <div className="ad-fb__tools">
        <Chip selected={!only} onClick={() => setOnly(false)}>
          All
        </Chip>
        <Chip selected={only} onClick={() => setOnly(true)}>
          Unread
        </Chip>
        <Button variant="ghost" size="sm" disabled={unread === 0 || busy !== null} onClick={() => void readAll()} className="ad-fb__all">
          Mark all read
        </Button>
      </div>
      {flash}
      {items && items.length === 0 && (
        <Empty scene="mail" mood="sleepy">
          {only ? 'Nothing unread. You are all caught up.' : 'No messages yet. They arrive here when players press Feedback in the game.'}
        </Empty>
      )}
      {items && items.length > 0 && (
        <ul className="ad-fb">
          {items.map((e) => (
            <li key={e.id} className={`ad-fb__item${e.read ? '' : ' is-unread'}`} data-testid="admin-feedback-item">
              <div className="ad-fb__meta mono">
                {!e.read && <span className="ad-fb__dot" role="img" aria-label="Unread" />}
                <span>{fmtDate(e.at)}</span>
                <span title={e.wallet ?? undefined}>{e.wallet ? shortAddress(e.wallet, 6, 4) : 'guest'}</span>
                {e.page && <span>{e.room ? `${e.page} · ${ROOM[e.room]}` : e.page}</span>}
                {e.viewport && <span>{e.viewport}</span>}
                {e.build && <span>v{e.build}</span>}
              </div>
              <p className="ad-fb__text">{e.text}</p>
              {e.contact && (
                <p className="ad-fb__contact">
                  <span className="mono ad-note">Reach them:</span> {e.contact}
                </p>
              )}
              <div className="ad-fb__actions">
                <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void act(e, 'read')}>
                  {e.read ? 'Mark unread' : 'Mark read'}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void act(e, 'delete')}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {more && items && (
        <Button variant="ghost" size="sm" onClick={() => load(items.length)} className="ad-fb__more">
          Show older messages
        </Button>
      )}
    </section>
  );
}
