import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A holder perk that one emblem token id grants once per UTC day (to one wallet). */
export type DailyPerk = 'shop' | 'room';

interface TicketClaim {
  session: string;
  wallet: string;
  arenaId: number;
  at: number;
}

interface ClaimsFile {
  v: 1;
  /** Token id → the open holder ticket it serves. */
  tickets: Record<string, TicketClaim>;
  /** UTC day → perk → token id → the wallet that used it that day. */
  daily: Record<string, Partial<Record<DailyPerk, Record<string, string>>>>;
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * One emblem, one holder perk at a time. The emblem can be passed from wallet to wallet in seconds (or flash-borrowed
 * by a contract wallet), and the contract checks `balanceOf` only at `join`. So the server binds every holder perk to
 * a token id, read from the NFT's `Transfer` logs:
 *
 * - an open holder ticket (a holders-only arena, or a ticket with the holder fee rates) holds one token id of its
 *   wallet from its seat until it is settled; a token id serves one open holder ticket at a time;
 * - the holder discount on power-ups and the free daily custom room: one wallet per token id per UTC day.
 *
 * Kept in `DATA_DIR/chains/<id>/emblem-claims.json` (write-to-temp + rename), so a restart keeps the bindings.
 */
export class EmblemClaims {
  private data: ClaimsFile = { v: 1, tickets: {}, daily: {} };

  constructor(
    private readonly file: string | null,
    private readonly log: (m: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  /** The open holder ticket a token id serves (null: free). */
  ticketOf(tokenId: string): TicketClaim | null {
    return this.data.tickets[tokenId] ?? null;
  }

  /**
   * Binds the holder ticket `session` of `wallet` to one of `tokens` (the ids the wallet owns now): the one it already
   * holds, else the first free one. A bound token id is free again only once its ticket is settled (`releaseTicket`):
   * passing the emblem on does not free it while that ticket is open. `{ ok: false, heldBy }` when every id is busy.
   */
  claimTicket(session: string, wallet: string, arenaId: number, tokens: readonly string[]): { ok: true; tokenId: string } | { ok: false; heldBy: TicketClaim[] } {
    const w = wallet.toLowerCase();
    for (const id of tokens) if (this.data.tickets[id]?.session === session) return { ok: true, tokenId: id };
    const heldBy: TicketClaim[] = [];
    for (const id of tokens) {
      const c = this.data.tickets[id];
      if (c) {
        heldBy.push(c);
        continue;
      }
      this.data.tickets[id] = { session, wallet: w, arenaId, at: this.now() };
      this.save();
      return { ok: true, tokenId: id };
    }
    return { ok: false, heldBy };
  }

  /** The ticket was settled (or will never be seated): its token id is free. */
  releaseTicket(session: string): boolean {
    let hit = false;
    for (const [id, c] of Object.entries(this.data.tickets)) {
      if (c.session !== session) continue;
      delete this.data.tickets[id];
      hit = true;
    }
    if (hit) this.save();
    return hit;
  }

  /** Every bound ticket (housekeeping: a claim whose ticket is neither live nor pending any more). */
  tickets(): { tokenId: string; claim: TicketClaim }[] {
    return Object.entries(this.data.tickets).map(([tokenId, claim]) => ({ tokenId, claim }));
  }

  /**
   * The token id that gives `wallet` the daily `perk` today: one it already used today, else one of `tokens` nobody
   * used today. `commit`: record it (the purchase or the room happens now). Null: every token id of the wallet gave
   * this perk to another wallet today.
   */
  daily(perk: DailyPerk, wallet: string, tokens: readonly string[], commit = false): string | null {
    const w = wallet.toLowerCase();
    const day = utcDay(this.now());
    const used = this.data.daily[day]?.[perk] ?? {};
    const pick = tokens.find((id) => used[id] === w) ?? tokens.find((id) => used[id] === undefined) ?? null;
    if (pick !== null && commit && used[pick] !== w) {
      const d = (this.data.daily[day] ??= {});
      (d[perk] ??= {})[pick] = w;
      // only today and yesterday matter
      for (const k of Object.keys(this.data.daily)) if (k < utcDay(this.now() - 2 * 86_400_000)) delete this.data.daily[k];
      this.save();
    }
    return pick;
  }

  private load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ClaimsFile>;
      if (j && typeof j === 'object') this.data = { v: 1, tickets: j.tickets && typeof j.tickets === 'object' ? j.tickets : {}, daily: j.daily && typeof j.daily === 'object' ? j.daily : {} };
    } catch {
      /* none yet */
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      this.log(`!!! emblem claims: could not write ${this.file} (${(err as Error).message})`);
    }
  }
}
