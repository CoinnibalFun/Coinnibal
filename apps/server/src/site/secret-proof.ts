import { randomBytes } from 'node:crypto';

/**
 * What a fresh owner signature unlocks. `backup`: one `GET /api/admin/backup`. `migration`: one
 * `GET /api/admin/migration-env` and one `GET /api/admin/backup` (the move to a new server, `install.sh --from`).
 */
export type SecretPurpose = 'backup' | 'migration';
export const SECRET_PURPOSES: readonly SecretPurpose[] = ['backup', 'migration'];

/** The routes each purpose opens (each once). */
const OPENS: Record<SecretPurpose, readonly SecretRoute[]> = { backup: ['backup'], migration: ['migration-env', 'backup'] };
export type SecretRoute = 'backup' | 'migration-env';

/** A challenge is valid this long after it was issued. */
export const SECRET_PROOF_TTL_MS = 10 * 60_000;
/** Outstanding challenges per admin wallet (a new one beyond it replaces the oldest). */
const MAX_PER_WALLET = 4;

/** The HTTP header that carries a proof: base64url of `{"message": "...", "signature": "0x..."}`. */
export const SECRET_PROOF_HEADER = 'x-coinnibal-proof';
/**
 * The same header under the project's name before the rename (Elymum, November 2026), still read when the new one is
 * absent: an install.sh / restore.sh copied before the rename sends it. The proof is checked the same way.
 */
export const OLD_SECRET_PROOF_HEADER = 'x-elymum-proof';

interface Challenge {
  wallet: string;
  purpose: SecretPurpose;
  message: string;
  expires: number;
  /** Routes not used yet. */
  left: Set<SecretRoute>;
}

/** Why a proof was refused (the answer's message). */
export class SecretProofError extends Error {}

/**
 * Purpose-bound, single-use owner signatures for the routes that hand out the server's secrets (the backup holds the
 * server key; the migration settings hold `SERVER_PRIVATE_KEY` and `AUTH_SECRET`). A session token alone (it sits in
 * the browser's storage) never opens them: the admin asks for a challenge (`issue`), signs its text with the admin
 * wallet (`personal_sign`), and sends `{message, signature}` in the `X-Coinnibal-Proof` header. The challenge names the
 * purpose, the wallet, this server and the chain, expires after 10 minutes and opens each of its routes once.
 */
export class SecretProofs {
  private readonly open = new Map<string, Challenge>();

  constructor(private readonly verify: (wallet: string, message: string, signature: string) => Promise<boolean>) {}

  issue(wallet: string, purpose: SecretPurpose, where: { domain: string; chainId: number | null }, now = Date.now()): { message: string; nonce: string; expiresAt: number } {
    for (const [k, c] of this.open) if (c.expires < now) this.open.delete(k);
    const mine = [...this.open].filter(([, c]) => c.wallet.toLowerCase() === wallet.toLowerCase());
    for (let i = 0; i <= mine.length - MAX_PER_WALLET; i++) this.open.delete(mine[i][0]);
    const nonce = randomBytes(16).toString('hex');
    const expires = now + SECRET_PROOF_TTL_MS;
    const what = purpose === 'backup' ? 'download one full backup of the server data' : 'read the server settings and download one full backup, to move the server';
    const message = [
      'Coinnibal admin: export the server secrets',
      '',
      `I allow this server to ${what}. It contains the server key: keep it encrypted.`,
      '',
      `Purpose: ${purpose}`,
      `Server: ${where.domain}`,
      `Chain ID: ${where.chainId ?? 'none'}`,
      `Wallet: ${wallet}`,
      `Nonce: ${nonce}`,
      `Expires: ${new Date(expires).toISOString()}`,
    ].join('\n');
    this.open.set(nonce, { wallet, purpose, message, expires, left: new Set(OPENS[purpose]) });
    return { message, nonce, expiresAt: expires };
  }

  /**
   * Checks the proof header for `route` of `wallet` (the session's admin) and uses it up for that route. Throws
   * `SecretProofError` with the reason.
   */
  async consume(header: string | string[] | undefined, wallet: string, route: SecretRoute, now = Date.now()): Promise<SecretPurpose> {
    if (typeof header !== 'string' || header.length === 0 || header.length > 8_000) {
      throw new SecretProofError('This needs a fresh signature of the admin wallet: ask POST /api/admin/secret-proof for the text, sign it, and send it in the X-Coinnibal-Proof header.');
    }
    let body: { message?: unknown; signature?: unknown };
    try {
      body = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as typeof body;
    } catch {
      throw new SecretProofError('X-Coinnibal-Proof is not base64url JSON {"message","signature"}.');
    }
    if (typeof body.message !== 'string' || typeof body.signature !== 'string') throw new SecretProofError('X-Coinnibal-Proof needs "message" and "signature".');
    const nonce = /^Nonce: ([0-9a-f]{32})$/m.exec(body.message)?.[1];
    const c = nonce ? this.open.get(nonce) : undefined;
    if (!c || c.message !== body.message) throw new SecretProofError('Unknown or already used signature request: ask for a new one.');
    if (c.expires < now) {
      this.open.delete(nonce!);
      throw new SecretProofError('The signature request expired: ask for a new one.');
    }
    if (c.wallet.toLowerCase() !== wallet.toLowerCase()) throw new SecretProofError('The signature request belongs to another admin wallet.');
    if (!c.left.has(route)) throw new SecretProofError(`This signature does not allow ${route} (purpose ${c.purpose}), or it was used for it already.`);
    // used up before the (async) signature check: two parallel requests cannot both pass
    c.left.delete(route);
    if (c.left.size === 0) this.open.delete(nonce!);
    if (!(await this.verify(wallet, body.message, body.signature).catch(() => false))) {
      this.open.delete(nonce!);
      throw new SecretProofError('The signature is not from the admin wallet.');
    }
    return c.purpose;
  }
}
