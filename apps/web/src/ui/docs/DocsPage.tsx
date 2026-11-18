import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { CoinCharacter, Icon, Receipt, Rule, useReducedMotion, type ReceiptLine } from '../../design';
import { ourXHandle, useT } from '../../i18n';
import { arenaRates } from '../../wallet/ticket';
import { useUi } from '../../store';
import { siteHost } from '../../site/settings';
import { useTokenText } from '../lobby/useLobby';
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

/** Heading levels the guide uses: its title, then its sections one level under it, then their small heads. */
type Level = 1 | 2;
const H = { 1: 'h1', 2: 'h2', 3: 'h3', 4: 'h4' } as const;

/**
 * The guide (`/docs`, `#docs`): how to play, rooms and tickets, how value moves, rounds and the fee on
 * profit, power-ups, the Coinnibal NFT, the game token, the contract and the server, wallet safety, the profile and X,
 * and what happens when something goes wrong. Typed content lives in content.en.ts; every number comes from the code
 * through facts.ts, and the fee rates are the server's (`ChainStatus.fees`) when they are known.
 *
 * One label per section: its title (and a line under it only where that line adds something). Numbers sit in tables,
 * cause and effect in short prose; comics only where a picture says it better (the basic rule, wallet safety).
 * `level`: the title's heading level (1 on `/docs`, where the guide is the page; 2 inside the lobby).
 *
 * Every section has an address (`/docs#docs-payout`): a contents entry or an in-text link scrolls to it and writes it
 * into the address bar, and opening such a link lands on the section. The contents mark the section being read.
 */
export function DocsPage({ level = 2 }: { level?: Level }) {
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

  const Title = H[level];
  const SecTitle = H[(level + 1) as 2 | 3];
  return (
    <div className="dc-page">
      <header className="dc-head">
        <div className="dc-head__text">
          <Title className="dc-head__title" id="dc-title" tabIndex={-1}>
            {c.title}
          </Title>
          <p className="dc-head__deck">{c.deck}</p>
        </div>
        {/* the basic rule, acted out: a big coin closing in on a smaller one (decoration) */}
        <div className="dc-head__art" aria-hidden="true">
          <CoinCharacter paint="cyan" mood="scared" size={70} look={[-4, 0]} sweat feet ground className="dc-head__prey" />
          <CoinCharacter paint="sun" mood="chomp" size={136} look={[-4, 1]} feet ground bob={!reduced} chewing={!reduced} className="dc-head__eater" />
        </div>
      </header>
      <div className="dc-layout">
        <nav className={`dc-toc${tocOpen ? ' is-open' : ''}`} aria-label={c.tocLabel}>
          <span className="dc-toc__label">{c.tocLabel}</span>
          {/* phones: the contents fold into one button, so the first chapter starts on the first screen */}
          <button type="button" className="dc-toc__toggle" aria-expanded={tocOpen} aria-controls="dc-toc-list" onClick={() => setTocOpen((o) => !o)}>
            <span>{c.tocLabel}</span>
            <span className="dc-toc__count num">{c.sections.length}</span>
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
                  <span className="dc-toc__no num" aria-hidden="true">
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
                {/* the chapter's number on a coin (the same coin for every chapter: it numbers, nothing more) */}
                <span className="dc-sec__no num" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <SecTitle id={`docs-${s.id}-h`} className="dc-sec__title" tabIndex={-1}>
                  {s.title}
                </SecTitle>
                {s.lede && (
                  <p className="dc-sec__lede">
                    <RichText text={s.lede} jump={jump} />
                  </p>
                )}
              </header>
              <div className="dc-sec__body">
                {s.strip && <ComicStrip id={s.id} strip={s.strip} />}
                {s.blocks.map((b, j) => (
                  <Block key={j} block={b} c={c} jump={jump} sub={H[(level + 2) as 3 | 4]} />
                ))}
              </div>
            </section>
          ))}

          <Rule variant="double" />
          <footer className="dc-foot">
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

function Block({ block: b, c, jump, sub: Sub }: { block: DocBlock; c: DocsContent; jump: (id: string) => void; sub: 'h3' | 'h4' }) {
  switch (b.kind) {
    case 'p':
      return (
        <p className="dc-p">
          <RichText text={b.text} jump={jump} />
        </p>
      );
    case 'h':
      return <Sub className="dc-sub">{b.text}</Sub>;
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
    case 'steps':
      return (
        <ol className="dc-steps" aria-label={b.label}>
          {b.items.map((it, i) => (
            <li key={i}>
              <RichText text={it} jump={jump} />
            </li>
          ))}
        </ol>
      );
    case 'keys':
      return <KeysFig caption={b.caption} rows={b.rows} jump={jump} />;
    case 'table': {
      // a phone's stacked row names its columns only when there are more than two (two read as "this: that")
      const named = b.stack && b.head.length > 2;
      return (
        <div className="dc-table-wrap">
          <table className={`dc-table${b.stack ? ' dc-table--stack' : ''}${b.keys !== undefined ? ' dc-table--keys' : ''}`}>
            <caption className={b.quiet ? 'dc-sr' : undefined}>{b.caption}</caption>
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={i} scope="col" className={b.numeric?.includes(i) ? 'is-num' : undefined}>
                    {h || <span className="dc-sr">{b.caption}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) => (
                    // `data-label`: a `stack` table's row becomes a block on phones that names its columns (docs.css)
                    // (the name beside a key cap needs no label: the cap leads it)
                    <td key={j} className={b.numeric?.includes(j) ? 'is-num num' : undefined} data-label={named && j > 0 && j !== (b.keys ?? -1) + 1 ? b.head[j] : undefined}>
                      {j === b.keys ? <KeyCaps keys={cell} /> : <RichText text={cell} jump={jump} />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'flow':
      return <ValueFlow labels={b.diagram} label={b.label} />;
    case 'fee-example':
      return <FeeExample c={c} />;
    case 'compare':
      return (
        <div className="dc-compare">
          {[b.left, b.right].map((col, i) => (
            <div key={i} className="dc-compare__col">
              <Sub className="dc-compare__title">{col.title}</Sub>
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
        <aside className={`dc-note is-${b.tone}`} aria-label={b.title}>
          <Sub className="dc-note__title">{b.title}</Sub>
          <p className="dc-note__text">{b.text}</p>
        </aside>
      );
    case 'faq':
      return (
        <div className="dc-faq">
          {b.items.map((it, i) => (
            <details key={i} className="dc-faq__item">
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

/** The controls: each key as a cap beside what it does. A row's caps press down while the pointer is on the row. */
function KeysFig({ caption, rows, jump }: { caption: string; rows: { key: string; action: string }[]; jump: (id: string) => void }) {
  return (
    <div className="dc-table-wrap">
      <table className="dc-keys">
        <caption>{caption}</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">
                <KeyCaps keys={r.key} />
              </th>
              <td>
                <RichText text={r.action} jump={jump} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A row's keys as separate caps: `Space / left click` → [Space] / [Left click], `Tab (hold)` → [Tab] (hold). A cap
 * never wraps inside itself.
 */
function KeyCaps({ keys }: { keys: string }) {
  const note = /^(.+?)\s+(\(.+\))$/.exec(keys);
  const caps = (note ? note[1] : keys).split(' / ');
  return (
    <span className="dc-keycaps">
      {caps.map((k, j) => (
        <Fragment key={j}>
          {j > 0 && <span className="dc-keycaps__or">/</span>}
          <kbd className="dc-kbd num">{k.charAt(0).toUpperCase() + k.slice(1)}</kbd>
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
      <figcaption className="dc-fee__cap">{r.caption}</figcaption>
      <div className="dc-fee__slips">
        <Receipt title={r.title} meta={r.meta} lines={lines} footer={r.footer} className="dc-fee__slip" />
      </div>
    </figure>
  );
}
