import { GAS_SYMBOL } from '@elymum/shared';
import { describeCall, coinnibalArenaAbi, sendCall, type ContractCall, type DescribedArg } from '@elymum/sdk';
import { ownerRefusal } from '@elymum/sdk/ops';
import { formatEther, getAddress, type Abi, type Address, type Hash, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from 'viem';

/**
 * What the admin panel asks a wallet to sign: one contract call or one deploy. Every plan is
 * shown in the transaction preview (`TxPreview`) before the wallet opens; the preview runs the
 * owner and chain checks and guards against double clicks.
 */
export type DeployName = 'CoinnibalArena' | 'CoinnibalNFT' | 'TestToken';

export interface DeployParams {
  abi: Abi | readonly unknown[];
  bytecode: Hex;
  args: readonly unknown[];
}

export interface PlanResult {
  hash: Hash;
  receipt: TransactionReceipt;
  /** The new contract (deploys only). */
  address: Address | null;
}

export interface Plan {
  title: string;
  /** Contract name for the preview (`CoinnibalArena`, `CoinnibalNFT`, `ERC-20`). */
  contract: string;
  call?: ContractCall;
  deploy?: { name: DeployName; params: DeployParams };
  /** A plain gas-token transfer from the connected wallet (funding the server key). */
  transfer?: { to: Address; value: bigint };
  /** Owner-only call: this contract's `owner()` is re-read right before signing and must be the connected wallet. */
  ownerOf?: Address;
  /** The owner as last read (shown, and checked at once). */
  owner?: Address | null;
  /** Extra text above the buttons (warnings). */
  note?: string;
  /** Text the admin must type to enable the button (irreversible actions). */
  confirmText?: string;
  /** Runs after the receipt (register the contract, save a setting…); errors are shown, the transaction stays done. */
  onDone?: (r: PlanResult) => void | Promise<void>;
}

export interface PlanPreview {
  /** `setFeeBps(uint16)` or `constructor(address,address,address)`. */
  signature: string;
  functionName: string;
  /** Called contract (null for a deploy). */
  to: Address | null;
  args: DescribedArg[];
  value: bigint;
  valueText: string | null;
}

const show = (v: unknown): string =>
  typeof v === 'bigint' ? v.toString() : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/** Function, arguments (names, types, values) and value of a plan, from the ABI. */
export function previewOf(plan: Plan): PlanPreview {
  if (plan.call) {
    const d = describeCall(plan.call);
    return { signature: d.signature, functionName: d.functionName, to: d.to, args: d.args, value: d.value, valueText: d.valueText };
  }
  if (plan.deploy) {
    const abi = plan.deploy.params.abi as readonly { type: string; inputs?: readonly { name?: string; type: string }[] }[];
    const inputs = abi.find((i) => i.type === 'constructor')?.inputs ?? [];
    return {
      signature: `constructor(${inputs.map((i) => i.type).join(',')})`,
      functionName: `deploy ${plan.deploy.name}`,
      to: null,
      args: plan.deploy.params.args.map((a, i) => ({ name: inputs[i]?.name || `arg${i}`, type: inputs[i]?.type ?? 'unknown', value: show(a) })),
      value: 0n,
      valueText: null,
    };
  }
  if (plan.transfer) {
    const t = plan.transfer;
    return { signature: `transfer ${GAS_SYMBOL}`, functionName: `send ${GAS_SYMBOL}`, to: t.to, args: [], value: t.value, valueText: gasText(t.value) };
  }
  throw new TypeError('a plan needs a call, a deploy or a transfer');
}

/** `0.0312 ETH` for a wei value, in the chain's gas token (the preview shows the same text). */
export const gasText = (wei: bigint): string => `${formatEther(wei)} ${GAS_SYMBOL}`;

/**
 * The owner a deploy names: each bundled constructor (`CoinnibalArena(admin, …)`, `CoinnibalNFT(owner, …)`,
 * `TestToken(owner)`) takes it first. A deploy is a plain contract creation from the connected wallet (EOA CREATE,
 * no factory, no proxy), and that wallet must be this owner.
 */
export function deployOwner(d: NonNullable<Plan['deploy']>): Address | null {
  const a = d.params.args[0];
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? getAddress(a) : null;
}

/** Why a deploy may not be signed by `from` (null: it may): the deployer must be the owner it names. */
export function deployRefusal(d: NonNullable<Plan['deploy']>, from: Address): string | null {
  const owner = deployOwner(d);
  if (!owner) return `${d.name}: the deploy names no owner.`;
  if (owner.toLowerCase() !== from.toLowerCase()) return `${d.name} would be owned by ${owner}, but the wallet signing is ${from}. Close the preview and deploy again from the owner wallet.`;
  return null;
}

/** Why the preview cannot open the wallet (empty = it may): the chain blockers, then the owner check. */
export function planRefusals(plan: Plan, ctx: { me: Address | null; blockers: readonly string[] }): string[] {
  const out = [...ctx.blockers];
  if (!ctx.me) out.push('Connect the owner wallet first.');
  else if (plan.owner !== undefined && plan.owner !== null) {
    const r = ownerRefusal(plan.owner, ctx.me, plan.contract);
    if (r) out.push(`Owner check: ${r}.`);
  }
  if (ctx.me && plan.deploy) {
    const r = deployRefusal(plan.deploy, ctx.me);
    if (r) out.push(`Owner check: ${r}`);
  }
  return out;
}

/** The fresh `owner()` of an Ownable contract (both Elymum contracts share the function). */
export async function readOwner(client: Pick<PublicClient, 'readContract'>, contract: Address): Promise<Address> {
  return getAddress(await client.readContract({ address: contract, abi: coinnibalArenaAbi, functionName: 'owner' }));
}

/** What the wallet sends for a plan. */
export function sendPlan(plan: Plan, wallet: WalletClient, from: Address): Promise<Hash> {
  if (plan.call) return sendCall(wallet, plan.call, { account: from });
  if (plan.deploy) {
    // the account may have changed in the wallet since the preview was built: never deploy for another owner
    const refused = deployRefusal(plan.deploy, from);
    if (refused) return Promise.reject(new Error(refused));
    const p = plan.deploy.params;
    return wallet.deployContract({ abi: p.abi as Abi, bytecode: p.bytecode, args: p.args as unknown[], account: from, chain: wallet.chain } as never);
  }
  if (plan.transfer) {
    return wallet.sendTransaction({ to: plan.transfer.to, value: plan.transfer.value, account: from, chain: wallet.chain } as never);
  }
  return Promise.reject(new TypeError('a plan needs a call, a deploy or a transfer'));
}
