import { paidRoomTarget, testArenaTarget, type CustomRoomView } from '@coinnibal/shared';
import { engine } from '../game/instance';
import { t } from '../i18n';
import { toast, useUi } from '../store';
import { RoomApiError, roomsApi } from './api';

/**
 * A paid custom room is an invite-only instance of an on-chain arena: it is entered with a normal
 * ticket of that arena. Opening its invite remembers the seat (`paidSeat`) and sends the lobby to
 * that arena's ticket (its confirm sheet opens when a ticket is to be bought); the ticket then joins
 * with `arena:<id>:<CODE>` (`arenaTarget`). A free room is joined straight away.
 */
export function seatInPaidRoom(view: Pick<CustomRoomView, 'code' | 'name' | 'endsAt' | 'arenaId'>): void {
  if (!view.arenaId) return;
  useUi.setState({
    paidSeat: { code: view.code, arenaId: view.arenaId, name: view.name, endsAt: view.endsAt },
    lobbyIntent: { ticket: `arena:${view.arenaId}`, open: true, at: Date.now() },
  });
}

/** Lets go of the paid room's seat: tickets of its arena play in the public arena again. */
export function leavePaidSeat(): void {
  useUi.setState({ paidSeat: null });
}

/** The code of the paid room a ticket of `arenaId` is headed for (`paidSeat`), else null. */
export function paidSeatCode(arenaId: number, now = Date.now()): string | null {
  const seat = useUi.getState().paidSeat;
  return seat && seat.arenaId === arenaId && seat.endsAt > now ? seat.code : null;
}

/**
 * The join target of a ticket of `arenaId`: the paid room this player is headed for, else the arena's test arena
 * when the player picked it (`testSeat`, testnet only), else the arena (quick play: an official instance).
 */
export function arenaTarget(arenaId: number, now = Date.now()): string {
  const code = paidSeatCode(arenaId, now);
  if (code) return paidRoomTarget(arenaId, code);
  if (useUi.getState().testSeat === arenaId) return testArenaTarget(arenaId);
  return `arena:${arenaId}`;
}

/**
 * Opens a room by its invite code: a paid room goes to its arena's ticket (above), anything else is
 * joined as a private room (the server answers for a code it does not know, or a closed room).
 */
export async function openInvite(code: string): Promise<void> {
  let view: CustomRoomView | null = null;
  try {
    view = await roomsApi.get(code);
  } catch (err) {
    // not a custom room (a plain private room has no view), or the API is unreachable: the socket decides
    if (!(err instanceof RoomApiError)) throw err;
  }
  if (view?.kind === 'paid' && view.arenaId) {
    // a closing room takes no new seat: never send anyone to buy a ticket for it
    if (view.closing || view.endsAt <= Date.now()) {
      toast('info', t('err.room_closed'), undefined, 8000);
      return;
    }
    seatInPaidRoom(view);
    return;
  }
  engine()?.play(`private:${code}`);
}
