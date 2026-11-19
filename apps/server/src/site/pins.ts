import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseSitePinsRecord, sitePinsMessage, type SitePinsRecord } from '@coinnibal/shared';
import { getAddress, recoverMessageAddress, type Address, type Hex } from 'viem';
import type { ContractsStore } from './contracts';
import { SiteFail, bad } from './validate';

/** `DATA_DIR/site/pins.json`: the owner's signed site pins, one record per chain id. */
export const SITE_PINS_FILE = join('site', 'pins.json');

/**
 * The owner's signed site pins (`GET /api/site/pins`, `POST /api/admin/pins`), per chain. The server only keeps and
 * serves them: every browser checks the signature against the owner wallet it was built with, so what is stored here
 * cannot point a wallet anywhere the owner did not sign for.
 */
export class SitePinsStore {
  private data: Record<string, SitePinsRecord> = {};

  constructor(
    private readonly dataDir: string | null,
    private readonly log: (m: string) => void = () => {},
  ) {
    this.load();
  }

  private get path(): string | null {
    return this.dataDir ? join(this.dataDir, SITE_PINS_FILE) : null;
  }

  private load(): void {
    const p = this.path;
    if (!p || !existsSync(p)) return;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
      const next: Record<string, SitePinsRecord> = {};
      for (const [id, r] of Object.entries(raw ?? {})) {
        const rec = parseSitePinsRecord(r);
        if (rec && String(rec.chainId) === id) next[id] = rec;
      }
      this.data = next;
    } catch (err) {
      const backup = `${p}.corrupt-${Date.now()}`;
      try {
        renameSync(p, backup);
      } catch {
        /* ignore */
      }
      this.log(`site: ${SITE_PINS_FILE} is unreadable (${(err as Error).message}); moved to ${backup}`);
    }
  }

  private save(): void {
    const p = this.path;
    if (!p) return;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(`${p}.tmp`, JSON.stringify(this.data, null, 2));
    renameSync(`${p}.tmp`, p);
  }

  get(chainId: number | null): SitePinsRecord | null {
    if (chainId === null) return null;
    const r = this.data[String(chainId)];
    return r ? { ...r } : null;
  }

  set(record: SitePinsRecord): void {
    this.data[String(record.chainId)] = { ...record };
    this.save();
    this.log(`site: pins of chain ${record.chainId} signed at ${record.signedAt} (arena ${record.arena}, nft ${record.nft}, token ${record.token ?? 'none'})`);
  }
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean => (!a && !b) || (!!a && !!b && a.toLowerCase() === b.toLowerCase());

export interface SavePinsDeps {
  store: SitePinsStore;
  contracts: ContractsStore | null;
  /** The server's chain. */
  chainId: number | null;
  /** The registered arena's game token on chain (null: not set; undefined: cannot be read here, not checked). */
  arenaToken: (arena: Address) => Promise<string | null | undefined>;
  now: number;
}

/**
 * `POST /api/admin/pins`: stores the owner's signed pins of the server's chain. Refused unless the record names the
 * registered arena and NFT and the arena's game token (none while it is not set), was signed by the signed-in admin,
 * and is not older than the stored one. The browsers still check the signer against the owner wallet themselves.
 */
export async function savePins(deps: SavePinsDeps, body: Record<string, unknown>, admin: string): Promise<SitePinsRecord> {
  const rec = parseSitePinsRecord(body);
  if (!rec) throw bad('record', 'Send { chainId, arena, nft, token, signedAt, signature }: addresses as 0x…, signedAt as an ISO time, a 65-byte signature.');
  if (deps.chainId === null) throw new SiteFail(503, 'chain_off', 'The server has no chain yet.');
  if (rec.chainId !== deps.chainId) throw bad('chainId', `These pins are for chain ${rec.chainId}; the server is on chain ${deps.chainId}.`);
  const fields = { chainId: rec.chainId, arena: getAddress(rec.arena), nft: getAddress(rec.nft), token: rec.token ? getAddress(rec.token) : null, signedAt: rec.signedAt };
  const registry = deps.contracts?.effective(deps.chainId) ?? null;
  if (!same(registry?.arena?.address, fields.arena) || !same(registry?.nft?.address, fields.nft)) {
    throw new SiteFail(409, 'wrong_state', 'Sign the registered arena and NFT (the panel fills them in).', 'arena');
  }
  const token = await deps.arenaToken(fields.arena as Address);
  if (token !== undefined && !same(token, fields.token)) {
    throw new SiteFail(409, 'wrong_state', token ? `The arena's game token is ${getAddress(token)}: sign that one.` : "The arena's game token is not set yet: sign the pins without a token.", 'token');
  }
  if (Date.parse(fields.signedAt) > deps.now + 10 * 60_000) throw bad('signedAt', 'signedAt is in the future (check the computer clock).');
  const old = deps.store.get(deps.chainId);
  if (old && Date.parse(old.signedAt) > Date.parse(fields.signedAt)) throw new SiteFail(409, 'wrong_state', `Newer pins are stored already (signed at ${old.signedAt}).`, 'signedAt');
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message: sitePinsMessage(fields), signature: rec.signature as Hex });
  } catch {
    throw bad('signature', 'The signature does not belong to these pins.');
  }
  if (!same(signer, admin)) throw new SiteFail(403, 'not_owner', `The pins were signed by ${signer}, not by the signed-in admin ${admin}.`, 'signature');
  const record: SitePinsRecord = { ...fields, signature: rec.signature };
  deps.store.set(record);
  return record;
}
