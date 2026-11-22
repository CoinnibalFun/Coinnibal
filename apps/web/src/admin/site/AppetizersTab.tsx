import type { AppetizerEntry } from '@coinnibal/shared';
import { useCallback, useEffect, useState } from 'react';
import { Button, InkButton, StampSpinner } from '../../design';
import type { AdminApi } from '../../site/api';
import { CopyButton } from '../ui';
import { Empty, Ext, errText, fmtDate, useFlash } from './common';

/** Cards per page of the drawer. */
const PAGE = 100;

/** "0042". */
const no = (n: number) => String(n).padStart(4, '0');

/**
 * Appetizers: the early cards visitors claim on the landing page, newest first: the number, the X handle, the wallet
 * (in full, with a copy button), when it was claimed, the X post that shared it and how often its image was fetched.
 * A search (handle or wallet), the totals, the CSV of every card, and delete (with a confirm).
 */
export function AppetizersTab({ api, onTotals }: { api: AdminApi; onTotals?: (t: { total: number; posted: number }) => void }) {
  const [items, setItems] = useState<AppetizerEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [posted, setPosted] = useState(0);
  const [more, setMore] = useState(false);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useFlash();

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(
    (offset = 0) => {
      api.appetizers.list({ limit: PAGE, offset, q: query }).then(
        (r) => {
          setItems((old) => (offset > 0 && old ? [...old, ...r.items] : r.items));
          setTotal(r.total);
          setPosted(r.posted);
          setMore(r.items.length === PAGE);
        },
        (e) => setFlash('err', errText(e)),
      );
    },
    [api, query, setFlash],
  );
  useEffect(() => load(0), [load]);
  useEffect(() => {
    if (items) onTotals?.({ total, posted });
  }, [items, total, posted, onTotals]);

  const remove = async (e: AppetizerEntry) => {
    if (!window.confirm(`Delete card No. ${no(e.no)} (@${e.handle})? It cannot be brought back.`)) return;
    setBusy(e.code);
    try {
      const r = await api.appetizers.remove(e.code);
      setItems((list) => list?.filter((x) => x.code !== e.code) ?? null);
      setTotal(r.total);
      setPosted(r.posted);
    } catch (err) {
      setFlash('err', errText(err));
    } finally {
      setBusy(null);
    }
  };

  const csv = async () => {
    try {
      await api.appetizers.csv();
    } catch (err) {
      setFlash('err', errText(err));
    }
  };

  return (
    <section className="ad-card" aria-labelledby="ad-app-h" data-testid="admin-appetizers">
      <div className="ad-card__bar">
        <h2 className="ad-card__title" id="ad-app-h">
          Appetizer cards
        </h2>
        <div className="ad-actions">
          <span className="ad-note" data-testid="admin-appetizers-totals">
            {items ? `${total.toLocaleString('en-US')} card${total === 1 ? '' : 's'} · ${posted.toLocaleString('en-US')} posted` : 'Loading…'}
          </span>
          <InkButton variant="ghost" size="sm" onClick={() => void csv()}>
            Export CSV
          </InkButton>
        </div>
      </div>
      <p className="ad-card__lede">The early cards visitors claim on the landing page with a wallet and an X handle. The card shows the handle only; the wallet stays here.</p>
      <div className="ad-filters">
        <label className="ad-search">
          <span className="kb-sr">Search</span>
          <input className="st-input" type="search" placeholder="Search handle or wallet" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      {flash}
      {!items ? (
        <StampSpinner label="Loading" />
      ) : items.length === 0 ? (
        <Empty scene="queue" mood="sleepy">
          {query ? `No card matching “${query}”.` : 'No cards yet. They arrive here when visitors claim one on the landing page.'}
        </Empty>
      ) : (
        <div className="ad-tablewrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th scope="col">No.</th>
                <th scope="col">Handle</th>
                <th scope="col">Wallet</th>
                <th scope="col">Claimed</th>
                <th scope="col">Post</th>
                <th scope="col">Views</th>
                <th scope="col">
                  <span className="kb-sr">Delete</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.code} data-testid="admin-appetizer-row">
                  <td className="num">{no(e.no)}</td>
                  <td>
                    <Ext href={`https://x.com/${e.handle}`}>@{e.handle}</Ext>
                  </td>
                  <td>
                    <code className="ad-wallet">{e.wallet}</code> <CopyButton value={e.wallet} label="Copy wallet" />
                  </td>
                  <td className="num ad-date">{fmtDate(e.at)}</td>
                  <td>{e.post ? <Ext href={e.post}>Post</Ext> : '—'}</td>
                  <td className="num">{e.views.toLocaleString('en-US')}</td>
                  <td>
                    <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void remove(e)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more && items && (
        <Button variant="ghost" size="sm" onClick={() => load(items.length)}>
          Show older cards
        </Button>
      )}
    </section>
  );
}
