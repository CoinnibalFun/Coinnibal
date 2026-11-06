import { approveCall, formatGasAmount } from '@elymum/sdk';
import { useState } from 'react';
import { Button, Chip, CoinCharacter, Icon, Sheet, WalletPicker } from '../design';
import { useT } from '../i18n';
import { summaryAmount } from '../ui/amount';
import { closeModal, openModal, toast, useUi } from '../store';
import { useTokenText } from '../ui/lobby/useLobby';
import { refreshChain, useChainData, useReadClient } from './chain';
import { explorerAddress } from './links';
import { MoreWallets } from './MoreWallets';
import { ensureChain, serverChainInfo } from './network';
import { verifyArena } from './pinned';
import { signInWithWallet } from './signIn';
import { connectWallet, disconnectWallet, initWallets, useWallet } from './store';
import { APPROVE_BATCH_TICKETS } from './ticket';
import { sendWalletCall, txErrorText } from './tx';
import { describeError } from '@elymum/sdk';

/**
 * An allowance left from before approvals were exact (an "approve once" was unlimited): more than any ticket batch of
 * the dearest arena could need. Such a wallet is offered to set it back to zero.
 */
export function allowanceTooHigh(allowance: bigint | null, entryFees: readonly bigint[]): boolean {
  if (allowance === null || allowance === 0n) return false;
  const top = entryFees.reduce((m, f) => (f > m ? f : m), 0n);
  return top > 0n && allowance > top * BigInt(APPROVE_BATCH_TICKETS);
}

/**
 * Wallet sheet. Disconnected: the EVM wallets found in the browser (EIP-6963: MetaMask, Rabby or
 * any browser wallet). Connected: address, $ELYMUM and gas-token balances, the network (with a switch
 * when the wallet is on another chain), the free sign-in signature, explorer and disconnect.
 */
export function WalletModal() {
  const t = useT();
  const open = useUi((s) => s.modal === 'wallet');
  const providers = useWallet((s) => s.providers);
  const current = useWallet((s) => s.current);
  const status = useWallet((s) => s.status);
  const walletChain = useWallet((s) => s.chainId);
  const walletError = useWallet((s) => s.error);
  const wei = useChainData((s) => s.balance);
  const tokens = useChainData((s) => s.tokenBalance);
  const allowance = useChainData((s) => s.allowance);
  const arenas = useChainData((s) => s.arenas);
  const token = useChainData((s) => s.config?.token ?? null);
  const client = useReadClient();
  const auth = useUi((s) => s.auth);
  const chain = useUi((s) => s.chain);
  const tok = useTokenText();
  const soon = !!chain?.enabled && chain.tokenReady === false;
  const [busy, setBusy] = useState(false);

  const addr = useWallet((s) => (s.status === 'connected' ? s.address : null));
  const verified = !!addr && !!auth && auth.address.toLowerCase() === addr.toLowerCase();
  const info = serverChainInfo(chain);
  const wrongChain = !!addr && !!info && walletChain !== null && walletChain !== info.id;
  const explorer = addr ? explorerAddress(addr) : null;

  if (open) initWallets();

  const switchChain = async () => {
    if (!current || !chain) return;
    setBusy(true);
    try {
      await ensureChain(current.provider, chain);
    } catch (err) {
      const e = describeError(err, { chainName: info?.name });
      // a declined switch: say what is needed, not just "cancelled"
      toast(e.kind === 'rejected' ? 'warn' : 'error', e.kind === 'rejected' ? t('tf.err.SwitchRejected') : txErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const highAllowance = allowanceTooHigh(allowance, arenas.map((a) => a.entryFee));
  /** Sets the arena's allowance back to zero (to the pinned arena only). */
  const revoke = async () => {
    if (!chain || !client || !token || !chain.arenaAddress) return;
    setBusy(true);
    try {
      const pin = await verifyArena(client, chain.chainId, { arena: chain.arenaAddress, token });
      if (!pin.ok) {
        toast('error', t('tf.err.ContractMismatch'));
        return;
      }
      const res = await sendWalletCall(approveCall(token, pin.arena, 0n), { chain });
      if (res.ok) toast('success', t('wl.revoked'));
      else toast(res.error.kind === 'rejected' ? 'warn' : 'error', txErrorText(res.error));
      refreshChain();
    } finally {
      setBusy(false);
    }
  };
  const openTokens = () => openModal('tokens');

  if (!addr) {
    return (
      <WalletPicker
        open={open}
        onClose={closeModal}
        title={t('wl.choose')}
        kicker={t('wl.kickerConnect')}
        closeLabel={t('wl.close')}
        wallets={providers.map((d) => ({ id: d.info.uuid, name: d.info.name, icon: d.info.icon || undefined, detected: true }))}
        busyId={status === 'connecting' ? (current?.info.uuid ?? null) : null}
        onPick={(id) => {
          const d = providers.find((p) => p.info.uuid === id);
          if (d) void connectWallet(d).then((a) => a && closeModal());
        }}
        error={walletError ?? undefined}
        extra={<MoreWallets chain={chain} hasInjected={providers.length > 0} onConnected={closeModal} onGetTokens={openTokens} sym={tok.symbol} />}
        empty={
          <>
            {t('wl.none')}{' '}
            <span className="wl-install">
              <a className="kl-link mono" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
                {t('wl.install')}
              </a>
              <a className="kl-link mono" href="https://rabby.io/" target="_blank" rel="noreferrer">
                Rabby
              </a>
            </span>
          </>
        }
        footnote={t('wl.footnote')}
      />
    );
  }

  return (
    <Sheet
      open={open}
      onClose={closeModal}
      closeLabel={t('wl.close')}
      kicker={t('wl.kicker')}
      title={current?.info.name ?? t('wl.kicker')}
      className="kl-sheet wl-sheet"
      footer={
        <Button
          variant="secondary"
          size="md"
          onClick={() => {
            disconnectWallet();
            closeModal();
          }}
        >
          {t('wl.disconnect')}
        </Button>
      }
    >
      <div className="wl-body">
        <div className="wl-card">
          <span className="wl-card__coin" aria-hidden="true">
            <CoinCharacter paint="cyan" mood={verified ? 'happy' : 'smile'} size={56} />
          </span>
          <div className="wl-addr">
            <span className="mono wl-cap">{t('wl.address')}</span>
            <code className="wl-addr__full">{addr}</code>
            <span className="wl-addr__actions">
              <Chip
                icon="docs"
                onClick={() => {
                  void navigator.clipboard?.writeText(addr).then(() => toast('success', t('wl.copied')));
                }}
              >
                {t('wl.copy')}
              </Chip>
              {explorer && (
                <a className="kl-link mono" href={explorer} target="_blank" rel="noreferrer">
                  {t('wl.explorer')}
                </a>
              )}
            </span>
          </div>
        </div>
        <dl className="wl-bal">
          <div className="wl-bal__tok">
            <dt className="mono wl-cap">{t('wl.tokens')}</dt>
            <dd>
              {soon ? (
                <span className="mono">{t('wl.tokenSoonLong')}</span>
              ) : (
                <>
                  <span className="wl-bal__big num" title={tokens === null ? undefined : `${tok.exact(tokens)} ${tok.symbol}`}>{tokens === null ? '…' : summaryAmount(tokens, tok.decimals)}</span> <span className="mono">{tok.symbol}</span>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt className="mono wl-cap">{t('wl.hype')}</dt>
            <dd>
              <span className="wl-bal__mid num">{wei === null ? '…' : formatGasAmount(wei, 4)}</span>
            </dd>
          </div>
          <div>
            <dt className="mono wl-cap">{t('wl.network')}</dt>
            <dd className="mono">{info?.name ?? '—'}</dd>
          </div>
        </dl>
        {wrongChain && (
          <div className="wl-verify" data-testid="wl-wrong-chain">
            <p className="kl-note">{t('wl.wrongChain', { chain: info!.name })}</p>
            <Button variant="teal" size="md" lead="arrow" disabled={busy} onClick={() => void switchChain()}>
              {t('wl.switch', { chain: info!.name })}
            </Button>
          </div>
        )}
        {highAllowance && (
          <div className="wl-verify" data-testid="wl-allowance">
            <p className="kl-note">{t('wl.allowance', { sym: tok.symbol })}</p>
            <Button variant="secondary" size="md" disabled={busy} onClick={() => void revoke()}>
              {t('wl.revoke')}
            </Button>
          </div>
        )}
        {!soon && (
          <button type="button" className="kl-link mono wl-gettokens" onClick={openTokens}>
            {t('wl.getTokens', { sym: tok.symbol })}
          </button>
        )}
        {verified ? (
          <p className="wl-ok mono">
            <Icon name="check" size={16} /> {t('wl.verified')}
          </p>
        ) : (
          <div className="wl-verify">
            <p className="kl-note">{t('wl.verifyNote')}</p>
            <Button
              variant="teal"
              size="md"
              lead="key"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await signInWithWallet(true);
                setBusy(false);
              }}
            >
              {t('wl.verify')}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
