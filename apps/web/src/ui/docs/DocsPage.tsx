import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { BoostKind } from '@coinnibal/shared';
import { CoinCharacter, Icon, Receipt, Stamp, useOffscreenPause, useReducedMotion, type ReceiptLine } from '../../design';
import { ourXHandle, useT } from '../../i18n';
import { arenaRates } from '../../wallet/ticket';
import { useUi } from '../../store';
import { siteHost } from '../../site/settings';
import { useTokenText } from '../lobby/useLobby';
import { PageHead } from '../PageHead';
import { BOOST_PATH } from '../game/boostGlyphs';
import { docsEn } from './content.en';
import { payoutExample, type DocBlock, type DocsContent } from './facts';
import { ComicStrip } from './Comics';
import { ValueFlow } from './ValueFlow';
import './docs.css';

/** The guide's own address (`/docs`). The lobby also shows the guide (`/play#docs`), where the hash names the lobby's page. */
const onDocsPath = (): boolean => {
  try {
    return /^\/docs\/?$/i.test(location.pathname);
  } catch {
    return false;
  }
};

/** Writes the section into the address bar on `/docs` only (`replaceState`: no history entry, no `hashchange`). */
function writeHash(id: string | null): void {
  if (!onDocsPath()) return;
  try {
    history.replaceState(history.state, '', id ? `#docs-${id}` : `${location.pathname}${location.search}`);
  } catch {
    /* a sandboxed frame: the address stays */
  }
}

/** A plain click (not a new tab or window): the guide handles it in place. */
const plainClick = (e: MouseEvent): boolean => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** A section is the one being read once its top passes this line: the 75px header plus about one section gap, so the
 * mark moves on when the previous section has gone under the header, not 50-80px later. */
const READ_LINE = 160;

/**
 * The player guide (`/docs`, `#docs`): how to play, rooms and tickets, how value moves, rounds and the fee on
 * profit, power-ups, the Coinnibal NFT, the game token, the contract and the server, wallet safety, the profile and X,
 * and what happens when something goes wrong. Typed content lives in content.en.ts; every number comes from the code
 * through facts.ts, and the fee rates are the server's (`ChainStatus.fees`) when they are known.
 *
 * Every section has an address (`/docs#docs-payout`): a contents entry or an in-text link scrolls to it and writes it
 * into the address bar, and opening such a link lands on the section. The contents mark the section being read.
 *
 * `headingLevel`: 1 where the guide is the page (`/docs`: the title is the h1, chapters h2, block titles h3); 2 inside
 * the lobby (h2, h3, h4). `symbol`: the token's name in the text, instead of the server's (`/docs` passes "tokens": a
 * visitor page shows no ticker).
 */
export function DocsPage({ headingLevel = 2, symbol }: { headingLevel?: 1 | 2; symbol?: string } = {}) {
  const tok = useTokenText();
  const sym = symbol ?? tok.symbol;
  const SecTag = headingLevel === 1 ? 'h2' : 'h3';
  const subTag = headingLevel === 1 ? 'h3' : 'h4';
  useT(); // re-renders when the project's X handle arrives with the site settings
  const x = ourXHandle();
  const burnBps = useUi((s) => s.chain?.fees?.burnBps ?? null);
  const vaultBps = useUi((s) => s.chain?.fees?.vaultBps ?? null);
  const chainName = useUi((s) => s.chain?.chainName ?? null);
  const testnet = useUi((s) => s.chain?.testnet ?? null);
  const c = useMemo(
    () =>
      docsEn(sym, arenaRates(burnBps !== null && vaultBps !== null ? { burnBps, vaultBps } : null), chainName ?? undefined, {
        testnet: testnet ?? undefined,
        site: siteHost(),
        x,
      }),
    [sym, burnBps, vaultBps, chainName, testnet, x],
  );
  const reduced = useReducedMotion();
  const ids = useMemo(() => c.sections.map((s) => s.id), [c.sections]);
  const [active, setActive] = useState<string>(ids[0]);
  const [tocOpen, setTocOpen] = useState(false);
  /** While a jump's smooth scroll runs, the contents keep the target marked (no flicker through the sections between). */
  // (`performance.now()` deadline; 0: unlocked)
  const lockUntil = useRef(0);

  // the section being read: the last one whose top has passed the read line (the last one at the very bottom)
  useEffect(() => {
    let frame = 0;
    let idle = 0;
    const read = () => {
      frame = 0;
      if (performance.now() < lockUntil.current) return;
      const doc = document.documentElement;
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= doc.scrollHeight - 2) {
        setActive(ids[ids.length - 1]);
        return;
      }
      let cur = ids[0];
      for (const id of ids) {
        const el = document.getElementById(`docs-${id}`);
        if (el && el.getBoundingClientRect().top <= READ_LINE) cur = id;
      }
      setActive(cur);
    };
    const unlock = () => {
      lockUntil.current = 0;
      if (!frame) frame = requestAnimationFrame(read);
    };
    const onScroll = () => {
      // a jump's scroll is over once the scrolling stops (`scrollend` where the browser has it)
      if (lockUntil.current) {
        clearTimeout(idle);
        idle = window.setTimeout(unlock, 160);
      }
      if (!frame) frame = requestAnimationFrame(read);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scrollend', unlock);
    window.addEventListener('resize', onScroll);
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('scrollend', unlock);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(idle);
    };
  }, [ids]);

  // a link to a section (`/docs#docs-nft`): the page renders after the browser's own jump to the hash, so land on it here
  useEffect(() => {
    if (!onDocsPath()) return;
    let id = '';
    try {
      id = decodeURIComponent(location.hash.slice(1));
    } catch {
      return; // a broken hash: stay at the top
    }
    if (!id.startsWith('docs-') || !document.getElementById(id)) return;
    const land = () => document.getElementById(id)?.scrollIntoView({ block: 'start' });
    // the contents mark the linked section until the landing scroll has settled
    lockUntil.current = performance.now() + 400;
    const first = requestAnimationFrame(land);
    // the web fonts can still move the text a little: land again once they are in
    let live = true;
    void document.fonts?.ready.then(() => live && requestAnimationFrame(land));
    setActive(id.slice('docs-'.length));
    return () => {
      live = false;
      cancelAnimationFrame(first);
    };
  }, []);

  const jump = useCallback(
    (id: string) => {
      const el = document.getElementById(`docs-${id}`);
      if (!el) return;
      // at most this long; the scroll's end unlocks it sooner
      lockUntil.current = performance.now() + (reduced ? 0 : 2500);
      setActive(id);
      el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      el.querySelector<HTMLElement>('.dc-sec__title')?.focus({ preventScroll: true });
      writeHash(id);
    },
    [reduced],
  );

  const toTop = () => {
    lockUntil.current = 0;
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    document.getElementById('dc-title')?.focus({ preventScroll: true });
    writeHash(null);
  };

  return (
    <div className="dc-page">
      <PageHead
        kicker={c.kicker}
        title={c.title}
        deck={c.deck}
        id="dc-title"
        as={headingLevel === 1 ? 'h1' : 'h2'}
        aside={
          <span className="dc-head__art">
            <CoinCharacter paint="cream" mood="smug" size={124} look={[-3, 1]} feet ground bob />
            <Stamp text="Guide" tone="teal" round size="md" rotate={-8} className="dc-head__stamp" />
          </span>
        }
      />
      <div className="dc-layout">
        <nav className={`dc-toc kb-island${tocOpen ? ' is-open' : ''}`} aria-label={c.tocLabel}>
          <span className="dc-toc__label mono">{c.tocLabel}</span>
          {/* phones: the contents fold into one button, so the first chapter starts on the first screen */}
          <button type="button" className="dc-toc__toggle" aria-expanded={tocOpen} aria-controls="dc-toc-list" onClick={() => setTocOpen((o) => !o)}>
            <span className="dc-toc__label-text">{c.tocLabel}</span>{' '}
            <span className="dc-toc__count">{c.tocCount(c.sections.length)}</span>
            <Icon name="chevron" size={18} className="dc-toc__chev" />
          </button>
          <ol className="dc-toc__list" id="dc-toc-list">
            {c.sections.map((s, i) => (
              <li key={s.id}>
                <a
                  href={`/docs#docs-${s.id}`}
                  className="dc-toc__item"
                  aria-current={active === s.id ? 'location' : undefined}
                  onClick={(e) => {
                    if (!plainClick(e)) return;
                    e.preventDefault();
                    jump(s.id);
                  }}
                >
                  <span className="dc-toc__no mono" aria-hidden="true">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="dc-toc__title">{s.title}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <article className="dc-body" aria-labelledby="dc-title">
          {c.sections.map((s, i) => (
            <section key={s.id} id={`docs-${s.id}`} className="dc-sec" aria-labelledby={`docs-${s.id}-h`}>
              <header className="dc-sec__head">
                <span className="dc-sec__no mono" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="dc-sec__titles">
                  <SecTag id={`docs-${s.id}-h`} className="dc-sec__title" tabIndex={-1}>
                    {s.title}
                  </SecTag>
                  <p className="dc-sec__lede">
                    <RichText text={s.lede} jump={jump} />
                  </p>
                </div>
              </header>
              <div className="dc-sec__body">
                {s.strip && <ComicStrip id={s.id} strip={s.strip} />}
                {s.blocks.map((b, j) => (
                  <Block key={j} block={b} c={c} jump={jump} subTag={subTag} />
                ))}
              </div>
            </section>
          ))}

          <footer className="dc-foot">
            {c.colophon && <p className="dc-foot__text">{c.colophon}</p>}
            <button type="button" className="dc-top" onClick={toTop}>
              <Icon name="arrow" size={18} className="dc-top__icon" />
              <span>{c.backToTop}</span>
            </button>
          </footer>
        </article>
      </div>
    </div>
  );
}

/** `[label](#id)` in the guide's text: a link to another section (content.en.ts `see`). */
const LINK = /\[([^[\]]+)\]\(#([a-z]+)\)/g;

/** A guide string with its in-text links drawn as links (scrolling through `jump`, like the contents). */
function RichText({ text, jump }: { text: string; jump: (id: string) => void }): ReactNode {
  if (!text.includes('](#')) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    const [all, label, id] = m;
    const i = m.index ?? 0;
    if (i > at) out.push(text.slice(at, i));
    out.push(
      <a
        key={i}
        className="dc-see"
        href={`/docs#docs-${id}`}
        onClick={(e) => {
          if (!plainClick(e)) return;
          e.preventDefault();
          jump(id);
        }}
      >
        {label}
      </a>,
    );
    at = i + all.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out.map((n, i) => <Fragment key={i}>{n}</Fragment>);
}

/** The level of a block's title inside a chapter: one under the chapter's own heading. */
type SubTag = 'h3' | 'h4';

function Block({ block: b, c, jump, subTag: Sub }: { block: DocBlock; c: DocsContent; jump: (id: string) => void; subTag: SubTag }) {
  switch (b.kind) {
    case 'p':
      return (
        <p className="dc-p">
          <RichText text={b.text} jump={jump} />
        </p>
      );
    case 'list':
      return (
        <ul className="dc-list">
          {b.items.map((it, i) =>
            typeof it === 'string' ? (
              <li key={i}>
                <RichText text={it} jump={jump} />
              </li>
            ) : (
              // `sub`: one kind of the item above it (the two kinds of private room), indented under it
              <li key={i} className={it.sub ? 'is-sub' : undefined}>
                <strong>{it.term}</strong> <RichText text={it.text} jump={jump} />
              </li>
            ),
          )}
        </ul>
      );
    case 'keys':
      return <KeysFig caption={b.caption} rows={b.rows} touch={b.touch === true} jump={jump} />;
    case 'cards':
      return (
        <ul className="dc-cards" aria-label={b.label}>
          {b.items.map((it) => (
            <li key={it.title} className={`dc-card kb-island is-${it.kind}`}>
              <div className="dc-card__head">
                <BoostGlyph kind={it.kind} className="dc-card__glyph" />
                <Sub className="dc-card__title">{it.title}</Sub>
              </div>
              <p className="dc-card__text">{it.text}</p>
              {/* how to use it: its key on a keyboard, its in-game button on a phone (the same picture as here) */}
              <dl className="dc-card__use">
                <div className="dc-card__way">
                  <dt>{b.use.keyboard}</dt>
                  <dd>
                    {b.use.press} <kbd className="dc-kbd dc-card__key mono">{it.key}</kbd>
                  </dd>
                </div>
                <div className="dc-card__way">
                  <dt>{b.use.phone}</dt>
                  <dd>
                    {b.use.tap} <BoostGlyph kind={it.kind} className="dc-card__btn" label={b.use.button(it.title)} /> {b.use.where}
                  </dd>
                </div>
              </dl>
              {it.meta && <p className="dc-card__meta">{it.meta}</p>}
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className="dc-table-wrap kb-island">
          <table className={`dc-table${b.stack ? ' dc-table--stack' : ''}`}>
            <caption>{b.caption}</caption>
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={i} scope="col" className={b.numeric?.includes(i) ? 'is-num' : undefined}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) => (
                    // `data-label`: a `stack` table's row becomes a card on phones that names its columns (docs.css)
                    <td key={j} className={b.numeric?.includes(j) ? 'is-num mono' : undefined} data-label={b.head[j]}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'flow':
      return (
        <>
          {b.diagram && <ValueFlow labels={b.diagram} />}
          <ol className="dc-flow" aria-label={b.label}>
            {b.steps.map((s, i) => (
              <li key={i} className="dc-flow__step kb-island">
                <span className="dc-flow__no num" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="dc-flow__title">{s.title}</span>
                <span className="dc-flow__text">{s.text}</span>
                {i < b.steps.length - 1 && <Icon name="arrow" size={20} className="dc-flow__arrow" />}
              </li>
            ))}
          </ol>
        </>
      );
    case 'fee-example':
      return <FeeExample c={c} text={b.text} jump={jump} />;
    case 'compare':
      return (
        <div className="dc-compare">
          {[b.left, b.right].map((col, i) => (
            <div key={i} className={`dc-compare__col kb-island${i === 0 ? ' is-chain' : ' is-server'}`}>
              <Sub className="dc-compare__title">
                <Icon name={i === 0 ? 'lock' : 'globe'} size={18} />
                {col.title}
              </Sub>
              <ul className="dc-list">
                {col.items.map((it, j) => (
                  <li key={j}>{it}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      );
    case 'note':
      return (
        <aside className={`dc-note kb-island is-${b.tone}`} aria-label={b.title}>
          <Stamp text={b.stamp} tone={b.tone === 'warn' ? 'red' : 'teal'} size="sm" rotate={-4} className="dc-note__stamp" />
          <Sub className="dc-note__title">{b.title}</Sub>
          <p className="dc-note__text">{b.text}</p>
        </aside>
      );
    case 'faq':
      return (
        <div className="dc-faq">
          {b.items.map((it, i) => (
            <details key={i} className="dc-faq__item kb-island">
              <summary className="dc-faq__q">
                <span>{it.q}</span>
                <Icon name="chevron" size={18} className="dc-faq__chev" />
              </summary>
              <p className="dc-faq__a">{it.a}</p>
            </details>
          ))}
        </div>
      );
    default:
      return null;
  }
}

/**
 * The controls: on a computer, key stickers that press themselves one after another (paused off screen); on a phone
 * (`touch`), the on-screen controls as plain pills that stay still. Each table names itself by its own caption id.
 */
function KeysFig({ caption, rows, touch, jump }: { caption: string; rows: { key: string; action: string }[]; touch: boolean; jump: (id: string) => void }) {
  const [ref, visible] = useOffscreenPause<HTMLElement>();
  const capId = useId();
  return (
    <figure ref={ref} className={`dc-keys-fig kb-island${touch ? ' is-touch' : ''}`} data-paused={!visible || undefined}>
      <figcaption className="dc-cap" id={capId}>
        {caption}
      </figcaption>
      <table className="dc-keys" aria-labelledby={capId}>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key}>
              <th scope="row">
                <KeyCaps keys={r.key} i={i} touch={touch} />
              </th>
              <td>
                <RichText text={r.action} jump={jump} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/**
 * A row's keys as separate caps: `Space / left click` → [Space] / [Left click], `Tab (hold)` → [Tab] (hold). A cap
 * never wraps inside itself; the caps of a row press together (`--i`).
 */
function KeyCaps({ keys, i, touch = false }: { keys: string; i: number; touch?: boolean }) {
  const note = /^(.+?)\s+(\(.+\))$/.exec(keys);
  const caps = (note ? note[1] : keys).split(' / ');
  return (
    <span className="dc-keycaps">
      {caps.map((k, j) => (
        <Fragment key={j}>
          {j > 0 && <span className="dc-keycaps__or">/</span>}
          {touch ? (
            // a control on the screen, not a key: a still pill in the game's words
            <span className="dc-pill">{k}</span>
          ) : (
            <kbd className="dc-kbd mono" style={{ ['--i' as string]: i }}>
              {k}
            </kbd>
          )}
        </Fragment>
      ))}
      {note && <span className="dc-keycaps__note">{note[2]}</span>}
    </span>
  );
}

/**
 * A power-up's picture as its in-game button draws it (`BOOST_PATH`, the button's tint): decorative beside the card's
 * title, named (`label`) where it stands for the button to tap.
 */
function BoostGlyph({ kind, className, label }: { kind: BoostKind; className: string; label?: string }) {
  return (
    <span className={`dc-glyph is-${kind} ${className}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d={BOOST_PATH[kind]} />
      </svg>
    </span>
  );
}

/** The worked example: a ticket of 1,000 tokens worth 1,900 at the bell, with the fee on its profit, beside its text. */
function FeeExample({ c, text, jump }: { c: DocsContent; text: string; jump: (id: string) => void }) {
  const x = payoutExample(c.rates);
  const r = c.receipt;
  const n = (v: bigint | number) => c.num(Number(v));
  const lines: ReceiptLine[] = [
    { label: r.entry, value: n(x.entry) },
    { label: r.cashout, value: n(x.payout) },
    { label: r.winnings, value: n(x.profit) },
    { label: r.burn(c.pct(c.rates.burnBps)), value: `−${n(x.burned)}`, muted: true },
    { label: r.vault(c.pct(c.rates.vaultBps)), value: `−${n(x.toVault)}`, muted: true },
    { label: r.net, value: n(x.net), strong: true },
  ];
  return (
    <figure className="dc-fee">
      <figcaption className="dc-fee__cap">{r.caption}</figcaption>
      <div className="dc-fee__grid">
        <p className="dc-p">
          <RichText text={text} jump={jump} />
        </p>
        <div className="dc-fee__slips">
          <Receipt title={r.title} meta={r.meta} lines={lines} footer={r.footer} className="dc-fee__slip" />
        </div>
      </div>
    </figure>
  );
}
