import { Icon } from '../design';
import { useT } from '../i18n';
import { openModal } from '../store';
import { useTokenText } from '../ui/lobby/useLobby';

/** "Get tokens": under a ticket the wallet cannot pay for; opens "How to get tokens" (`GetTokensSheet`). */
export function GetTokensLink({ className }: { className?: string }) {
  const t = useT();
  const tok = useTokenText();
  return (
    <button type="button" className={`kl-link mono kl-gettokens${className ? ` ${className}` : ''}`} onClick={() => openModal('tokens')} data-testid="get-tokens-link">
      <Icon name="coin" size={16} />
      {t('lo.getTokens', { sym: tok.symbol })}
    </button>
  );
}
