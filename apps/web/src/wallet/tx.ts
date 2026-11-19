import { describeError, sendCall, type ContractCall, type DescribedError } from '@coinnibal/sdk';
import type { Address, Hash, PublicClient, TransactionReceipt, WalletClient } from 'viem';
import { t } from '../i18n';
import type { Eip1193Provider } from './eip6963';
import { ensureChain, publicClientFor, serverChainInfo, walletClientFor, WrongChainError, type ServerChain } from './network';
import { connected } from './store';

/** `switching`: asking the wallet for the server's chain; `signing`: the wallet prompt is open; `confirming`: sent, waiting for the receipt. */
export type TxPhase = 'switching' | 'signing' | 'confirming';

export type TxResult = { ok: true; hash: Hash; receipt: TransactionReceipt } | { ok: false; error: DescribedError; hash: Hash | null };

export interface SendOpts {
  /** The server's chain: the wallet is switched to it first. */
  chain: ServerChain;
  onPhase?: (phase: TxPhase, hash?: Hash) => void;
  /** Overrides (tests, the admin panel's own wallet); default: the connected wallet. */
  wallet?: { provider: Eip1193Provider; address: Address } | null;
  /** Gas limit to send with (default: the wallet estimates it). */
  gas?: bigint;
  /** Read client for the receipt; default `publicClientFor(chain, provider)`. */
  publicClient?: PublicClient | null;
}

const noWallet = (): TxResult => ({ ok: false, hash: null, error: { kind: 'unknown', name: 'NoWallet', args: [], code: null, message: t('tf.err.NoWallet') } });

/**
 * Switches the wallet to the server's chain, has it send what `send` builds, and waits for the
 * receipt on the server's RPC. Never throws and never toasts: the caller shows the outcome where
 * the person is looking. A reverted receipt is a failure.
 */
export async function sendWithWallet(send: (wallet: WalletClient, from: Address) => Promise<Hash>, opts: SendOpts): Promise<TxResult> {
  const w = opts.wallet === undefined ? connected() : opts.wallet;
  if (!w) return noWallet();
  const chainName = serverChainInfo(opts.chain)?.name;
  let hash: Hash | null = null;
  let switching = true;
  try {
    opts.onPhase?.('switching');
    await ensureChain(w.provider, opts.chain);
    switching = false;
    const wallet = walletClientFor(w.provider, w.address, opts.chain);
    opts.onPhase?.('signing');
    hash = await send(wallet, w.address);
    opts.onPhase?.('confirming', hash);
    const reader = opts.publicClient ?? publicClientFor(opts.chain, w.provider);
    if (!reader) throw new Error('No RPC to read the receipt from.');
    const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== 'success') {
      return { ok: false, hash, error: { kind: 'revert', name: 'Reverted', args: [], code: null, message: t('api.reverted') } };
    }
    return { ok: true, hash, receipt };
  } catch (err) {
    const described: DescribedError =
      err instanceof WrongChainError ? { kind: 'wrong-chain', name: 'WrongChain', args: [], code: null, message: err.message } : describeError(err, { chainName });
    // the player declined the network switch: say what is needed ("Switch to Robinhood Chain to continue"), not "cancelled"
    const error: DescribedError = switching && described.kind === 'rejected' ? { ...described, kind: 'wrong-chain', name: 'SwitchRejected' } : described;
    if (error.kind !== 'rejected') console.warn('transaction failed', err);
    return { ok: false, error, hash };
  }
}

/** `sendWithWallet` for a contract call of the SDK. */
export function sendWalletCall(call: ContractCall, opts: SendOpts): Promise<TxResult> {
  return sendWithWallet((wallet, from) => sendCall(wallet, call, { account: from, ...(opts.gas !== undefined ? { gas: opts.gas } : {}) }), opts);
}

/** Translated, player-facing text for a failed transaction (SDK English as the fallback). */
export function txErrorText(error: Pick<DescribedError, 'name' | 'message' | 'kind'>): string {
  const key = error.kind === 'rejected' ? 'tf.err.UserRejected' : `tf.err.${error.name ?? ''}`;
  const text = t(key as 'tf.err.NoWallet');
  return text === key ? error.message : text;
}
