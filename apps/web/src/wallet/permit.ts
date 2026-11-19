import type { JoinPermit, JoinPermitError } from '@coinnibal/shared';
import { SERVER } from '../config';
import { serverText, t } from '../i18n';

/**
 * The game server's permit for one arena ticket (CoinnibalArena v4: `join` needs it). Asked right before the wallet
 * opens: the server refuses a closed game, a closed room, an open ticket there, a wallet whose tickets keep going back
 * unplayed, a network with its share of the room's tickets not played yet, and a room full of tickets waiting for a
 * seat, and says why.
 */
export type PermitResult = { ok: true; permit: JoinPermit } | { ok: false; code: JoinPermitError | 'network'; text: string };

/** The ticket sheet's text for each refusal (`tf.err.permit.*`); `no_show` names when tickets open again. */
export function permitRefusalText(code: JoinPermitError | 'network', retryAt?: number, fallback?: string): string {
  switch (code) {
    case 'no_show': {
      const at = retryAt ? new Date(retryAt) : null;
      const time = at ? at.toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null;
      return time ? t('tf.err.permit.no_show', { time }) : t('tf.err.permit.no_show_soon');
    }
    case 'game_closed':
    case 'banned':
    case 'arenas_off':
    case 'arena_closed':
    case 'session_open':
    case 'network_busy':
    case 'arena_busy':
    case 'no_funds':
    case 'ticket_elsewhere':
    case 'rate_limited':
    case 'chain_busy':
    case 'unauthorized':
      return t(`tf.err.permit.${code}` as 'tf.err.permit.game_closed');
    default:
      return fallback ?? t('tf.err.permit.failed');
  }
}

/**
 * `POST /api/arena/permit {arenaId, room?}` with the session token. `room`: the paid custom room this ticket is for (the
 * server checks it still takes seats, and a refund if it stops before the seat is then no "unplayed ticket").
 */
export async function fetchJoinPermit(token: string, arenaId: number, room: string | null = null): Promise<PermitResult> {
  let res: Response;
  try {
    res = await fetch(`${SERVER.http}/api/arena/permit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(room ? { arenaId, room } : { arenaId }),
    });
  } catch {
    return { ok: false, code: 'network', text: t('tf.err.permit.failed') };
  }
  const body = (await res.json().catch(() => null)) as { permit?: JoinPermit; error?: JoinPermitError; message?: string; retryAt?: number } | null;
  if (res.ok && body?.permit) return { ok: true, permit: body.permit };
  const code: JoinPermitError = body?.error ?? (res.status === 401 ? 'unauthorized' : res.status === 429 ? 'rate_limited' : 'bad_request');
  return { ok: false, code, text: permitRefusalText(code, body?.retryAt, serverText(body?.message, t('tf.err.permit.failed'))) };
}

/**
 * The permit names exactly this purchase: the pinned arena on the server's chain, this wallet and this room (its
 * deadline is the contract's to check: this browser's clock may be off). Anything else: nothing is signed. Pure:
 * unit-tested.
 */
export function permitFits(p: JoinPermit, o: { arena: string; chainId: number; player: string; arenaId: number }): boolean {
  return (
    p.arena.toLowerCase() === o.arena.toLowerCase() &&
    p.chainId === o.chainId &&
    p.player.toLowerCase() === o.player.toLowerCase() &&
    p.arenaId === o.arenaId &&
    Number.isSafeInteger(p.deadline) &&
    p.deadline > 0 &&
    /^0x[0-9a-fA-F]{130}$/.test(p.signature)
  );
}
