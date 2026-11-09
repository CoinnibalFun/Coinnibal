import { ROOM_CLOSE_COUNTDOWN_MS } from '@elymum/shared';
import { useEffect, useState } from 'react';
import { Button, Sheet } from '../../design';
import { engine } from '../../game/instance';
import { serverClock } from '../../game/clock';
import { serverText, useT } from '../../i18n';
import { openModal, useUi } from '../../store';
import { FinalBoard } from './FinalBoard';
import { roomName } from './format';
import { SharePanel } from './SharePanel';
import { EatenNames, gameShareText, resultShareText, useShare } from './ShareOnX';

/** The final board goes back to the lobby by itself after this long (ms), unless a button did first. */
export const ROOM_OVER_AUTO_MS = 30_000;

/**
 * Milliseconds until the custom room on screen closes, while its countdown runs (the last
 * `ROOM_CLOSE_COUNTDOWN_MS`), else null. The server's `closing` names the end (an early close moves it); a room's
 * scheduled end (`RoomInfo.custom.endsAt`) counts down by itself too. Re-renders on each second boundary.
 */
export function useRoomClosing(): number | null {
  const closing = useUi((s) => s.closing);
  const scheduled = useUi((s) => s.room?.custom?.endsAt ?? null);
  const endsAt = closing ? Math.min(closing.endsAt, scheduled ?? Infinity) : scheduled;
  const [now, setNow] = useState(() => serverClock.now());
  useEffect(() => {
    if (endsAt === null) return;
    let id: ReturnType<typeof setTimeout>;
    const step = () => {
      const t = serverClock.now();
      setNow(t);
      const left = endsAt - t;
      // sleep until the countdown starts, then tick on the second boundaries
      id = setTimeout(step, left > ROOM_CLOSE_COUNTDOWN_MS ? Math.min(60_000, left - ROOM_CLOSE_COUNTDOWN_MS) : (left % 1000) + 15);
    };
    step();
    return () => clearTimeout(id);
  }, [endsAt]);
  if (endsAt === null) return null;
  const left = endsAt - now;
  return left <= ROOM_CLOSE_COUNTDOWN_MS && left > -1000 ? Math.max(0, left) : null;
}

/**
 * The custom room's end, ten seconds ahead, for everyone in it (players and spectators): a sticker under the top
 * of the world, "This room closes in 7 s", and the reason (time up, closed by its creator or an admin). The big
 * numerals drop in with the round countdown (`RoundCountdown`). Spoken once by a polite live region.
 */
export function RoomClosingNotice() {
  const t = useT();
  const ms = useRoomClosing();
  const message = useUi((s) => s.closing?.message ?? null);
  const paid = useUi((s) => s.room?.custom?.kind === 'paid');
  if (ms === null) return null;
  const s = Math.max(1, Math.ceil(ms / 1000));
  return (
    <div className="g-closing" role="status" data-testid="room-closing">
      <strong className="g-closing__title">{paid ? t('ro.closingBell', { s }) : t('ro.closing', { s })}</strong>
      {message && <span className="g-closing__why mono">{serverText(message, paid ? t('ro.whyBell') : t('ro.why'))}</span>}
      {/* the whole board, live, before the room closes (its final board follows at the end) */}
      <button type="button" className="g-closing__board mono" onClick={() => openModal('standings')} data-testid="room-closing-board">
        {t('ro.seeBoard')}
      </button>
    </div>
  );
}

/**
 * A free custom room ended: its final board (everyone by mass, the practice bots too, with kills), over the frozen
 * world. "Lobby" goes back at once; otherwise the sheet goes back by itself after `ROOM_OVER_AUTO_MS`, saying so.
 * A ticket room's end is the bell's own receipt (`RoundOverSheet`), with the same board.
 */
export function RoomOverSheet() {
  const t = useT();
  const res = useUi((s) => (s.screen === 'roomover' ? s.roomResult : null));
  const skin = useUi((s) => s.me?.skin ?? s.settings.skin);
  const share = useShare('room');
  const moments = useUi((s) => s.moments);
  const [left, setLeft] = useState(ROOM_OVER_AUTO_MS);
  // the player is sharing (a download, the share sheet, X): the sheet stays until a button takes it away
  const [held, setHeld] = useState(false);
  const open = res !== null;
  useEffect(() => {
    if (!open) setHeld(false);
  }, [open]);
  useEffect(() => {
    if (!open || held) return;
    const until = Date.now() + ROOM_OVER_AUTO_MS;
    setLeft(ROOM_OVER_AUTO_MS);
    const id = setInterval(() => {
      const ms = until - Date.now();
      setLeft(ms);
      if (ms <= 0) {
        clearInterval(id);
        engine()?.backToLobby();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [open, held]);
  const toLobby = () => engine()?.backToLobby();
  return (
    <Sheet
      open={open}
      onClose={toLobby}
      closeLabel={t('gr.close')}
      kicker={t('ro.kicker', { room: roomName(res?.room ?? null) })}
      title={<span className="g-roundover__title">{t('ro.title')}</span>}
      className="g-sheet g-roundover g-roomover has-board"
      footer={
        <>
          <Button variant="primary" size="lg" icon="menu" onClick={toLobby} data-autofocus>
            {t('gr.lobby')}
          </Button>
          {!held && (
            <span className="g-roomover__auto mono" aria-live="off">
              {t('ro.auto', { s: Math.max(0, Math.ceil(left / 1000)) })}
            </span>
          )}
        </>
      }
    >
      {res && (
        <div className="g-roundover__body">
          <p className="g-roundover__note">{serverText(res.message, t('ro.why'))}</p>
          <EatenNames eaten={res.stats?.eaten} more={res.stats?.eatenMore} />
          {/* the room's card and standings pictures once the server sent them (the site's link with no place on the board) */}
          <SharePanel
            card={res.stats?.finalRank ? share : null}
            text={
              res.stats?.finalRank
                ? resultShareText(t, { rank: res.stats.finalRank, n: res.stats.finalOf ?? res.stats.finalRank, room: roomName(res.room), eaten: res.stats.eaten, eatenMore: res.stats.eatenMore })
                : gameShareText(t, { mass: res.stats?.maxMass ?? 0, eaten: res.stats?.playersEaten ?? 0, room: roomName(res.room) })
            }
            room={roomName(res.room)}
            moments={moments}
            onUse={() => setHeld(true)}
          />
          <FinalBoard rows={res.standings} title={t('ro.top', { n: res.players })} skin={skin} />
        </div>
      )}
    </Sheet>
  );
}
