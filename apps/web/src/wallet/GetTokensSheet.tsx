import { Icon, Sheet } from '../design';
import { useT, type TKey } from '../i18n';
import { closeModal, useUi } from '../store';
import { useTokenText } from '../ui/lobby/useLobby';
import { TOKEN_BUY_URL, tokenSteps, type TokenStepKey } from './getTokens';
import { explorerAddress } from './links';
import { serverChainInfo } from './network';
import { PINS } from './pinned';
import './get-tokens.css';

const STEP_TEXT: Record<TokenStepKey, TKey> = {
  gasFaucet: 'gt.step.gasFaucet',
  gasBridge: 'gt.step.gasBridge',
  gasAny: 'gt.step.gasAny',
  testTokens: 'gt.step.testTokens',
  buy: 'gt.step.buy',
  play: 'gt.step.play',
};
const STEP_LINK: Partial<Record<TokenStepKey, TKey>> = {
  gasFaucet: 'gt.link.faucet',
  gasBridge: 'gt.link.bridge',
  testTokens: 'gt.link.testTokens',
  buy: 'gt.link.buy',
};

/** The token contract a player should see in the swap: the pinned one (the local node: whatever the server names). */
function tokenAddress(chainId: number | null | undefined, announced: string | null | undefined): string | null {
  if (chainId == null) return null;
  return PINS.chains[chainId]?.token ?? (announced || null);
}

/**
 * "How to get $ELYMUM" (modal `tokens`): ETH for gas, then the token (the testnet faucet page, or Pons on mainnet when
 * the build names it), then back to the ticket. Opened from the wallet sheets and from "Get $ELYMUM" when a ticket
 * costs more than the wallet holds.
 */
export function GetTokensSheet() {
  const t = useT();
  const open = useUi((s) => s.modal === 'tokens');
  const chain = useUi((s) => s.chain);
  const tok = useTokenText();
  const info = serverChainInfo(chain);
  const testnet = info?.testnet ?? chain?.testnet ?? true;
  const steps = tokenSteps({ testnet, faucetUrl: chain?.faucetUrl ?? info?.faucetUrl ?? null, bridgeUrl: info?.bridgeUrl ?? null, buyUrl: TOKEN_BUY_URL });
  const token = tokenAddress(chain?.chainId, chain?.token?.address);
  const tokenLink = token ? explorerAddress(token) : null;
  const vars = { sym: tok.symbol, chain: info?.name ?? '' };
  return (
    <Sheet open={open} onClose={closeModal} closeLabel={t('gt.close')} kicker={t('gt.kicker', vars)} title={t('gt.title', vars)} className="kl-sheet gt-sheet">
      <div className="gt-body" data-testid="get-tokens">
        <p className="gt-lede">{testnet ? t('gt.ledeTest', vars) : t('gt.lede', vars)}</p>
        <ol className="gt-steps">
          {steps.map((s, i) => {
            const label = STEP_LINK[s.key];
            return (
              <li key={s.key} className="gt-step">
                <span className="gt-step__n num" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="gt-step__t">
                  {t(s.key === 'buy' && !s.href ? 'gt.step.buyNoLink' : STEP_TEXT[s.key], vars)}
                  {s.href && label && (
                    <a className="kl-link mono gt-step__go" href={s.href} {...(s.external ? { target: '_blank', rel: 'noreferrer' } : {})}>
                      {t(label, vars)}
                      <Icon name="arrow" size={14} />
                    </a>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
        {token && (
          <p className="gt-token mono">
            {t('gt.token', vars)}{' '}
            {tokenLink ? (
              <a className="kl-link" href={tokenLink} target="_blank" rel="noreferrer">
                <code>{token}</code>
              </a>
            ) : (
              <code>{token}</code>
            )}
          </p>
        )}
      </div>
    </Sheet>
  );
}
