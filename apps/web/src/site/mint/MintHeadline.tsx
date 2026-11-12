import { useT } from '../../i18n';
import type { PriceStory } from './logic';

/**
 * The headline and lede, plain about the price: the mint card reads the real price from the contract, so the copy
 * makes no dollar claim. On a testnet it says it is a test mint paid in free test ETH (and that mainnet is cheaper).
 */
export function MintHeadline({ story, price }: { story: PriceStory; price: string | null }) {
  const t = useT();
  return (
    <>
      <h1 className="mt-h display" data-story={story}>
        {t('mn.h')}
      </h1>
      {story === 'testnet' ? (
        <>
          <p className="mt-lede">{price ? t('mn.lede.testPrice', { price }) : t('mn.lede.test')}</p>
          <p className="mt-note" data-testid="mt-mainnet-note">
            {t('mn.mainnetNote')}
          </p>
        </>
      ) : (
        <p className="mt-lede">{t('mn.lede')}</p>
      )}
      <a href="#why-nft" className="mt-whylink" data-testid="mt-why-link">
        {t('ld.cta.why')}
      </a>
    </>
  );
}
