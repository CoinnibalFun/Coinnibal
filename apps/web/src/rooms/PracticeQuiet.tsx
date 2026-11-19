import { PRACTICE_ROOM } from '@coinnibal/shared';
import { useState } from 'react';
import { Button, Icon } from '../design';
import { engine } from '../game/instance';
import { useT } from '../i18n';
import { toast, useUi } from '../store';
import { roomsApi } from './api';
import './rooms.css';

/** The ponds count as quiet below this many people (the player alone, or nobody). */
export const QUIET_BELOW = 2;

/**
 * "Practice with bots": asks the server for a free practice room of this player's own (guests too; the same room
 * again while it lasts) and drops the player into it. A refusal (all busy, too many lately, closed) is a toast.
 */
export async function practiceWithBots(): Promise<void> {
  const room = await roomsApi.practice(useUi.getState().auth?.token ?? null);
  engine()?.play(`private:${room.code}`);
}

/**
 * The honest empty state of the people-only ponds: "Quiet right now", why, and one click to a free room with practice
 * bots. `hud`: a slim one-line chip in a pond the player has to themselves ("You are alone in this pond · Practice
 * with bots · Hide"; the explanation stays in the lobby's card); else the lobby card.
 */
export function PracticeQuiet({ hud = false }: { hud?: boolean }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const go = async () => {
    setBusy(true);
    try {
      await practiceWithBots();
    } catch (e) {
      toast('warn', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (hud)
    return (
      <div className="pq pq--hud" role="note" data-testid="practice-quiet-hud">
        <p className="pq__title">{t('pr.alone')}</p>
        <button type="button" className="pq__go" onClick={() => void go()} disabled={busy} data-testid="practice-bots">
          <Icon name="users" size={14} />
          {busy ? t('pr.opening') : t('pr.bots')}
        </button>
        <button type="button" className="pq__hide mono" onClick={() => setHidden(true)} title={t('pr.dismiss')}>
          <span className="pq__hide-word">{t('pr.dismiss')}</span>
          <Icon name="close" size={14} className="pq__hide-x" />
        </button>
      </div>
    );
  return (
    <div className="pq" role="note" data-testid="practice-quiet">
      <p className="pq__title">{t('pr.quietTitle')}</p>
      <p className="pq__body">{t('pr.quietBody')}</p>
      <div className="pq__actions">
        <Button variant="secondary" size="md" icon="users" onClick={() => void go()} disabled={busy} sub={t('pr.botsSub', { min: PRACTICE_ROOM.durationMin, n: PRACTICE_ROOM.maxPlayers - 1 })} data-testid="practice-bots">
          {busy ? t('pr.opening') : t('pr.bots')}
        </Button>
      </div>
    </div>
  );
}
