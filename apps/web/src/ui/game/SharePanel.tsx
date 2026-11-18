import { shareImagePath, shareIntentUrl, shareStandingsPath } from '@coinnibal/shared';
import { useEffect, useState } from 'react';
import { Button, Icon } from '../../design';
import { SERVER } from '../../config';
import { useT } from '../../i18n';
import type { ShareItem } from '../../store';
import { SHARE_COIN, ShareOnX, XMark, killShareText, shareUrl, siteLink, victimLabel } from './ShareOnX';

/**
 * The end-of-game share panel (the round-over, room-over and death sheets). X's web intent cannot carry a picture,
 * so the panel offers the card's picture itself: a preview of the server's PNG (`/share/<id>.png`, and for a result
 * the final standings, `/share/<id>/standings.png`), "Download image" (saved as a file, to add to the post), "Share"
 * through the system share sheet with the picture as a file where the browser can (`navigator.canShare({ files })`:
 * phones send it straight to the X app), and "Share on X" (the intent with the line and the card's link). The kill
 * cards of the game ("Your moments") are listed under it, each with its own download and post.
 */

/** The card pictures fetched this session (one fetch per picture: the preview, the download and the share reuse it). */
const blobs = new Map<string, Promise<Blob>>();

/** A card picture's bytes (cached; a failed fetch is forgotten so a later try fetches again). */
export function cardBlob(path: string): Promise<Blob> {
  let p = blobs.get(path);
  if (!p) {
    p = fetch(`${SERVER.http}${path}`).then((r) => {
      if (!r.ok) throw new Error(`card ${r.status}`);
      return r.blob();
    });
    p.catch(() => blobs.delete(path));
    blobs.set(path, p);
  }
  return p;
}

/** Tests: forget the fetched pictures. */
export function resetCardBlobs(): void {
  blobs.clear();
}

/** A file name part from a room or a coin name: lower-case ASCII letters, digits and dashes (pure, tested). */
export function fileSlug(s: string): string {
  const out = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return out || 'game';
}

/** Saves a picture as a file: a blob link with `download`, clicked and let go. */
export async function downloadCard(path: string, filename: string): Promise<void> {
  const blob = await cardBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // the browser has the file once the click returns; let the URL go a little later (Safari reads it late)
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** The system share sheet can take a picture file here (phones, some desktops). */
export function canShareFiles(): boolean {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function' || typeof File === 'undefined') return false;
    return navigator.canShare({ files: [new File([new Uint8Array(1)], 'coinnibal.png', { type: 'image/png' })] });
  } catch {
    return false;
  }
}

/** Shares the picture with the post's line and link through the system share sheet. False when the player closed it. */
export async function shareCardFile(path: string, filename: string, text: string, url: string): Promise<boolean> {
  const blob = await cardBlob(path);
  const file = new File([blob], filename, { type: blob.type || 'image/png' });
  try {
    await navigator.share({ files: [file], text: `${text} ${SHARE_COIN} ${url}` });
    return true;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return false;
    throw err;
  }
}

/** The picture of `path` as an object URL for an <img> (null while it loads; `failed` when it could not). */
function usePicture(path: string | null): { src: string | null; failed: boolean } {
  const [state, setState] = useState<{ path: string | null; src: string | null; failed: boolean }>({ path: null, src: null, failed: false });
  useEffect(() => {
    if (!path) return;
    let url: string | null = null;
    let live = true;
    setState({ path, src: null, failed: false });
    cardBlob(path).then(
      (b) => {
        if (!live) return;
        url = URL.createObjectURL(b);
        setState({ path, src: url, failed: false });
      },
      () => live && setState({ path, src: null, failed: true }),
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  return state.path === path ? { src: state.src, failed: state.failed } : { src: null, failed: false };
}

export interface SharePanelProps {
  /** The game's card (a result's or a death's); null while it is on its way or when there is none. */
  card: ShareItem | null;
  /** The X post's line for the card (without the coin; the link is the card's, or the site's with no card). */
  text: string;
  /** The room's name, for the file names. */
  room: string;
  /** The kill cards of the game. */
  moments: readonly ShareItem[];
  /** The player used the panel (a sheet that leaves by itself waits from then on). */
  onUse?: () => void;
}

type Pic = 'result' | 'standings';

export function SharePanel({ card, text, room, moments, onUse }: SharePanelProps) {
  const t = useT();
  const [pic, setPic] = useState<Pic>('result');
  const [busy, setBusy] = useState<'download' | 'share' | null>(null);
  const [error, setError] = useState(false);
  const [native] = useState(canShareFiles);
  const standings = !!card?.standings;
  const which: Pic = standings ? pic : 'result';
  const path = card ? (which === 'standings' ? shareStandingsPath(card.id) : shareImagePath(card.id)) : null;
  const picture = usePicture(path);
  const base = `coinnibal-${fileSlug(room)}`;
  const filename = `${base}-${which === 'standings' ? 'standings' : card?.dead ? 'game' : 'result'}.png`;
  const link = card ? shareUrl(card.id) : siteLink();

  const run = async (what: 'download' | 'share') => {
    if (!path || busy) return;
    onUse?.();
    setBusy(what);
    setError(false);
    try {
      if (what === 'download') await downloadCard(path, filename);
      else await shareCardFile(path, filename, text, link);
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="g-sharepanel" aria-label={t('share.panel')} data-testid="share-panel">
      <div className="g-sharepanel__head">
        <h3 className="g-sharepanel__title mono">{t('share.panel')}</h3>
        {standings && (
          <div className="g-sharepanel__pick" role="group" aria-label={t('share.pick')}>
            {(['result', 'standings'] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={`g-sharepanel__tab mono${which === p ? ' is-on' : ''}`}
                aria-pressed={which === p}
                onClick={() => setPic(p)}
                data-testid={`share-pick-${p}`}
              >
                {p === 'result' ? t('share.tabResult') : t('share.tabStandings')}
              </button>
            ))}
          </div>
        )}
      </div>
      {card && (
        <figure className="g-sharepanel__preview">
          {picture.src ? (
            <img src={picture.src} width={1200} height={630} alt={which === 'standings' ? t('share.altStandings') : t('share.altResult')} data-testid="share-preview" />
          ) : (
            <span className={`g-sharepanel__wait mono${picture.failed ? ' is-failed' : ''}`} role="status">
              {picture.failed ? t('share.imgFailed') : t('share.preparing')}
            </span>
          )}
        </figure>
      )}
      <div className="g-sharepanel__actions">
        {card && (
          <Button variant="secondary" size="md" lead="download" loading={busy === 'download'} onClick={() => run('download')} data-testid="share-download">
            {t('share.download')}
          </Button>
        )}
        {card && native && (
          <Button variant="secondary" size="md" lead="share" loading={busy === 'share'} onClick={() => run('share')} data-testid="share-native">
            {t('share.native')}
          </Button>
        )}
        <span onClickCapture={() => onUse?.()} className="g-sharepanel__x">
          <ShareOnX id={card?.id ?? null} text={text} size="md" />
        </span>
      </div>
      {error && (
        <p className="g-sharepanel__note is-error" role="alert">
          {t('share.failed')}
        </p>
      )}
      {card && <p className="g-sharepanel__note">{t('share.hint')}</p>}
      {moments.length > 0 && <Moments moments={moments} room={base} onUse={onUse} />}
    </section>
  );
}

/** "Your moments: 3 kills": the kill cards of the game, newest first, each to download or post (folded by default). */
function Moments({ moments, room, onUse }: { moments: readonly ShareItem[]; room: string; onUse?: () => void }) {
  const t = useT();
  const [failed, setFailed] = useState<string | null>(null);
  const list = [...moments].reverse();
  const save = async (m: ShareItem) => {
    onUse?.();
    setFailed(null);
    try {
      await downloadCard(shareImagePath(m.id), `${room}-ate-${fileSlug(victimLabel(t, m).replace(/^@/, ''))}.png`);
    } catch {
      setFailed(m.id);
    }
  };
  return (
    <details className="g-moments" data-testid="share-moments">
      <summary className="g-moments__sum">
        <span>{moments.length === 1 ? t('share.moments1') : t('share.moments', { n: moments.length })}</span>
        <Icon name="chevron" size={16} className="g-moments__chev" />
      </summary>
      <ul className="g-moments__list">
        {list.map((m) => {
          const name = victimLabel(t, m);
          return (
            <li key={m.id} className="g-moments__row" data-testid="share-moment">
              <span className="g-moments__name">
                <bdi>{t('share.ate', { name })}</bdi>
                {m.test && <span className="g-test-tag mono">TEST</span>}
                {failed === m.id && <span className="g-moments__err mono">{t('share.imgFailed')}</span>}
              </span>
              <button type="button" className="kb-iconbtn kb-iconbtn--sm g-moments__btn" aria-label={t('share.downloadKill', { name })} title={t('share.download')} onClick={() => save(m)} data-testid="moment-download">
                <Icon name="download" size={18} />
              </button>
              <a
                className="kb-iconbtn kb-iconbtn--sm g-moments__btn"
                href={shareIntentUrl(`${killShareText(t, m)} ${SHARE_COIN}`, shareUrl(m.id))}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('share.postKill', { name })}
                title={t('share.button')}
                onClick={() => onUse?.()}
                data-testid="moment-x"
              >
                <XMark size={16} />
              </a>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
