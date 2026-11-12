import {
  CUSTOM_SETTINGS_DEFAULT,
  DEFAULT_ARENAS,
  DEFAULT_FEE_RATES,
  DEFAULT_HOLDER_FEE_RATES,
  SHOP_DEFAULTS,
  bpsToPercent,
  formatUsdCents,
  totalFeeBps,
} from '@elymum/shared';
import type { ReactNode } from 'react';
import { CoinCharacter, Icon, Laurel, type CoinPaint, type IconName } from '../../design';
import { useT, type TKey } from '../../i18n';
import './why-nft.css';

/**
 * How many times the test tokens an NFT holder claims from the testnet faucet (`TestToken.holderAmount` over
 * `amount`; Finish setup sets 2,000,000 against 1,000,000). The faucet page reads the live multiple from the chain.
 */
export const FAUCET_HOLDER_X = 2;

/** The holder perks as the game configures them (shared defaults), with any live values the page knows. */
export interface NftPerkValues {
  /** Fee on profit, percent: everyone / holders, and the holders' split. */
  fee: { normal: string; holder: string; burn: string; team: string };
  /** The holders-only room's ticket price ("$10"), or null when no default arena is holders-only. */
  room: string | null;
  /** Power-up shop: holder discount (percent) and the extra uses a paid round. */
  shopPct: number;
  shopExtra: number;
  /** Private rooms: one free a day, or a discount (percent). */
  privateRoom: { perk: 'free_daily' | 'discount' | 'none'; pct: number };
  faucetX: number;
}

const pct = (bps: number) => `${bpsToPercent(bps)}%`;

/** The configured holder perks (`DEFAULT_HOLDER_FEE_RATES`, `DEFAULT_ARENAS`, `SHOP_DEFAULTS`, the private-room defaults). */
export function configuredPerks(live: { shopPct?: number | null; room?: { perk: 'free_daily' | 'discount' | 'none'; pct: number } | null } = {}): NftPerkValues {
  const holdersRoom = DEFAULT_ARENAS.find((a) => a.holdersOnly);
  return {
    fee: {
      normal: pct(totalFeeBps(DEFAULT_FEE_RATES)),
      holder: pct(totalFeeBps(DEFAULT_HOLDER_FEE_RATES)),
      burn: pct(DEFAULT_HOLDER_FEE_RATES.burnBps),
      team: pct(DEFAULT_HOLDER_FEE_RATES.vaultBps),
    },
    room: holdersRoom ? formatUsdCents(holdersRoom.usdCents).replace(/\.00$/, '') : null,
    shopPct: live.shopPct != null && live.shopPct > 0 ? live.shopPct : SHOP_DEFAULTS.holderDiscountPct,
    shopExtra: SHOP_DEFAULTS.holderExtraArenaUses,
    privateRoom: live.room && live.room.perk !== 'none' ? live.room : { perk: CUSTOM_SETTINGS_DEFAULT.holderPerk, pct: CUSTOM_SETTINGS_DEFAULT.holderDiscountPct },
    faucetX: FAUCET_HOLDER_X,
  };
}

interface Card {
  id: 'fee' | 'room' | 'shop' | 'private' | 'skin' | 'faucet';
  icon: IconName;
  paint: CoinPaint;
  big: string;
  title: string;
  note: string;
}

/** The six holder perks as cards (the faucet one only where test tokens exist, or while the network is unknown). */
export function perkCards(v: NftPerkValues, t: (k: TKey, vars?: Record<string, string | number>) => string, testnet: boolean | null): Card[] {
  const cards: Card[] = [
    { id: 'fee', icon: 'flame', paint: 'sun', big: v.fee.holder, title: t('nf.fee.t', { holder: v.fee.holder, normal: v.fee.normal }), note: t('nf.fee.n', { burn: v.fee.burn, team: v.fee.team }) },
  ];
  if (v.room) cards.push({ id: 'room', icon: 'crown', paint: 'up', big: v.room, title: t('nf.room.t', { price: v.room }), note: t('nf.room.n') });
  cards.push({ id: 'shop', icon: 'bag', paint: 'coral', big: `-${v.shopPct}%`, title: t('nf.shop.t', { pct: v.shopPct }), note: t('nf.shop.n', { extra: v.shopExtra }) });
  if (v.privateRoom.perk === 'free_daily') cards.push({ id: 'private', icon: 'users', paint: 'cyan', big: '1/day', title: t('nf.free.t'), note: t('nf.free.n') });
  else if (v.privateRoom.perk === 'discount') cards.push({ id: 'private', icon: 'users', paint: 'cyan', big: `-${v.privateRoom.pct}%`, title: t('nf.freeDiscount.t', { pct: v.privateRoom.pct }), note: t('nf.free.n') });
  cards.push({ id: 'skin', icon: 'user', paint: 'teal', big: 'NFT', title: t('nf.skin.t'), note: t('nf.skin.n') });
  if (testnet !== false) cards.push({ id: 'faucet', icon: 'download', paint: 'foam', big: `${v.faucetX}x`, title: t('nf.faucet.t', { n: v.faucetX }), note: t('nf.faucet.n', { n: v.faucetX }) });
  return cards;
}

/**
 * "Why get the NFT?": every holder perk as a small card with a picture (landing and mint page). The numbers are the
 * game's configured holder perks; the note says the live fee is always on the ticket (a testnet contract can lag
 * behind the configured perks).
 */
export function WhyNft({ values, testnet, tone = 'night', heading, id = 'why-nft', children }: { values?: NftPerkValues; testnet: boolean | null; tone?: 'night' | 'paper'; heading?: ReactNode; id?: string; children?: ReactNode }) {
  const t = useT();
  const cards = perkCards(values ?? configuredPerks(), t, testnet);
  return (
    <section className={`nf-why nf-why--${tone}`} id={id} aria-labelledby={`${id}-h`} data-testid="why-nft">
      <header className="nf-why__head">
        <p className="kicker nf-why__kicker">{t('nf.kicker')}</p>
        <h2 className="nf-why__h" id={`${id}-h`}>
          {heading ?? t('ld.cta.why')}
        </h2>
      </header>
      <ul className="nf-why__grid">
        {cards.map((c) => (
          <li key={c.id} className="nf-card" data-perk={c.id}>
            <span className="nf-card__art" aria-hidden="true">
              <CoinCharacter paint={c.paint} mood={c.id === 'fee' ? 'happy' : c.id === 'room' ? 'smug' : 'smile'} size={64} />
              <span className="nf-card__icon">{c.id === 'skin' ? <Laurel size={18} /> : <Icon name={c.icon} size={18} />}</span>
            </span>
            <span className="nf-card__big num" aria-hidden="true">
              {c.big}
            </span>
            <strong className="nf-card__t">{c.title}</strong>
            <span className="nf-card__n">{c.note}</span>
          </li>
        ))}
      </ul>
      <p className="nf-why__note">{t('nf.note')}</p>
      {children}
    </section>
  );
}
