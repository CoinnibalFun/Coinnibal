import { REFUSAL_CODES, type ErrorCode } from '@elymum/shared';
import type { ChainGateway, ChainSession } from '../chain/types';
import type { Candidate } from '../integrity/detectors';
import type { Journal, SettlementItem } from '../stake/journal';
import type { EmblemClaims } from './emblem-claims';

/** A claim whose ticket is neither in a room nor in the journal any more is let go after this. */
const ORPHAN_MS = 10 * 60_000;

export interface EmblemGateDeps {
  chain: Pick<ChainGateway, 'status' | 'listArenas' | 'kick'>;
  journal: Journal;
  claims: EmblemClaims;
  /** `balanceOf > 0` (fresh: uncached). */
  isHolder: (wallet: string, fresh: boolean) => Promise<boolean>;
  /** The token ids the wallet owns (fresh: the index catches up first); null when unknown. */
  emblemTokens: (wallet: string, fresh: boolean) => Promise<string[] | null>;
  /** Raises an integrity flag (the admin's Integrity tab). */
  flag?: (c: Candidate) => void;
  /** Session keys seated in rooms now. */
  liveSessions: () => Set<string>;
  log: (m: string) => void;
  now?: () => number;
}

/**
 * The seat check of holder tickets (a holders-only arena, or a ticket bought with the holder fee rates): the wallet
 * must hold the emblem now (read fresh), and one of its token ids must be free of other open holder tickets
 * (`EmblemClaims`). Otherwise the seat is refused and the ticket cancelled at once with its full entry fee back (the
 * holder rates or the holders-only seat were bought with an emblem that is not there, or that already serves another
 * open ticket); a token id caught serving two raises an integrity flag.
 */
export class EmblemGate {
  private readonly now: () => number;

  constructor(private readonly d: EmblemGateDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Whether this ticket is a holder ticket (the arena is holders-only, or its fee rates are the holder pair). */
  async isHolderTicket(s: ChainSession): Promise<boolean> {
    const f = this.d.chain.status().fees;
    const rates = s.rates;
    const holderRates =
      !!f && f.holderPerks && !!rates && rates.burnBps === f.holderBurnBps && rates.vaultBps === f.holderVaultBps && f.holderBurnBps + f.holderVaultBps < f.burnBps + f.vaultBps;
    if (holderRates) return true;
    const arena = (await this.d.chain.listArenas().catch(() => [])).find((a) => a.id === s.arenaId);
    return !!arena?.holdersOnly;
  }

  /** Null: seat it. Else the refusal (the ticket is already queued for a full refund). */
  async seat(wallet: string, s: ChainSession): Promise<{ code: ErrorCode; message: string } | null> {
    if (!(await this.isHolderTicket(s))) return null;
    if (!(await this.d.isHolder(wallet, true).catch(() => false))) {
      this.cancel(wallet, s, 'the wallet no longer holds an emblem');
      return { code: REFUSAL_CODES.emblem, message: 'This ticket needs an Elymum NFT in your wallet, and it is not there now. The ticket is refunded in full.' };
    }
    const tokens = await this.d.emblemTokens(wallet, true).catch(() => null);
    // the index cannot tell (never read, the RPC refuses logs): balanceOf said yes, so the seat goes on
    if (!tokens || tokens.length === 0) {
      this.d.log(`emblem: ${wallet} holds an emblem but the token index cannot name it yet; ticket ${s.key} seated without a token claim`);
      return null;
    }
    const r = this.d.claims.claimTicket(s.key, wallet, s.arenaId, tokens);
    if (r.ok) return null;
    this.cancel(wallet, s, `emblem #${tokens.join(', #')} already serves ${r.heldBy.length} open holder ticket(s)`);
    const others = [...new Set(r.heldBy.map((c) => c.wallet))].filter((w) => w !== wallet.toLowerCase());
    if (others.length > 0) {
      this.d.flag?.({
        kind: 'shared_device',
        subtype: 'emblem_shared',
        id: `emblem_shared:${tokens[0]}`,
        score: 70,
        wallets: [wallet.toLowerCase(), ...others],
        beneficiary: wallet.toLowerCase(),
        arenaId: s.arenaId,
        summary: `Emblem #${tokens[0]} was passed on while it served an open holder ticket: ${wallet} tried to seat a second holder ticket with it.`,
        evidence: { tokenIds: tokens, session: s.key, heldBy: r.heldBy.map((c) => c.session) },
      });
    }
    return { code: REFUSAL_CODES.emblem, message: 'Your emblem already serves another open holder ticket (one ticket per emblem at a time). This ticket is refunded in full.' };
  }

  /** The seated ticket was settled: its token id is free. */
  settled(session: string): void {
    this.d.claims.releaseTicket(session);
  }

  /** Lets go of claims whose ticket is neither seated nor in the journal (settled elsewhere, refunded after 24 h). */
  sweep(): number {
    const live = this.d.liveSessions();
    const pending = new Set(this.d.journal.pending.map((p) => p.key));
    let n = 0;
    for (const { claim } of this.d.claims.tickets()) {
      if (live.has(claim.session) || pending.has(claim.session) || this.now() - claim.at < ORPHAN_MS) continue;
      if (this.d.claims.releaseTicket(claim.session)) n++;
    }
    return n;
  }

  /** The ticket goes back in full (`cancel`, no fee), now. */
  private cancel(wallet: string, s: ChainSession, why: string): void {
    const now = this.now();
    if (this.d.journal.pending.some((p) => p.key === s.key)) return;
    const item: SettlementItem = {
      kind: 'settle',
      key: s.key,
      player: s.player,
      arenaId: s.arenaId,
      session: s.key,
      sessionId: s.id,
      payout: s.entryFee,
      entryFee: s.entryFee,
      score: 0,
      kills: 0,
      xp: 0,
      // an unplayed ticket: the worker sends it as `cancel` (the full entry fee back)
      reason: 'stale',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    };
    this.d.journal.commit({ enqueue: [item] });
    this.d.chain.kick();
    this.d.log(`!!! emblem: seat of ${s.key} refused (${why}) — the ticket of ${wallet} is cancelled with its full entry fee`);
  }
}
