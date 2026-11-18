/**
 * Custom-room fees paid in the game token (`CoinnibalArena.pay`): a chain fixture shared by test/custom-rooms.test.ts and
 * test/custom-paid-rooms.test.ts.
 */
import { CUSTOM_DEFAULTS, ROOM_CLOSE_COUNTDOWN_MS, customRoomCost, customRoomPaymentRef, shopPaymentRef, type ChainStatus } from '@elymum/shared';
import { UsedPayments } from '../src/chain/payment';
import { ChainBusyError, NullChain, type ChainArena, type TokenReceipt } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { mulberry32 } from '../src/game/rng';
import { CustomRoomFail, CustomRoomService } from '../src/rooms/custom';
import { RoomManager } from '../src/rooms/manager';
import { ArenaChain, roomDeps } from './helpers';

export const TOKEN = '0x0000000000000000000000000000000000000707';
export const ARENA_ADDR = '0x00000000000000000000000000000000000A7e4A';
export const ONE = 10n ** 18n;
/** The default base price without a USD price source: 1,500 whole tokens. */
export const PRICE = 1500n * ONE;
export const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A room request id (16 base32 characters) for the number `n`. */
export const requestOf = (n: number) => {
  let out = '';
  for (let i = 0, x = n; i < 16; i++, x = Math.floor(x / 32)) out = B32[x % 32] + out;
  return out;
};

export interface PayOpts {
  value?: bigint;
  request?: string;
  /** The `Paid` event's ref (default: the request's room ref). */
  ref?: string;
  /** Who the arena says paid (default: `from`). */
  payer?: string;
  /** The contract that emitted `Paid` (default: the arena). */
  contract?: string;
  /** The token that moved (default: the game token); null: no token moved at all. */
  token?: string | null;
  status?: 'success' | 'reverted';
  timestamp?: number;
}

/**
 * The server's chain for room fees: the arena's `CoinnibalArena.pay` receipts keyed by hash (the token transfer to the
 * arena and its `Paid` event), the game token set unless `tokenSet` is false, and `busy` failing every read like a
 * rate-limited RPC.
 */
export class PayChain extends ArenaChain {
  readonly receipts = new Map<string, TokenReceipt>();
  reads = 0;
  busy = false;
  tokenSet = true;
  constructor(
    private readonly clock: { t: number },
    arenas: ChainArena[] = [],
  ) {
    super(arenas);
  }
  override status(): ChainStatus {
    const s = super.status();
    return this.tokenSet ? s : { ...s, tokenReady: false, token: null };
  }
  async tokenReceipt(h: string): Promise<TokenReceipt | null> {
    this.reads++;
    if (this.busy) throw new ChainBusyError('test');
    return this.receipts.get(h.toLowerCase()) ?? null;
  }
  /** `from` calls `pay(value, customRoomPaymentRef(request))` in transaction `n`; the create body's payment part. */
  pay(n: number, from: string, o: PayOpts = {}): { txHash: string; request: string } {
    const h = hash(n);
    const request = o.request ?? requestOf(n);
    const value = o.value ?? PRICE;
    this.receipts.set(h, {
      status: o.status ?? 'success',
      blockNumber: 10n,
      timestamp: o.timestamp ?? this.clock.t - 5_000,
      transfers: o.token === null ? [] : [{ token: o.token ?? TOKEN, from, to: ARENA_ADDR, value }],
      payments: [{ contract: o.contract ?? ARENA_ADDR, payer: o.payer ?? from, ref: o.ref ?? customRoomPaymentRef(request), amount: value }],
    });
    return { txHash: h, request };
  }
}


export interface RoomFeeConservation {
  attempts: number;
  opened: number;
  refused: number;
  replays: number;
  violations: string[];
}

/**
 * Many wallets open rooms with random payments (exact, more than the price, short by one unit, someone else's, for
 * another request or a power-up, replayed with the same hash or the same request, not mined yet), at random sizes,
 * some of them NFT holders at the discount, while rooms close and the clock moves. Afterwards: every room opened was
 * paid by its creator at least its price, with a hash and a request no other room used; the fees the rooms recorded
 * add up to exactly what those payments paid; a refused payment opened nothing and used nothing up.
 */
export async function runRoomFeeConservation(seed: number, attempts = 300): Promise<RoomFeeConservation> {
  const rng = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
  const clock = { t: 1_800_000_000_000 };
  const chain = new PayChain(clock);
  const used = new UsedPayments(null);
  const wallets = Array.from({ length: 10 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
  const holders = new Set(wallets.filter((_, i) => i % 3 === 0));
  const rooms = new RoomManager(loadConfig({} as NodeJS.ProcessEnv), roomDeps(new NullChain()), new NullChain());
  const svc = new CustomRoomService({ rooms, dataDir: null, used, chain, receiptRetryMs: [0], isHolder: async (w) => holders.has(w.toLowerCase()), now: () => clock.t });
  svc.updateSettings({ holderPerk: 'discount', holderDiscountPct: 50, maxLive: 24, maxPerWallet: 10, maxSeats: 500, priceIn: 'token', priceTokens: '1500' });
  const violations: string[] = [];
  const paidBy = new Map<string, { wallet: string; amount: bigint; request: string }>();
  const openedBy = new Map<string, string>();
  const opened = new Map<string, { code: string; hash: string; wallet: string; request: string; price: bigint; paid: bigint }>();
  let n = 0;
  let refused = 0;
  let replays = 0;
  let paidTotal = 0n;
  for (let i = 0; i < attempts; i++) {
    clock.t += Math.floor(rng() * 20_000);
    const wallet = pick(wallets);
    const capacity = pick([2, 10, 11, 20, 25, 50, 100]);
    const price = customRoomCost(BigInt((await svc.quote(null)).priceRaw), svc.settings, holders.has(wallet), false, capacity);
    const scenario = pick(['exact', 'exact', 'more', 'short', 'foreign', 'otherRequest', 'shop', 'replayHash', 'replayRequest', 'pending'] as const);
    let body: { txHash: string; request: string };
    let mustFail = true;
    if ((scenario === 'replayHash' || scenario === 'replayRequest') && opened.size > 0) {
      replays++;
      const prev = pick([...opened.values()]);
      body = scenario === 'replayHash' ? { txHash: prev.hash, request: prev.request } : chain.pay(++n, prev.wallet, { value: price * 2n, request: prev.request });
      // the creator asking again with its own paid hash while the room lives gets that room back (no new room)
      const asOwner = scenario === 'replayHash' && pick([true, false]);
      const who = asOwner ? prev.wallet : scenario === 'replayRequest' ? prev.wallet : pick(wallets.filter((w) => w !== prev.wallet));
      const before = svc.live;
      try {
        const v = await svc.create(who, { config: { ...CUSTOM_DEFAULTS, name: 'Sim room', maxPlayers: capacity }, ...body });
        if (svc.live !== before || !(asOwner && v.code === prev.code)) violations.push(`replay ${scenario} of ${prev.hash} opened ${v.code}`);
      } catch (err) {
        if (!(err instanceof CustomRoomFail)) throw err;
        refused++;
        if (svc.live !== before) violations.push(`a refused replay changed the rooms`);
      }
      continue;
    }
    const payer = scenario === 'foreign' ? pick(wallets.filter((w) => w !== wallet)) : wallet;
    const value = scenario === 'more' ? price + BigInt(1 + Math.floor(rng() * 1e6)) : scenario === 'short' ? price - 1n : price;
    if (scenario === 'pending') body = { txHash: hash(1_000_000 + ++n), request: requestOf(1_000_000 + n) };
    else if (scenario === 'otherRequest') body = { ...chain.pay(++n, payer, { value, ref: customRoomPaymentRef(requestOf(500_000 + n)) }), request: requestOf(++n) };
    else if (scenario === 'shop') body = chain.pay(++n, payer, { value, ref: shopPaymentRef('magnet') });
    else {
      body = chain.pay(++n, payer, { value });
      mustFail = scenario === 'short' || scenario === 'foreign' || value < price;
    }
    const before = svc.live;
    const wasUsed = used.has(body.txHash);
    try {
      const v = await svc.create(wallet, { config: { ...CUSTOM_DEFAULTS, name: 'Sim room', maxPlayers: capacity }, ...body });
      if (mustFail) violations.push(`${scenario} payment ${body.txHash} opened ${v.code}`);
      if (svc.live !== before + 1) violations.push(`opening ${v.code} did not add one room`);
      if (paidBy.has(body.txHash) || openedBy.has(`${wallet}:${body.request}`)) violations.push(`${body.txHash} opened a second room`);
      const paid = BigInt(v.feeRaw ?? '0');
      if (paid < price) violations.push(`${v.code} paid ${paid} < price ${price}`);
      if (paid !== value) violations.push(`${v.code} recorded ${paid}, the payment was ${value}`);
      paidBy.set(body.txHash, { wallet, amount: paid, request: body.request });
      openedBy.set(`${wallet}:${body.request}`, v.code);
      opened.set(v.code, { code: v.code, hash: body.txHash, wallet, request: body.request, price, paid });
      paidTotal += paid;
    } catch (err) {
      if (!(err instanceof CustomRoomFail)) throw err;
      refused++;
      if (!mustFail && !['slots_busy', 'wallet_limit', 'seats_busy'].includes(err.code)) violations.push(`a good payment was refused: ${err.code} ${err.message}`);
      if (svc.live !== before) violations.push(`a refused payment changed the rooms`);
      if (!wasUsed && used.has(body.txHash)) violations.push(`a refused payment ${body.txHash} was used up`);
    }
    // now and then a creator closes a room (it ends after its countdown), so slots free up
    if (rng() < 0.6 && opened.size > 0) {
      const r = pick([...opened.values()]);
      if (svc.get(r.code)) svc.close(r.code, { wallet: r.wallet, admin: false });
      clock.t += ROOM_CLOSE_COUNTDOWN_MS;
      svc.sweep(clock.t);
    }
  }
  // the books: every opened room's fee is one accepted payment, to the unit
  let recorded = 0n;
  for (const r of opened.values()) recorded += r.paid;
  if (recorded !== paidTotal) violations.push(`rooms recorded ${recorded}, payments accepted ${paidTotal}`);
  if (used.size !== opened.size) violations.push(`${used.size} payments used for ${opened.size} rooms`);
  for (const r of opened.values()) if (!used.has(r.hash) || !used.hasRequest(r.wallet, r.request)) violations.push(`${r.code}'s payment is not recorded as used`);
  rooms.shutdown();
  return { attempts, opened: opened.size, refused, replays, violations };
}
