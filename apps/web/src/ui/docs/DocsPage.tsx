import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { CoinCharacter, Icon, Receipt, Rule, Stamp, useOffscreenPause, useReducedMotion, type ReceiptLine } from '../../design';
import { ourXHandle, useT } from '../../i18n';
import { arenaRates } from '../../wallet/ticket';
import { useUi } from '../../store';
import { siteHost } from '../../site/settings';
import { useTokenText } from '../lobby/useLobby';
import { PageHead } from '../PageHead';
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

/** How far below the top of the window a section counts as the one being read (the sticky header and a little air). */
const READ_LINE = 120;

/**
 * The player guide (`/docs`, `#docs`): how to play, rooms and tickets, how value moves, rounds and the fee on
 * profit, power-ups, the Coinnibal NFT, the game token, the contract and the server, wallet safety, the profile and X,
 * and what happens when something goes wrong. Typed content lives in content.en.ts; every number comes from the code
 * through facts.ts, and the fee rates are the server's (`ChainStatus.fees`) when they are known.
 *
 * Every section has an address (`/docs#docs-payout`): a contents entry or an in-text link scrolls to it and writes it
 * into the address bar, and opening such a link lands on the section. The contents mark the section being read.
 */
export function DocsPage() {
  const tok = useTokenText();
  useT(); // re-renders when the project's X handle arrives with the site settings
  const x = ourXHandle();
  const burnBps = useUi((s) => s.chain?.fees?.burnBps ?? null);
  const vaultBps = useUi((s) => s.chain?.fees?.vaultBps ?? null);
  const chainName = useUi((s) => s.chain?.chainName ?? null);
  const testnet = useUi((s) => s.chain?.testnet ?? null);
  const c = useMemo(
    () =>
      docsEn(tok.symbol, arenaRates(burnBps !== null && vaultBps !== null ? { burnBps, vaultBps } : null), chainName ?? undefined, {
        testnet: testnet ?? undefined,
        site: siteHost(),
        x,
      }),
    [tok.symbol, burnBps, vaultBps, chainName, testnet, x],
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
      el.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
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
            <span className="mono">{c.tocLabel}</span>
            <span className="dc-toc__count mono">{c.sections.length}</span>
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
                  <h3 id={`docs-${s.id}-h`} className="dc-sec__title" tabIndex={-1}>
                    {s.title}
                  </h3>
                  <p className="dc-sec__lede">
                    <RichText text={s.lede} jump={jump} />
                  </p>
                </div>
              </header>
              <div className="dc-sec__body">
                {s.strip && <ComicStrip id={s.id} strip={s.strip} />}
                {s.blocks.map((b, j) => (
                  <Block key={j} block={b} c={c} jump={jump} />
                ))}
              </div>
            </section>
          ))}

          <Rule variant="double" />
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

function Block({ block: b, c, jump }: { block: DocBlock; c: DocsContent; jump: (id: string) => void }) {
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
              <li key={i}>
                <strong>{it.term}</strong> <RichText text={it.text} jump={jump} />
              </li>
            ),
          )}
        </ul>
      );
    case 'keys':
      return <KeysFig caption={b.caption} rows={b.rows} jump={jump} />;
    case 'cards':
      return (
        <ul className="dc-cards" aria-label={b.label}>
          {b.items.map((it, i) => (
            <li key={it.title} className="dc-card kb-island">
              <div className="dc-card__head">
                <KeyCaps keys={it.key} i={i} />
                <h4 className="dc-card__title">{it.title}</h4>
              </div>
              <p className="dc-card__text">{it.text}</p>
              {it.meta && <p className="dc-card__meta mono">{it.meta}</p>}
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className="dc-table-wrap kb-island">
          <table className={`dc-table${b.stack ? ' dc-table--stack' : ''}`}>
            <caption className="mono">{b.caption}</caption>
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
                <span className="dc-flow__title mono">{s.title}</span>
                <span className="dc-flow__text">{s.text}</span>
                {i < b.steps.length - 1 && <Icon name="arrow" size={20} className="dc-flow__arrow" />}
              </li>
            ))}
          </ol>
        </>
      );
    case 'fee-example':
      return <FeeExample c={c} />;
    case 'compare':
      return (
        <div className="dc-compare">
          {[b.left, b.right].map((col, i) => (
            <div key={i} className={`dc-compare__col kb-island${i === 0 ? ' is-chain' : ' is-server'}`}>
              <h4 className="dc-compare__title">
                <Icon name={i === 0 ? 'lock' : 'globe'} size={18} />
                {col.title}
              </h4>
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
          <h4 className="dc-note__title">{b.title}</h4>
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

/** The controls as key stickers that press themselves one after another (paused off screen). */
function KeysFig({ caption, rows, jump }: { caption: string; rows: { key: string; action: string }[]; jump: (id: string) => void }) {
  const [ref, visible] = useOffscreenPause<HTMLElement>();
  return (
    <figure ref={ref} className="dc-keys-fig kb-island" data-paused={!visible || undefined}>
      <figcaption className="dc-cap mono" id="dc-keys-cap">
        {caption}
      </figcaption>
      <table className="dc-keys" aria-labelledby="dc-keys-cap">
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key}>
              <th scope="row">
                <KeyCaps keys={r.key} i={i} />
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
function KeyCaps({ keys, i }: { keys: string; i: number }) {
  const note = /^(.+?)\s+(\(.+\))$/.exec(keys);
  const caps = (note ? note[1] : keys).split(' / ');
  return (
    <span className="dc-keycaps">
      {caps.map((k, j) => (
        <Fragment key={j}>
          {j > 0 && <span className="dc-keycaps__or">/</span>}
          <kbd className="dc-kbd mono" style={{ ['--i' as string]: i }}>
            {k}
          </kbd>
        </Fragment>
      ))}
      {note && <span className="dc-keycaps__note">{note[2]}</span>}
    </span>
  );
}

/** The worked example: a ticket of 1,000 tokens worth 1,900 at the bell, with the fee on its profit. */
function FeeExample({ c }: { c: DocsContent }) {
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
      <figcaption className="dc-fee__cap mono">{r.caption}</figcaption>
      <div className="dc-fee__slips">
        <Receipt title={r.title} meta={r.meta} lines={lines} footer={r.footer} className="dc-fee__slip" />
      </div>
    </figure>
  );
}
