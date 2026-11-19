import { FEEDBACK_LIMITS, type FeedbackRequest, type FeedbackRoom, type RoomInfo } from '@coinnibal/shared';
import { APP_VERSION, SERVER } from '../../config';
import { serverText, t } from '../../i18n';
import type { Screen } from '../../store';

/** The kind of room the player is in (none in the lobby): what the admin reads next to the message. */
export function feedbackRoom(screen: Screen, room: RoomInfo | null): FeedbackRoom | null {
  if (screen === 'lobby' || !room) return null;
  if (room.mode === 'practice') return 'practice';
  if (room.mode === 'private') return room.custom ? 'custom' : 'private';
  return room.test ? 'test' : 'arena';
}

/**
 * What the sheet adds to a message by itself (pure, tested): the page path, the room kind when in a game, the viewport
 * and the app build. The signed-in wallet is not here: the server takes it from the session.
 */
export function feedbackContext(
  game: { screen: Screen; room: RoomInfo | null },
  win: { pathname: string; width: number; height: number },
): Required<Pick<FeedbackRequest, 'page' | 'room' | 'viewport' | 'build'>> {
  const px = (n: number) => Math.max(0, Math.min(99_999, Math.round(n)));
  return {
    page: win.pathname.startsWith('/') ? win.pathname.slice(0, FEEDBACK_LIMITS.page) : '/',
    room: feedbackRoom(game.screen, game.room),
    viewport: `${px(win.width)}x${px(win.height)}`,
    build: APP_VERSION,
  };
}

/** A refused or failed send: the reader's sentence. */
export class FeedbackError extends Error {}

/** `POST /api/feedback` (with the session when there is one: the server names the wallet). */
export async function sendFeedback(body: FeedbackRequest, token: string | null): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${SERVER.http}/api/feedback`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new FeedbackError(t('api.network'));
  }
  if (res.ok) return;
  const data = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
  const fallback = res.status === 429 ? t('api.rate_limited') : res.status >= 500 ? t('api.down') : t('api.wrong');
  throw new FeedbackError(serverText(typeof data.message === 'string' ? data.message : undefined, fallback));
}
