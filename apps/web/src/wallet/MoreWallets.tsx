import { useEffect, useRef, useState } from 'react';
import { Button, Icon } from '../design';
import { useT } from '../i18n';
import { isPhoneBrowser, walletLinks } from './deeplinks';
import { connectWallet } from './store';
import { WC_PROJECT_ID, pairWalletConnect } from './walletconnect';
import type { ServerChain } from './network';
import './more-wallets.css';

/**
 * Under the list of browser wallets: the ways in for a player without one. On a phone, links that open this page in
 * a wallet app's own browser (MetaMask, Coinbase Wallet; Rabby through WalletConnect or as a download); WalletConnect
 * when the build has a project id (a QR code on a desktop, the wallet app on a phone); and, once a wallet is there,
 * "How to get $NIBAL".
 */
export function MoreWallets({
  chain,
  hasInjected,
  onConnected,
  onGetTokens,
  sym,
}: {
  /** The server's chain (WalletConnect asks for exactly it); null while unknown. */
  chain: (ServerChain & { rpcUrl: string | null }) | null;
  /** The browser already has a wallet (no deep links then). */
  hasInjected: boolean;
  onConnected?: () => void;
  /** Opens "How to get $NIBAL" (omitted: not offered). */
  onGetTokens?: () => void;
  sym: string;
}) {
  const t = useT();
  const phone = isPhoneBrowser();
  const links = phone && !hasInjected ? walletLinks(window.location.href, { walletConnect: !!WC_PROJECT_ID }) : [];
  return (
    <div className="mw" data-testid="more-wallets">
      {links.length > 0 && (
        <div className="mw-links">
          <p className="mw-note">{t('wl.mobile')}</p>
          <div className="mw-row">
            {links.map((l) => (
              <a key={l.id} className="mw-link" href={l.href} {...(l.opensHere ? {} : { target: '_blank', rel: 'noreferrer' })} data-wallet={l.id}>
                <Icon name={l.opensHere ? 'arrow' : 'wallet'} size={16} />
                <span>{l.opensHere ? t('wl.openIn', { name: l.name }) : t('wl.getApp', { name: l.name })}</span>
              </a>
            ))}
          </div>
        </div>
      )}
      {WC_PROJECT_ID && chain?.chainId != null && <WalletConnectButton chainId={chain.chainId} rpcUrl={chain.rpcUrl} phone={phone} onConnected={onConnected} />}
      {onGetTokens && (
        <button type="button" className="mw-tokens kl-link mono" onClick={onGetTokens}>
          {t('wl.getTokens', { sym })}
        </button>
      )}
    </div>
  );
}

/** WalletConnect: pair, show the QR code (desktop) or a link to the wallet app (phone), connect. */
function WalletConnectButton({ chainId, rpcUrl, phone, onConnected }: { chainId: number; rpcUrl: string | null; phone: boolean; onConnected?: () => void }) {
  const t = useT();
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'pairing'; uri: string | null; svg: string | null } | { kind: 'failed' }>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setState({ kind: 'pairing', uri: null, svg: null });
    try {
      // the QR renderer is only fetched for a pairing (the WalletConnect library itself is loaded by `pairWalletConnect`)
      const { renderSVG } = await import('uqr');
      const detail = await pairWalletConnect({
        chainId,
        rpcUrl,
        signal: ctl.signal,
        onUri: (uri) => {
          if (!ctl.signal.aborted) setState({ kind: 'pairing', uri, svg: phone ? null : renderSVG(uri, { border: 1 }) });
        },
      });
      if (ctl.signal.aborted) return;
      const address = await connectWallet(detail);
      setState({ kind: address ? 'idle' : 'failed' });
      if (address) onConnected?.();
    } catch (err) {
      if (!ctl.signal.aborted) {
        console.warn('walletconnect failed', err);
        setState({ kind: 'failed' });
      }
    }
  };

  if (state.kind === 'pairing') {
    return (
      <div className="mw-wc is-pairing" data-testid="wc-pairing">
        {state.svg && <span className="mw-wc__qr" role="img" aria-label={t('wl.wcQr')} dangerouslySetInnerHTML={{ __html: state.svg }} />}
        {phone && state.uri && (
          <a className="mw-link" href={state.uri}>
            <Icon name="arrow" size={16} />
            <span>{t('wl.wcOpen')}</span>
          </a>
        )}
        <p className="mw-note">{state.uri ? (phone ? t('wl.wcPhone') : t('wl.wcScan')) : t('wl.wcStarting')}</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            abort.current?.abort();
            setState({ kind: 'idle' });
          }}
        >
          {t('tf.cancel')}
        </Button>
      </div>
    );
  }
  return (
    <div className="mw-wc">
      <Button variant="secondary" size="md" lead="wallet" onClick={() => void start()} data-testid="wc-start">
        {t('wl.wc')}
      </Button>
      {state.kind === 'failed' && (
        <p className="mw-note is-error" role="alert">
          {t('wl.wcFailed')}
        </p>
      )}
    </div>
  );
}
