import {
  DEFAULT_HOLDERS_ONLY_ARENA_IDS,
  SUGGESTED_HOLDER_BURN_BPS,
  SUGGESTED_HOLDER_VAULT_BPS,
  createDefaultArenaCalls,
  sameAddress,
  setArenaHoldersOnlyCall,
  setHolderNftCall,
  setHolderPerksCall,
  setPhaseCall,
  setTokenCall,
  type ContractCall,
} from '@coinnibal/sdk';
import { bpsToPercent, type ContractsRegistry } from '@coinnibal/shared';
import { arenaName, type StatusSnapshot } from '@coinnibal/sdk/ops';
import { getAddress, type Address } from 'viem';

/** True when the arena's holder pair is not the owner's (8 % burned + 2 % to the fee wallet, as the site tells holders). */
export function holderPairDrifted(cfg: { holderBurnBps?: number; holderVaultBps?: number }): boolean {
  return cfg.holderBurnBps !== SUGGESTED_HOLDER_BURN_BPS || cfg.holderVaultBps !== SUGGESTED_HOLDER_VAULT_BPS;
}

/**
 * The game token the faucet still waits for (pure, tested): `/faucet` hands out the token registered with the server
 * (`GET /api/site/faucet` reads the registry, never the arena), so on a testnet the arena's game token must be the
 * registered one too. Registering it takes no signature (`POST /api/admin/contracts`). null when it is, on mainnet,
 * before the token is set, or while the registry is not read.
 */
export function faucetTokenToRegister(i: { testnet: boolean; status: StatusSnapshot | null; registry: ContractsRegistry | null | undefined }): Address | null {
  const token = i.status?.arena?.config?.token ?? null;
  if (!i.testnet || !token || !i.registry || sameAddress(i.registry.token?.address ?? null, token)) return null;
  return getAddress(token);
}

/**
 * A testnet without a registered TestToken: Finish setup has no token to set (`setupSteps` adds the token step only
 * once one is registered). The launch checklist and Setup → Advanced say so.
 */
export const NO_TEST_TOKEN_YET = 'Deploy the contracts deploys a test token and sets it (by hand: the TestToken card in Setup, then Finish setup).';

/** One step of the setup: what it does, and the call the owner's wallet signs. */
export interface SetupStep {
  id: string;
  label: string;
  call: ContractCall;
}

/**
 * What is still missing for a playable chain, in order: the game token on the arena, the four
 * arenas, the emblem as the faucet's 2x and as the arena's holder perk (the owner's holder pair: 8 % burned +
 * 2 % to the fee wallet, against the normal 15 % + 5 %; offered again when the live pair drifted from it), the $10 Room as holders-only, and (testnet) the mint opened to the public. Steps already
 * done on chain are left out, so the button can be pressed again after an interruption.
 */
export function setupSteps(ctx: { status: StatusSnapshot | null }, opts: { openMint: boolean }): SetupStep[] {
  const s = ctx.status;
  const arena = s?.arena?.address ?? null;
  const cfg = s?.arena?.config ?? null;
  const nft = s?.nft?.address ?? null;
  const tt = s?.testToken ?? null;
  const out: SetupStep[] = [];
  if (!arena || !cfg) return out;
  const token = (cfg.token ?? tt?.address ?? null) as Address | null;
  if (!cfg.token && tt?.address) out.push({ id: 'token', label: 'Set TEST as the game token', call: setTokenCall(arena, tt.address) });
  if (token) {
    const decimals = s?.arena?.token?.decimals ?? 18;
    const existing = (s?.arena?.arenas ?? []).filter((a) => a.exists).map((a) => a.id);
    for (const call of createDefaultArenaCalls(arena, decimals, existing)) {
      const id = Number((call.args as readonly unknown[])[0]);
      out.push({ id: `arena-${id}`, label: `Create ${arenaName(id)}`, call });
    }
  }
  if (tt?.address && nft && !sameAddress(tt.faucet?.holderNft ?? null, nft)) out.push({ id: 'faucet-nft', label: 'NFT holders get 2x from the faucet', call: setHolderNftCall(tt.address, nft) });
  // the holder perk: missing (or on another NFT), or on the right NFT with a pair that drifted from the owner's
  // (the site tells holders 8 % + 2 %): either way one call sets the NFT and the owner's pair
  const holderNft = (cfg.holderNft ?? null) as Address | null;
  const perksNft = nft && !sameAddress(holderNft, nft) ? nft : holderNft && holderPairDrifted(cfg) ? holderNft : null;
  if (perksNft) {
    const holder = { burnBps: SUGGESTED_HOLDER_BURN_BPS, vaultBps: SUGGESTED_HOLDER_VAULT_BPS };
    const label = `NFT holders pay ${bpsToPercent(holder.burnBps + holder.vaultBps)} % of profit instead of ${bpsToPercent(cfg.burnBps + cfg.vaultBps)} %`;
    out.push({ id: 'perks', label, call: setHolderPerksCall(arena, perksNft, holder) });
  }
  if (nft) {
    const known = new Map((s?.arena?.arenas ?? []).map((a) => [a.id, a]));
    for (const id of DEFAULT_HOLDERS_ONLY_ARENA_IDS) {
      const a = known.get(id);
      // created in this run, or existing but still open to everyone
      if ((!a || !a.exists) && token) out.push({ id: `holders-${id}`, label: `${arenaName(id)}: NFT holders only`, call: setArenaHoldersOnlyCall(arena, id, true) });
      else if (a && a.exists && !a.holdersOnly) out.push({ id: `holders-${id}`, label: `${arenaName(id)}: NFT holders only`, call: setArenaHoldersOnlyCall(arena, id, true) });
    }
  }
  if (opts.openMint && nft && s?.nft?.state && s.nft.state.phaseName !== 'public') out.push({ id: 'mint', label: "Open the testnet NFT mint to every wallet (CoinnibalNFT.setPhase(public)): anyone can mint on chain right after this, even while the site's mint page is closed", call: setPhaseCall(nft, 'public') });
  return out;
}
