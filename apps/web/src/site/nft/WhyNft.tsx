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
import type { CSSProperties, ReactNode } from 'react';
import { CoinCharacter, Laurel } from '../../design';
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

/** One line of the tale of the tape: what a coin gets without the NFT and with it. */
export interface PerkRow {
  id: 'fee' | 'room' | 'shop' | 'uses' | 'private' | 'skin';
  label: string;
  without: string;
  with: string;
  /** A short line under the holder's value (the holder fee's split). */
  note?: string;
}

/**
 * The holder perks as a comparison, row by row, with the values the game configures (the test faucet is not one of
 * them: visitor pages do not talk about the test network). The "without" side is what the guide's table says.
 */
export function perkRows(v: NftPerkValues, t: (k: TKey, vars?: Record<string, string | number>) => string): PerkRow[] {
  const base = SHOP_DEFAULTS.arenaUsesPerRound;
  const rows: PerkRow[] = [{ id: 'fee', label: t('nf.fee.l'), without: v.fee.normal, with: v.fee.holder, note: t('nf.fee.n', { burn: v.fee.burn, team: v.fee.team }) }];
  if (v.room) rows.push({ id: 'room', label: t('nf.room.l', { price: v.room }), without: t('nf.room.no'), with: t('nf.room.yes') });
  rows.push({ id: 'shop', label: t('nf.shop.l'), without: t('nf.shop.no'), with: t('nf.shop.yes', { pct: v.shopPct }) });
  rows.push({ id: 'uses', label: t('nf.uses.l'), without: String(base), with: String(base + v.shopExtra) });
  if (v.privateRoom.perk === 'free_daily') rows.push({ id: 'private', label: t('nf.private.l'), without: t('nf.private.no'), with: t('nf.private.free') });
  else if (v.privateRoom.perk === 'discount') rows.push({ id: 'private', label: t('nf.private.l'), without: t('nf.private.no'), with: t('nf.private.off', { pct: v.privateRoom.pct }) });
  rows.push({ id: 'skin', label: t('nf.skin.l'), without: t('nf.skin.no'), with: t('nf.skin.yes') });
  return rows;
}

/**
 * "Why get the NFT?" as a tale of the tape (landing and mint page): the same coin twice, without the NFT and with it,
 * and between them what changes, row by row. It is a real table: the coins and the "vs" are pictures (hidden from
 * assistive tech), the column heads name the two sides, each row's head names the perk. The numbers are the game's
 * configured holder perks; the note says every ticket shows its fee (a testnet contract can lag behind the configured
 * perks). `level`: its heading's rank (3 under the landing's NFT section, 2 on a page of its own).
 */
export function WhyNft({ values, testnet: _testnet, tone = 'night', heading, id = 'why-nft', level = 2, children }: { values?: NftPerkValues; testnet: boolean | null; tone?: 'night' | 'paper'; heading?: ReactNode; id?: string; level?: 2 | 3; children?: ReactNode }) {
  const t = useT();
  const rows = perkRows(values ?? configuredPerks(), t);
  const H = level === 3 ? 'h3' : 'h2';
  return (
    <section className={`nf-why nf-why--${tone}`} id={id} aria-labelledby={`${id}-h`} data-testid="why-nft">
      <H className="nf-why__h" id={`${id}-h`}>
        {heading ?? t('ld.cta.why')}
      </H>
      <table className="nf-tape">
        <thead>
          <tr>
            <th scope="col" className="nf-tape__side is-plain">
              <span className="nf-tape__coin" aria-hidden="true">
                <CoinCharacter paint="cyan" mood="scared" size={88} look={[3, -1]} sweat feet ground blink={false} />
                <span className="nf-tape__name">{t('nf.you')}</span>
              </span>
              <span className="nf-tape__who">{t('nf.without')}</span>
            </th>
            <td className="nf-tape__mid" aria-hidden="true">
              <span className="nf-tape__vs">vs</span>
            </td>
            <th scope="col" className="nf-tape__side is-holder">
              <span className="nf-tape__coin" aria-hidden="true">
                <CoinCharacter paint="sun" mood="smug" size={104} look={[-3, 0]} feet ground />
                <span className="nf-tape__name">
                  <Laurel size={14} />
                  {t('nf.you')}
                </span>
              </span>
              <span className="nf-tape__who">{t('nf.with')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className="nf-row" data-perk={r.id} style={{ '--rv-n': i } as CSSProperties}>
              <td className="nf-row__was">{r.without}</td>
              <th scope="row" className="nf-row__what">
                {r.label}
              </th>
              <td className="nf-row__now">
                <span className="nf-row__v">{r.with}</span>
                {r.note && <small className="nf-row__note">{r.note}</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="nf-why__note">{t('nf.note')}</p>
      {children}
    </section>
  );
}
