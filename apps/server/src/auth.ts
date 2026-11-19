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
 * at most `inFlight` at once and `burst` then `perSec` server-wide, `perClient` per client in `clientWindowMs`, each
 * given up after `timeoutMs`. Past the budget the signature is refused at once (the player signs again later).
 */
export const SMART_WALLET_CHECKS = { inFlight: 2, burst: 4, perSec: 0.5, perClient: 4, clientWindowMs: 10 * 60_000, timeoutMs: 10_000 } as const;

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
  /** Whether a wallet is an admin (`ADMIN_WALLETS`): its tokens are short-lived and never extended. */
  isAdmin?: (wallet: string) => boolean;
  /** Admin token lifetime (default `ADMIN_TOKEN_TTL_MS`). */
  adminTtlMs?: number;
  /** Where revocations are kept (`DATA_DIR/auth-revoked.json`); null: memory only. */
  revocationsFile?: string | null;
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
  /** The smart-wallet budget (`SMART_WALLET_CHECKS`): checks running, the server-wide bucket, per client. */
  private smart = { running: 0, tokens: SMART_WALLET_CHECKS.burst as number, at: 0 };
  private readonly smartByClient = new Limiter(SMART_WALLET_CHECKS.perClient, SMART_WALLET_CHECKS.clientWindowMs);
  private isAdminWallet: (wallet: string) => boolean;
  readonly adminTtlMs: number;
  private revoked: Revocations = { adminsBefore: 0, wallets: {} };

  constructor(
    private readonly secret: Buffer,
    private readonly opts: AuthOptions = {},
  ) {
    this.onChain = opts.onChain ?? null;
    this.isAdminWallet = opts.isAdmin ?? (() => false);
    this.adminTtlMs = Math.max(60_000, opts.adminTtlMs ?? ADMIN_TOKEN_TTL_MS);
    this.loadRevocations();
  }

  /** Sets who is an admin (the site's `ADMIN_WALLETS`): their tokens are short, never extended, revocable as a group. */
  setAdminCheck(fn: (wallet: string) => boolean): void {
    this.isAdminWallet = fn;
  }

  /** Sets the smart-wallet fallback (the chain gateway's `verifyMessage`). */
  setOnChainVerifier(fn: OnChainVerifier | null): void {
    this.onChain = fn;
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
   * checksummed address, or null.
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
    const ok = await this.signedBy(checksummed, message, signature, entry.client);
    // a wrong signature gives the nonce back a few times only: each failure may cost an on-chain check
    // (ERC-1271 / ERC-6492 call), so one nonce must not let a client hammer the RPC with garbage signatures
    if (!ok && entry.expires >= now) {
      const failures = (entry.failures ?? 0) + 1;
      if (failures < MAX_NONCE_FAILURES) this.track({ ...entry, failures }, fields.nonce);
    }
    return ok ? checksummed : null;
  }

  /**
   * `message` was signed by `address`: an EOA locally (no RPC), else a smart wallet through the chain. `client`: the
   * client that asked (a sign-in); its smart-wallet check runs within `SMART_WALLET_CHECKS` (none: an admin's proof,
   * which only a signed-in admin can send).
   */
  async signedBy(address: string, message: string, signature: string, client: string | null = null): Promise<boolean> {
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{2,4096}$/.test(signature)) return false;
    const a = checksumAddress(address);
    if (!a) return false;
    if (await verifyEoa(a, message, signature as Hex)) return true;
    const onChain = this.onChain;
    if (!onChain) return false;
    if (client === null) return onChain(a, message, signature).catch(() => false);
    if (!this.smartCheckAllowed(client)) return false;
    this.smart.running++;
    const check = onChain(a, message, signature)
      .catch(() => false)
      .finally(() => this.smart.running--);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), SMART_WALLET_CHECKS.timeoutMs);
      timer.unref();
    });
    return Promise.race([check, late]).finally(() => clearTimeout(timer));
  }

  /** One more smart-wallet check fits the budget (`SMART_WALLET_CHECKS`): it is spent when true. */
  private smartCheckAllowed(client: string, now = Date.now()): boolean {
    const b = this.smart;
    b.tokens = Math.min(SMART_WALLET_CHECKS.burst, b.tokens + ((now - b.at) / 1000) * SMART_WALLET_CHECKS.perSec);
    b.at = now;
    if (b.running >= SMART_WALLET_CHECKS.inFlight || b.tokens < 1 || !this.smartByClient.allow(client, now)) return false;
    b.tokens -= 1;
    return true;
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
