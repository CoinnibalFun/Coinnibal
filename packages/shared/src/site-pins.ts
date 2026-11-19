/**
 * The site's contract pins, signed by the owner (`GET /api/site/pins`, `POST /api/admin/pins`).
 *
 * The site signs only with the contracts it trusts. They come from the build (`VITE_*_ADDRESS`, an optional override)
 * or from one plain message the owner's wallet signs in `/admin` after a deploy: it names the chain, the arena, the
 * NFT and the game token. The server stores that record and anyone can read it, but a browser uses it only when the
 * signature is the owner's (`OWNER_WALLET`, built into the site) for that chain. A stolen admin login or a lying
 * server API cannot forge it, so neither can point wallets at other contracts.
 */

/** The owner's wallet: the deployer and owner of the Coinnibal contracts (a public address). */
export const OWNER_WALLET = '0x08b2b32E932D5f429073a441E6eFd8e3D42369b2';

export interface SitePinsFields {
  chainId: number;
  /** EIP-55 checksummed. */
  arena: string;
  /** EIP-55 checksummed. */
  nft: string;
  /** The arena's game token (EIP-55), or null while it is not set on the arena. */
  token: string | null;
  /** When the owner signed (ISO 8601, `Date.toISOString()`). */
  signedAt: string;
}

export interface SitePinsRecord extends SitePinsFields {
  /** The owner's `personal_sign` of `sitePinsMessage(fields)` (0x, 65 bytes). */
  signature: string;
}

/** `GET /api/site/pins?chainId=`: the record of that chain (default: the server's), or null. */
export interface SitePinsResponse {
  record: SitePinsRecord | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * The text the owner signs, rebuilt from the fields by the panel, the server and every browser (so nothing in it is
 * parsed). Pass checksummed addresses: the same contracts in another letter case are another message.
 */
export function sitePinsMessage(f: SitePinsFields): string {
  return [
    'Coinnibal site pins',
    '',
    'I am the owner. Wallets on the Coinnibal site may use these contracts on this chain.',
    '',
    `Chain ID: ${f.chainId}`,
    `Arena: ${f.arena}`,
    `NFT: ${f.nft}`,
    `Token: ${f.token ?? 'not set yet'}`,
    `Signed at: ${f.signedAt}`,
    '',
    'This signature is free. It sends no transaction.',
  ].join('\n');
}

/** A record of the right shape (addresses, time, signature), or null. Says nothing about who signed it. Pure. */
export function parseSitePinsRecord(raw: unknown): SitePinsRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const chainId = r.chainId;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) return null;
  if (typeof r.arena !== 'string' || !ADDRESS.test(r.arena)) return null;
  if (typeof r.nft !== 'string' || !ADDRESS.test(r.nft)) return null;
  if (r.token !== null && (typeof r.token !== 'string' || !ADDRESS.test(r.token))) return null;
  if (typeof r.signedAt !== 'string' || !ISO.test(r.signedAt) || Number.isNaN(Date.parse(r.signedAt))) return null;
  if (typeof r.signature !== 'string' || !SIGNATURE.test(r.signature)) return null;
  return { chainId, arena: r.arena, nft: r.nft, token: r.token as string | null, signedAt: r.signedAt, signature: r.signature };
}
