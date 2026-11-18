import { isCountryCode } from '@coinnibal/shared';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon, useKbTheme } from '../design';
import { useT } from '../i18n';
import { Flag, countryName, useCountryOptions } from './Flag';
import { useSheetMode, usePopoverPlace } from './popover';
import './language-picker.css';

/** Folds a name for matching: lower case, no accents (an accented name is found by its plain letters). */
export function foldName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

type Row = { code: string; name: string };

/**
 * The rows a search keeps: names (in the reader's language or in English) that start with it come
 * first, then names that have it inside; a two-letter search also finds the country code. An
 * empty search keeps every row.
 */
export function filterCountries(rows: readonly Row[], query: string): Row[] {
  const q = foldName(query);
  if (!q) return [...rows];
  const starts: Row[] = [];
  const inside: Row[] = [];
  for (const r of rows) {
    const names = [foldName(r.name), foldName(countryName(r.code, 'en'))];
    if (names.some((n) => n.startsWith(q)) || r.code.toLowerCase() === q) starts.push(r);
    else if (names.some((n) => n.includes(q))) inside.push(r);
  }
  return [...starts, ...inside];
}

export interface CountrySelectProps {
  /** '' for none. */
  value: string;
  onChange: (code: string) => void;
  /** The trigger's accessible name ("You play for"). */
  label: string;
  /** The "none" row's text. */
  noneLabel: string;
  className?: string;
}

/**
 * The country picker, built like the language picker: a cream tag (flag and name) that opens a
 * sticker list with a search box on top, flag and name on each row, the current one checked. On
 * phones the list rises as a bottom sheet. Keyboard: type to filter, arrows, Home/End, Enter to
 * pick, Esc or Tab to close (focus goes back to the tag).
 */
export function CountrySelect({ value, onChange, label, noneLabel, className }: CountrySelectProps) {
  const t = useT();
  const theme = useKbTheme();
  const sheet = useSheetMode();
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-opt-${i}`;
  const options = useCountryOptions();
  const current = isCountryCode(value) ? value : '';

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rows = useMemo<Row[]>(() => {
    const found = filterCountries(options, query);
    return query.trim() ? found : [{ code: '', name: noneLabel }, ...found];
  }, [options, query, noneLabel]);
  const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const lastQuery = useRef(query);
  const state = useRef({ rows, active });
  state.current = { rows, active };
  const place = usePopoverPlace(open, sheet, btn, panel, 420, 280);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };
  const choose = (i: number) => {
    const r = state.current.rows[i];
    if (!r) return;
    close();
    if (r.code !== current) onChange(r.code);
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  const chooseRef = useRef(choose);
  chooseRef.current = choose;

  const show = () => {
    setQuery('');
    lastQuery.current = '';
    // the current country (row 0 is "none")
    setActive(Math.max(0, options.findIndex((o) => o.code === current) + 1));
    setOpen(true);
  };

  // a new search starts at its best match (opening keeps the current country in view)
  useEffect(() => {
    if (query === lastQuery.current) return;
    lastQuery.current = query;
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    // phones: the list first (no keyboard over half the sheet until the player taps the search)
    if (sheet) list.current?.focus({ preventScroll: true });
    else search.current?.focus({ preventScroll: true });
    // capture on the window: runs before a surrounding sheet's own Escape and focus trap
    const onKey = (e: KeyboardEvent) => {
      const n = state.current.rows.length;
      let handled = true;
      switch (e.key) {
        case 'Escape':
        case 'Tab':
          closeRef.current();
          break;
        case 'ArrowDown':
          setActive((a) => (n ? (a + 1) % n : 0));
          break;
        case 'ArrowUp':
          setActive((a) => (n ? (a - 1 + n) % n : 0));
          break;
        case 'PageDown':
          setActive((a) => Math.min(n - 1, a + 8));
          break;
        case 'PageUp':
          setActive((a) => Math.max(0, a - 8));
          break;
        case 'Enter':
          chooseRef.current(state.current.active);
          break;
        default:
          handled = false;
      }
      // Home / End / Space pick in the list; in the search box they edit the text
      if (!handled && document.activeElement !== search.current) {
        handled = true;
        if (e.key === 'Home') setActive(0);
        else if (e.key === 'End') setActive(n - 1);
        else if (e.key === ' ') chooseRef.current(state.current.active);
        else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // typing on the list goes to the search
          search.current?.focus({ preventScroll: true });
          handled = false;
        } else handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onDown = (e: PointerEvent) => {
      const at = e.target as Node | null;
      if (at && (panel.current?.contains(at) || btn.current?.contains(at))) return;
      closeRef.current(false);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, sheet]);

  // on opening, the current country sits mid-list; after that the active row just stays in view
  const placed = useRef(false);
  useEffect(() => {
    if (!open) {
      placed.current = false;
      return;
    }
    document.getElementById(`${uid}-opt-${active}`)?.scrollIntoView?.({ block: placed.current ? 'nearest' : 'center' });
    placed.current = true;
  }, [open, active, uid, rows]);

  const onTriggerKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      show();
    }
  };

  const name = current ? countryName(current) : noneLabel;
  const popup = open
    ? createPortal(
        <div className={`kb lang-pop-layer${sheet ? ' is-sheet' : ''}`} data-theme={theme}>
          {sheet && <div className="lang-pop-scrim" aria-hidden="true" />}
          <div
            ref={panel}
            className={`lang-pop cty-pop${sheet ? ' is-sheet' : ''}${place?.bottom !== undefined ? ' is-up' : ''}`}
            style={sheet || !place ? undefined : { left: place.left, width: place.width, maxHeight: place.maxHeight, top: place.top, bottom: place.bottom }}
            data-testid="country-pop"
          >
            {sheet && (
              <>
                <span className="lang-pop__grip" aria-hidden="true" />
                <div className="lang-pop__title" aria-hidden="true">
                  <Icon name="globe" size={18} />
                  {label}
                </div>
              </>
            )}
            <div className="cty-pop__search">
              <svg className="cty-pop__glass" viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" focusable="false">
                <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" strokeWidth="2.4" />
                <path d="M15 15l5 5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
              <input
                ref={search}
                type="search"
                className="cty-pop__input"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={rows.length ? optId(active) : undefined}
                aria-label={t('pf.countrySearch')}
                placeholder={t('pf.countrySearch')}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-testid="country-search"
              />
            </div>
            <ul ref={list} id={listId} className="lang-pop__list" role="listbox" aria-label={label} tabIndex={-1} aria-activedescendant={rows.length ? optId(active) : undefined}>
              {rows.map((r, i) => {
                const on = r.code === current;
                return (
                  <li
                    key={r.code || 'none'}
                    id={optId(i)}
                    role="option"
                    aria-selected={on}
                    data-code={r.code}
                    className={`lang-pop__opt cty-pop__opt${i === active ? ' is-active' : ''}${on ? ' is-on' : ''}`}
                    onPointerMove={() => i !== state.current.active && setActive(i)}
                    onClick={() => choose(i)}
                  >
                    <span className="lang-pop__check" aria-hidden="true">
                      {on && <Icon name="check" size={18} />}
                    </span>
                    <span className="cty-pop__flag" aria-hidden="true">
                      {r.code ? <Flag code={r.code} size={18} label={false} /> : <span className="kb-flag is-none" style={{ ['--flag-h' as string]: '18px' }} />}
                    </span>
                    <span className="lang-pop__name">{r.name}</span>
                  </li>
                );
              })}
            </ul>
            {rows.length === 0 && (
              <p className="cty-pop__empty" role="status">
                {t('pf.countryNoMatch')}
              </p>
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`lang-pick cty-pick${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
        data-testid="country-pick"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${name}`}
        onClick={() => (open ? close() : show())}
        onKeyDown={onTriggerKey}
      >
        {current ? <Flag code={current} size={16} label={false} /> : <span className="kb-flag is-none" style={{ ['--flag-h' as string]: '16px' }} aria-hidden="true" />}
        <span className="lang-pick__value" aria-hidden="true">
          {name}
        </span>
        <Icon name="chevron" size={14} className="lang-pick__chev" />
      </button>
      {popup}
    </>
  );
}
