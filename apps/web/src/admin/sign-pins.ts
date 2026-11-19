import { sitePinsMessage, type SitePinsFields, type SitePinsRecord } from '@coinnibal/shared';
import { getAddress, type Address } from 'viem';
import type { AdminApi } from '../site/api';
import { isUserCancel } from '../site/session';
import { PINS, forgetSignedPins } from '../wallet/pinned';
import { walletProofSigner, type ProofSigner } from './secrets';

/** What the owner signs: the registered arena and NFT, and the arena's game token (none while it is not set). */
export interface PinTargets {
  arena: Address | null;
  nft: Address | null;
  token: Address | null;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Why the pins cannot be signed now (null: they can). Pure, tested. Only the owner wallet this site was built with
 * counts: a record signed by any other wallet is ignored by every browser.
 */
export function pinSignRefusal(i: { me: Address | null; owner: Address | null; chainId: number | null; targets: PinTargets; api: AdminApi | null }): string | null {
  if (!i.owner) return 'This site build has no valid owner wallet (VITE_OWNER_WALLET).';
  if (!i.me) return `Connect the owner wallet (${short(i.owner)}) first.`;
  if (i.me.toLowerCase() !== i.owner.toLowerCase()) return `Sign with the owner wallet ${short(i.owner)}. The connected wallet is ${short(i.me)}.`;
  if (!i.api) return 'Sign in at the top right first (one free signature).';
  if (i.chainId === null) return 'The game server reports no chain yet.';
  if (!i.targets.arena || !i.targets.nft) return 'Deploy and register the arena and the NFT first.';
  return null;
}

/** The fields of the message, checksummed, signed now. Pure. */
export function pinFields(chainId: number, t: PinTargets, now: Date = new Date()): SitePinsFields {
  return { chainId, arena: getAddress(t.arena!), nft: getAddress(t.nft!), token: t.token ? getAddress(t.token) : null, signedAt: now.toISOString() };
}

/**
 * Asks the owner wallet for one free signature of the site pins, stores it on the server and makes this browser read
 * the pins again. Throws with plain words when it cannot (`pinSignRefusal`, a cancelled signature, a server refusal).
 */
export async function signSitePins(o: { api: AdminApi | null; me: Address | null; chainId: number | null; targets: PinTargets; sign?: ProofSigner; owner?: Address | null; now?: Date }): Promise<SitePinsRecord> {
  const owner = o.owner === undefined ? PINS.owner : o.owner;
  const refused = pinSignRefusal({ me: o.me, owner, chainId: o.chainId, targets: o.targets, api: o.api });
  if (refused) throw new Error(refused);
  const fields = pinFields(o.chainId!, o.targets, o.now);
  let signature: string;
  try {
    signature = await (o.sign ?? walletProofSigner())(sitePinsMessage(fields));
  } catch (err) {
    throw new Error(isUserCancel(err) ? 'Signature cancelled: the site pins were not signed.' : (err as Error)?.message || 'The wallet did not sign.');
  }
  const record = await o.api!.savePins({ ...fields, signature });
  forgetSignedPins();
  return record;
}
