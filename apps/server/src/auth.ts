import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CHAIN_ID, parseSiweMessage, siweMessage } from '@coinnibal/shared';
import { getAddress, type Address, type Hex } from 'viem';
import { verifyEoa } from './chain/evm-client';
import { wideNetOf } from './net/ip-key';
import { Limiter } from './net/limiter';

/** A nonce is single use and valid this long. */
export const NONCE_TTL_MS = 10 * 60_000;
/** A player's session token lives this long. */
export const TOKEN_TTL_MS = 24 * 60 * 60_000;
/** An admin wallet's session token lives this long by default (`ADMIN_TOKEN_TTL_MIN`); a refresh never extends it. */
export const ADMIN_TOKEN_TTL_MS = 2 * 60 * 60_000;
/** Hard cap on outstanding nonces. */
export const MAX_NONCES = 10_000;
/**
 * Outstanding nonces one client holds for one wallet address (a new one beyond it replaces that client's oldest for
 * the address). Never per address alone: anyone may ask for nonces for any address, and must not evict its owner's.
 */
export const MAX_NONCES_PER_ADDRESS = 4;
/** Outstanding nonces per client (IP): beyond it `issueNonce` refuses (null), so one client cannot fill the pool. */
export const MAX_NONCES_PER_CLIENT = 24;
/** Wrong signatures a nonce survives; at this many it is gone (ask for a new one). */
export const MAX_NONCE_FAILURES = 3;
/**
 * The smart-wallet fallback (ERC-1271 / ERC-6492, one `eth_call` each) of a signature that is not the address's own
 * EOA signature runs within a small budget of its own, so garbage signatures cannot spend the shared RPC budget:
 * at most `inFlight` at once and `burst` then `perSec` server-wide, `perClient` per client (an IPv4 address, an IPv6
 * /64) and `perGroup` per IPv6 /48 in `clientWindowMs`. A check not answered in `timeoutMs` gives its place back at
 * once (the RPC call it made may still be queued). Past the budget the sign-in is "busy" (`SignInBusyError`): the
 * nonce stays as it was, and the player signs again in a moment.
 */
export const SMART_WALLET_CHECKS = { inFlight: 2, burst: 4, perSec: 0.5, perClient: 4, perGroup: 8, clientWindowMs: 10 * 60_000, timeoutMs: 10_000 } as const;
/**
 * A reserve beside `SMART_WALLET_CHECKS` for a smart wallet that signed in before from the same network (its
 * `group`: an IPv4 address, an IPv6 /48), so a flood of garbage signatures cannot starve a known smart-wallet owner
 * (an admin's Safe, a player's Coinbase Smart Wallet). Only a valid signature makes a wallet and network known, so
 * nobody spends that reserve but from the owner's own network: `perPair` checks per wallet and network and `perWallet`
 * per wallet in `windowMs`, `inFlight` / `burst` / `perSec` server-wide. Pairs are kept `ttlMs` (on disk, with
 * `smartWalletsFile`), at most `max`.
 */
export const SMART_WALLET_RESERVE = { inFlight: 2, burst: 4, perSec: 0.25, perPair: 4, perWallet: 8, windowMs: 10 * 60_000, ttlMs: 90 * 24 * 60 * 60_000, max: 5_000 } as const;
/**
 * Garbage aimed at a plain account (an EOA) stays out of the smart-wallet budget: a signature without the ERC-6492
 * suffix (a wallet not deployed yet) is checked on chain only when the address holds code. The code check
 * (`eth_getCode`, low RPC priority) is cached `codeTtlMs` (no code: `noCodeTtlMs`; at most `max` addresses) and has a
 * budget of its own: `burst` then `perSec` server-wide, `perClient` per client in `windowMs`, `timeoutMs` each. Past
 * it (or unanswered), the address is taken as possibly a contract: the smart-wallet budget decides.
 */
export const CODE_CHECKS = { burst: 8, perSec: 1, perClient: 8, windowMs: 10 * 60_000, timeoutMs: 3_000, codeTtlMs: 60 * 60_000, noCodeTtlMs: 10 * 60_000, max: 10_000 } as const;
/** The magic suffix of an ERC-6492 signature (a counterfactual smart wallet: deployed by the check itself). */
const ERC6492_SUFFIX = '6492649264926492649264926492649264926492649264926492649264926492';
/** What a busy sign-in answers (WebSocket `rate_limited`, HTTP 429). */
export const SIGN_IN_BUSY_MESSAGE = 'Sign-in is busy right now. Sign again in a moment.';

/**
 * `verifySignature`: the smart-wallet check could not run now (its budget is spent, or the chain did not answer in
 * time). Not a wrong signature: the nonce is given back as it was, no failure counted.
 */
export class SignInBusyError extends Error {
  constructor() {
    super(SIGN_IN_BUSY_MESSAGE);
  }
}

/** A token bucket with a bound on checks running at once. */
interface Bucket {
  readonly inFlight: number;
  readonly burst: number;
  readonly perSec: number;
  running: number;
  tokens: number;
  at: number;
}

const bucket = (b: { inFlight: number; burst: number; perSec: number }): Bucket => ({ inFlight: b.inFlight, burst: b.burst, perSec: b.perSec, running: 0, tokens: b.burst, at: 0 });

/** The bucket has a token and a free place now (refilled first; nothing spent). */
function ready(b: Bucket, now: number): boolean {
  b.tokens = Math.min(b.burst, b.tokens + ((now - b.at) / 1000) * b.perSec);
  b.at = now;
  return b.running < b.inFlight && b.tokens >= 1;
}

/** Who asked for a sign-in check: its `rateKey` and its wider network (an IPv6 /48; an IPv4 client is its own). */
export interface SignInClient {
  client: string;
  group: string;
}

/** Where a login message says the player signs in (SIWE `domain`, `URI`, `Chain ID`). */
export interface SiweOrigin {
  domain: string;
  uri: string;
  /** The server's chain id (`eth_chainId` of its RPC). */
  chainId: number;
}

const DEFAULT_ORIGIN: SiweOrigin = { domain: 'localhost', uri: 'http://localhost', chainId: DEFAULT_CHAIN_ID };

/** An EVM address: `0x` + 40 hex digits, any case. */
export function isValidAddress(s: unknown): s is string {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
}

/**
 * EIP-55 checksummed form of an address; null when it is not one, or when it is mixed-case with a
 * wrong checksum (a typo).
 */
export function checksumAddress(s: unknown): Address | null {
  if (!isValidAddress(s)) return null;
  try {
    const c = getAddress(s);
    const mixed = s.slice(2) !== s.slice(2).toLowerCase() && s.slice(2) !== s.slice(2).toUpperCase();
    return mixed && c !== s ? null : c;
  } catch {
    return null;
  }
}

/** Builds the exact text a wallet signs to log in (Sign-In with Ethereum, EIP-4361). */
export function loginMessage(address: string, nonce: string, issuedAt: string, origin: SiweOrigin = DEFAULT_ORIGIN): string {
  return siweMessage({ domain: origin.domain, address, uri: origin.uri, chainId: origin.chainId, nonce, issuedAt });
}

/** What `GET /api/auth/nonce` returns: the message and every field of it (the client rebuilds and compares). */
export interface IssuedNonce {
  nonce: string;
  message: string;
  /** EIP-55 checksummed. */
  address: string;
  domain: string;
  uri: string;
  chainId: number;
  issuedAt: string;
}

/** On-chain check for smart-wallet signatures (ERC-1271 / ERC-6492); EOAs never need it. */
export type OnChainVerifier = (address: string, message: string, signature: string) => Promise<boolean>;
/** Whether an address holds code (`eth_getCode`): a smart wallet, never a plain account. */
export type CodeCheck = (address: string) => Promise<boolean>;

/** `issueNonce`: this client already holds `MAX_NONCES_PER_CLIENT` unused nonces. */
export class NonceLimitError extends Error {
  constructor() {
    super('too many outstanding sign-in nonces for this client');
  }
}

interface NonceEntry {
  address: string;
  message: string;
  expires: number;
  origin: SiweOrigin;
  failures?: number;
  /** The client that asked (its `rateKey`: an IPv4 address, an IPv6 /64), for the per-client caps. */
  client: string;
  /** The client's wider network (an IPv6 /48; an IPv4 client is its own): a full pool evicts the biggest one's first. */
  group: string;
}

/** Revoked sessions: tokens issued before these times are refused (`Auth.revoke`). */
interface Revocations {
  /** Every admin session issued before this (Unix ms). */
  adminsBefore: number;
  /** Per wallet (lower-case): every session of that wallet issued before this. */
  wallets: Record<string, number>;
}

export interface AuthOptions {
  onChain?: OnChainVerifier | null;
  /** The code check that keeps garbage aimed at EOAs off the chain (`CODE_CHECKS`); absent: every address may be a contract. */
  hasCode?: CodeCheck | null;
  /** Whether a wallet is an admin (`ADMIN_WALLETS`): its tokens are short-lived and never extended. */
  isAdmin?: (wallet: string) => boolean;
  /** Admin token lifetime (default `ADMIN_TOKEN_TTL_MS`). */
  adminTtlMs?: number;
  /** Where revocations are kept (`DATA_DIR/auth-revoked.json`); null: memory only. */
  revocationsFile?: string | null;
  /** Where the known smart wallets are kept (`SMART_WALLET_RESERVE`, `DATA_DIR/auth-smart-wallets.json`); null: memory only. */
  smartWalletsFile?: string | null;
  log?: (m: string) => void;
}

/**
 * Wallet login: one-time SIWE nonces signed by the wallet, then stateless HMAC tokens
 * `<address>.<expires>.<issued>.<mac>` (tokens of the earlier `<address>.<expires>.<mac>` form are accepted for
 * players until they expire, never for admin routes). Admin wallets get short tokens (`ADMIN_TOKEN_TTL_MIN`, 2 h by
 * default) that a refresh never extends; `revoke` ends sessions before their expiry (one wallet's, or every
 * admin's), kept on disk so a restart does not bring them back.
 */
export class Auth {
  private readonly nonces = new Map<string, NonceEntry>();
  /** Outstanding nonces per client, per client network (`group`) and per client and address, oldest first. */
  private readonly byClient = new Map<string, Set<string>>();
  private readonly byGroup = new Map<string, Set<string>>();
  private readonly byClientAddress = new Map<string, Set<string>>();
  private onChain: OnChainVerifier | null;
  private hasCode: CodeCheck | null;
  /** The smart-wallet budget (`SMART_WALLET_CHECKS`): server-wide, per client, per IPv6 /48. */
  private readonly smart = bucket(SMART_WALLET_CHECKS);
  private readonly smartByClient = new Limiter(SMART_WALLET_CHECKS.perClient, SMART_WALLET_CHECKS.clientWindowMs);
  private readonly smartByGroup = new Limiter(SMART_WALLET_CHECKS.perGroup, SMART_WALLET_CHECKS.clientWindowMs);
  /** The reserve of known smart wallets (`SMART_WALLET_RESERVE`): `<address>|<group>` → last sign-in (Unix ms), oldest first. */
  private readonly knownSmart = new Map<string, number>();
  private readonly reserve = bucket(SMART_WALLET_RESERVE);
  private readonly reserveByPair = new Limiter(SMART_WALLET_RESERVE.perPair, SMART_WALLET_RESERVE.windowMs);
  private readonly reserveByWallet = new Limiter(SMART_WALLET_RESERVE.perWallet, SMART_WALLET_RESERVE.windowMs);
  /** The code check's cache and budget (`CODE_CHECKS`): lower-case address → holds code, until. */
  private readonly codeOf = new Map<string, { code: boolean; until: number }>();
  private readonly codeChecks = bucket({ inFlight: Infinity, burst: CODE_CHECKS.burst, perSec: CODE_CHECKS.perSec });
  private readonly codeByClient = new Limiter(CODE_CHECKS.perClient, CODE_CHECKS.windowMs);
  private isAdminWallet: (wallet: string) => boolean;
  readonly adminTtlMs: number;
  private revoked: Revocations = { adminsBefore: 0, wallets: {} };

  constructor(
    private readonly secret: Buffer,
    private readonly opts: AuthOptions = {},
  ) {
    this.onChain = opts.onChain ?? null;
    this.hasCode = opts.hasCode ?? null;
    this.isAdminWallet = opts.isAdmin ?? (() => false);
    this.adminTtlMs = Math.max(60_000, opts.adminTtlMs ?? ADMIN_TOKEN_TTL_MS);
    this.loadRevocations();
    this.loadKnownSmart();
  }

  /** Sets who is an admin (the site's `ADMIN_WALLETS`): their tokens are short, never extended, revocable as a group. */
  setAdminCheck(fn: (wallet: string) => boolean): void {
    this.isAdminWallet = fn;
  }

  /** Sets the smart-wallet fallback (the chain gateway's `verifyMessage`) and, optionally, its code check. */
  setOnChainVerifier(fn: OnChainVerifier | null, hasCode: CodeCheck | null = this.hasCode): void {
    this.onChain = fn;
    this.hasCode = hasCode;
  }

  /**
   * A one-time nonce and the SIWE message for it. The fields are returned too, so the web client
   * can rebuild the message itself and refuse to sign anything else. `client` (the caller's `rateKey`) is held to
   * `MAX_NONCES_PER_CLIENT` outstanding nonces (`NonceLimitError` beyond it: answer 429), and to
   * `MAX_NONCES_PER_ADDRESS` per wallet address (its own oldest for that address is replaced). Nothing is capped per
   * address alone: another client's requests for a wallet never touch the nonce its owner is signing. When the pool is
   * full, the network (`group`: the client, an IPv6 client's /48) holding the most loses its oldest first, so a flood
   * from many addresses or /64s evicts its own nonces before anyone else's.
   */
  issueNonce(address: string, origin: SiweOrigin = DEFAULT_ORIGIN, now = Date.now(), client = 'local'): IssuedNonce {
    const checksummed = checksumAddress(address);
    if (!checksummed) throw new Error('invalid address');
    this.prune(now);
    if ((this.byClient.get(client)?.size ?? 0) >= MAX_NONCES_PER_CLIENT) throw new NonceLimitError();
    // one client keeps a few per address (two tabs, a retry), never thousands
    const mine = this.byClientAddress.get(`${client}|${checksummed}`);
    while (mine && mine.size >= MAX_NONCES_PER_ADDRESS) this.dropNonce(mine.values().next().value!);
    if (this.nonces.size >= MAX_NONCES) this.evictOne();
    const nonce = randomBytes(12).toString('hex');
    const issuedAt = new Date(now).toISOString();
    const message = loginMessage(checksummed, nonce, issuedAt, origin);
    this.track({ address: checksummed, message, expires: now + NONCE_TTL_MS, origin, client, group: wideNetOf(client) ?? client }, nonce);
    return { nonce, message, address: checksummed, domain: origin.domain, uri: origin.uri, chainId: origin.chainId, issuedAt };
  }

  /** Outstanding nonces (tests). */
  get nonceCount(): number {
    return this.nonces.size;
  }

  private indexes(e: NonceEntry) {
    return [
      [this.byClient, e.client],
      [this.byGroup, e.group],
      [this.byClientAddress, `${e.client}|${e.address}`],
    ] as const;
  }

  private track(e: NonceEntry, nonce: string): void {
    this.nonces.set(nonce, e);
    for (const [map, key] of this.indexes(e)) {
      let set = map.get(key);
      if (!set) map.set(key, (set = new Set()));
      set.add(nonce);
    }
  }

  private dropNonce(nonce: string): void {
    const e = this.nonces.get(nonce);
    if (!e) return;
    this.nonces.delete(nonce);
    for (const [map, key] of this.indexes(e)) {
      const set = map.get(key);
      set?.delete(nonce);
      if (set && set.size === 0) map.delete(key);
    }
  }

  /** The pool is full: the oldest nonce of the network (`group`) that holds the most goes (the globally oldest when nobody holds many). */
  private evictOne(): void {
    let top: Set<string> | null = null;
    for (const set of this.byGroup.values()) if (!top || set.size > top.size) top = set;
    const victim = top && top.size > 2 ? top.values().next().value : this.nonces.keys().next().value;
    if (victim !== undefined) this.dropNonce(victim);
  }

  /**
   * Verifies a signed login message: the exact message issued for this nonce (domain, URI, chain id
   * and address of this server and wallet), signed by the wallet (`personal_sign`; an EOA is checked
   * locally, a smart wallet through the chain). The nonce is consumed on success. Returns the
   * checksummed address, or null. Throws `SignInBusyError` when the smart-wallet check cannot run now (the nonce
   * stays as it was: answer "busy, sign again in a moment").
   */
  async verifySignature(address: string, message: string, signature: string, now = Date.now()): Promise<string | null> {
    const checksummed = checksumAddress(address);
    if (!checksummed || typeof message !== 'string' || typeof signature !== 'string' || !/^0x[0-9a-fA-F]{2,4096}$/.test(signature)) return null;
    const fields = parseSiweMessage(message);
    if (!fields) return null;
    const entry = this.nonces.get(fields.nonce);
    if (!entry || entry.expires < now || entry.address !== checksummed || entry.message !== message) return null;
    // the signed text names this server: its domain, URI and chain, and the signing wallet
    const o = entry.origin;
    if (fields.address !== checksummed || fields.domain !== o.domain || fields.uri !== o.uri || fields.chainId !== o.chainId) return null;
    // single use: taken out before the (async) check so two concurrent replays cannot both pass
    this.dropNonce(fields.nonce);
    let ok: boolean;
    try {
      ok = await this.signedBy(checksummed, message, signature, { client: entry.client, group: entry.group });
    } catch (err) {
      // busy is not a wrong signature: the nonce comes back as it was (no failure counted)
      if (err instanceof SignInBusyError && entry.expires >= now) this.track(entry, fields.nonce);
      throw err;
    }
    // a wrong signature gives the nonce back a few times only: each failure may cost an on-chain check
    // (ERC-1271 / ERC-6492 call), so one nonce must not let a client hammer the RPC with garbage signatures
    if (!ok && entry.expires >= now) {
      const failures = (entry.failures ?? 0) + 1;
      if (failures < MAX_NONCE_FAILURES) this.track({ ...entry, failures }, fields.nonce);
    }
    return ok ? checksummed : null;
  }

  /**
   * `message` was signed by `address`: an EOA locally (no RPC), else a smart wallet through the chain. `from`: who
   * asked (a sign-in); its smart-wallet check runs within `SMART_WALLET_CHECKS` (or the reserve of a known smart
   * wallet), and only for an address that may be a contract (`CODE_CHECKS`). Null: an admin's proof, which only a
   * signed-in admin can send. Throws `SignInBusyError` when the check cannot run now.
   */
  async signedBy(address: string, message: string, signature: string, from: SignInClient | null = null): Promise<boolean> {
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{2,4096}$/.test(signature)) return false;
    const a = checksumAddress(address);
    if (!a) return false;
    if (await verifyEoa(a, message, signature as Hex)) return true;
    const onChain = this.onChain;
    if (!onChain) return false;
    if (from === null) return onChain(a, message, signature).catch(() => false);
    // a plain account's wrong signature never reaches the chain (a wallet not deployed yet signs with the 6492 suffix)
    if (!signature.toLowerCase().endsWith(ERC6492_SUFFIX) && (await this.mayBeContract(a, from.client)) === false) return false;
    const b = this.smartBudget(a, from);
    if (!b) throw new SignInBusyError();
    const ok = await this.runSmartCheck(b, () => onChain(a, message, signature));
    if (ok) this.rememberSmart(a, from.group);
    return ok;
  }

  /**
   * The budget a smart-wallet check of `address` for `from` runs in, spent: the reserve of a wallet known from that
   * network, else the general one; null when neither has room now.
   */
  private smartBudget(address: string, from: SignInClient, now = Date.now()): Bucket | null {
    const wallet = address.toLowerCase();
    const pair = `${wallet}|${from.group}`;
    const seen = this.knownSmart.get(pair);
    if (seen !== undefined && now - seen < SMART_WALLET_RESERVE.ttlMs && ready(this.reserve, now) && this.reserveByPair.allow(pair, now) && this.reserveByWallet.allow(wallet, now)) {
      this.reserve.tokens -= 1;
      return this.reserve;
    }
    if (ready(this.smart, now) && this.smartByClient.allow(from.client, now) && this.smartByGroup.allow(from.group, now)) {
      this.smart.tokens -= 1;
      return this.smart;
    }
    return null;
  }

  /**
   * Runs one smart-wallet check in `b`: its place is given back when the check ends or after `timeoutMs`, whichever
   * comes first (a call stuck in the RPC queue does not hold it). Unanswered in time: `SignInBusyError`.
   */
  private async runSmartCheck(b: Bucket, check: () => Promise<boolean>): Promise<boolean> {
    b.running++;
    let held = true;
    const release = () => {
      if (held) b.running--;
      held = false;
    };
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((r) => {
      timer = setTimeout(() => {
        release();
        r(null);
      }, SMART_WALLET_CHECKS.timeoutMs);
      timer.unref();
    });
    const answer = check()
      .catch(() => false)
      .finally(release);
    const ok = await Promise.race([answer, late]).finally(() => clearTimeout(timer));
    if (ok === null) throw new SignInBusyError();
    return ok;
  }

  /**
   * Whether `address` may be a smart wallet: false only when the chain said it holds no code (cached). Null when that
   * is not known and cannot be asked now (no code check, its budget spent, no answer in time).
   */
  private async mayBeContract(address: string, client: string, now = Date.now()): Promise<boolean | null> {
    const key = address.toLowerCase();
    const hit = this.codeOf.get(key);
    if (hit && now < hit.until) return hit.code;
    const hasCode = this.hasCode;
    if (!hasCode || !ready(this.codeChecks, now) || !this.codeByClient.allow(client, now)) return null;
    this.codeChecks.tokens -= 1;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), CODE_CHECKS.timeoutMs);
      timer.unref();
    });
    const code = await Promise.race([hasCode(address).catch(() => null), late]).finally(() => clearTimeout(timer));
    if (code !== null) this.noteCode(key, code);
    return code;
  }

  private noteCode(key: string, code: boolean, now = Date.now()): void {
    this.codeOf.delete(key);
    if (this.codeOf.size >= CODE_CHECKS.max) this.codeOf.delete(this.codeOf.keys().next().value!);
    this.codeOf.set(key, { code, until: now + (code ? CODE_CHECKS.codeTtlMs : CODE_CHECKS.noCodeTtlMs) });
  }

  /** A smart wallet signed in from `group`: its next checks from there have the reserve (kept on disk when it is new). */
  private rememberSmart(address: string, group: string, now = Date.now()): void {
    const pair = `${address.toLowerCase()}|${group}`;
    this.noteCode(address.toLowerCase(), true, now);
    const seen = this.knownSmart.get(pair);
    this.knownSmart.delete(pair);
    while (this.knownSmart.size >= SMART_WALLET_RESERVE.max) this.knownSmart.delete(this.knownSmart.keys().next().value!);
    this.knownSmart.set(pair, now);
    // written when the pair is new, or a day after it was last written (the file follows sign-ins, not every one)
    if (seen === undefined || now - seen > 24 * 60 * 60_000) this.saveKnownSmart(now);
  }

  private loadKnownSmart(now = Date.now()): void {
    const file = this.opts.smartWalletsFile;
    if (!file) return;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { pairs?: unknown };
      const pairs = Array.isArray(j.pairs) ? j.pairs : [];
      for (const p of pairs.slice(-SMART_WALLET_RESERVE.max)) {
        if (!Array.isArray(p) || typeof p[0] !== 'string' || !/^0x[0-9a-f]{40}\|.{1,64}$/.test(p[0]) || !Number.isFinite(p[1])) continue;
        if (now - Number(p[1]) < SMART_WALLET_RESERVE.ttlMs) this.knownSmart.set(p[0], Number(p[1]));
      }
    } catch {
      /* none yet */
    }
  }

  private saveKnownSmart(now: number): void {
    const file = this.opts.smartWalletsFile;
    if (!file) return;
    try {
      const pairs = [...this.knownSmart].filter(([, at]) => now - at < SMART_WALLET_RESERVE.ttlMs);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify({ pairs }), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      this.opts.log?.(`auth: could not save the known smart wallets (${(err as Error).message}); they hold until a restart only`);
    }
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  /** A session token; an admin wallet's lives `adminTtlMs`, everyone else's `TOKEN_TTL_MS`. */
  issueToken(address: string, now = Date.now()): string {
    const checksummed = checksumAddress(address);
    if (!checksummed) throw new Error('invalid address');
    const ttl = this.isAdminWallet(checksummed) ? this.adminTtlMs : TOKEN_TTL_MS;
    const payload = `${checksummed}.${now + ttl}.${now}`;
    return `${payload}.${this.mac(payload)}`;
  }

  /**
   * The token a client gets back when it signs in with a token it already holds (the WebSocket `auth`): a
   * player's session slides on (a new 24 h token); an admin's is never extended (the same token comes back).
   */
  refreshToken(token: string, now = Date.now()): string | null {
    const t = this.parse(token, now);
    if (!t) return null;
    if (this.isAdminWallet(t.address)) return token;
    return this.issueToken(t.address, now);
  }

  /** Returns the (checksummed) wallet of a valid, unexpired, unrevoked token. */
  verifyToken(token: unknown, now = Date.now()): string | null {
    return this.parse(token, now)?.address ?? null;
  }

  /**
   * The admin wallet of a token fit for admin routes: issued in the current form (with its issue time), at most
   * `adminTtlMs` long, unexpired and not revoked. Null otherwise (also for a player-length token of an admin wallet).
   */
  verifyAdminToken(token: unknown, now = Date.now()): string | null {
    const t = this.parse(token, now);
    if (!t || t.iat === null || !this.isAdminWallet(t.address)) return null;
    if (t.exp - t.iat > this.adminTtlMs) return null;
    return t.address;
  }

  private parse(token: unknown, now: number): { address: string; exp: number; iat: number | null } | null {
    if (typeof token !== 'string' || token.length > 220) return null;
    const parts = token.split('.');
    if (parts.length !== 3 && parts.length !== 4) return null;
    const [address, exp] = parts;
    const iat = parts.length === 4 ? parts[2] : null;
    const mac = parts[parts.length - 1];
    if (!isValidAddress(address) || !(Number(exp) > now)) return null;
    if (iat !== null && !/^\d{1,16}$/.test(iat)) return null;
    const expected = Buffer.from(this.mac(parts.slice(0, -1).join('.')));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    // a token of the earlier form: issued TOKEN_TTL_MS before it expires
    const issued = iat !== null ? Number(iat) : Number(exp) - TOKEN_TTL_MS;
    if (issued < (this.revoked.wallets[address.toLowerCase()] ?? 0)) return null;
    if (this.isAdminWallet(address) && issued < this.revoked.adminsBefore) return null;
    return { address, exp: Number(exp), iat: iat !== null ? Number(iat) : null };
  }

  /**
   * Ends sessions now: `wallet`'s (every token of it issued until now), or with `wallet` null every admin
   * session. Kept in `revocationsFile`. A token issued afterwards (a new sign-in) works.
   */
  revoke(wallet: string | null, now = Date.now()): void {
    if (wallet === null) this.revoked.adminsBefore = Math.max(this.revoked.adminsBefore, now + 1);
    else this.revoked.wallets[wallet.toLowerCase()] = Math.max(this.revoked.wallets[wallet.toLowerCase()] ?? 0, now + 1);
    // entries older than any token's life can go
    for (const [w, at] of Object.entries(this.revoked.wallets)) if (at < now - TOKEN_TTL_MS) delete this.revoked.wallets[w];
    this.saveRevocations();
  }

  private loadRevocations(): void {
    const file = this.opts.revocationsFile;
    if (!file) return;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<Revocations>;
      this.revoked = {
        adminsBefore: Number.isFinite(j.adminsBefore) ? Number(j.adminsBefore) : 0,
        wallets: j.wallets && typeof j.wallets === 'object' ? Object.fromEntries(Object.entries(j.wallets).filter(([, v]) => Number.isFinite(v))) : {},
      };
    } catch {
      /* none yet */
    }
  }

  private saveRevocations(): void {
    const file = this.opts.revocationsFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(this.revoked), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      this.opts.log?.(`!!! auth: could not save the revoked sessions (${(err as Error).message}); they hold until a restart only`);
    }
  }

  /**
   * Drops expired nonces once there are many. Oldest first, so it stops at the first live one: a request costs the
   * nonces that expired since the last, not a scan of the whole pool (a nonce given back after a wrong signature is
   * queued again and waits a little longer).
   */
  private prune(now: number): void {
    if (this.nonces.size < 1000) return;
    for (const [k, v] of this.nonces) {
      if (v.expires >= now) break;
      this.dropNonce(k);
    }
  }
}
