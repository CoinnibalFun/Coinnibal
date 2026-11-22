import type { AppetizerOurPost } from '@coinnibal/shared';
import { useEffect, useState } from 'react';
import { Icon } from '../../design';
import { useT } from '../../i18n';
import { site } from '../api';
import { XIcon } from '../Shell';

/** This visit's read of our post (one request however often the sheet opens; a failed read is tried again next time). */
let ours: { url: string; p: Promise<AppetizerOurPost | null> } | null = null;

function loadOurPost(url: string): Promise<AppetizerOurPost | null> {
  if (ours?.url === url) return ours.p;
  const p = site.appetizer.ourPost().then(
    (r) => r.post ?? null,
    () => null,
  );
  ours = { url, p };
  void p.then((post) => {
    if (!post && ours?.p === p) ours = null;
  });
  return p;
}

/** Forgets the read (tests). */
export function resetOurPost(): void {
  ours = null;
}

/** "22 Nov 2026", as the card prints its date. */
const day = (at: number) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function Heart() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true" className="ap-xpost__heart">
      <path d="M12 20.3s-7.8-4.7-7.8-10.4A4.4 4.4 0 0 1 12 7.2a4.4 4.4 0 0 1 7.8 2.7c0 5.7-7.8 10.4-7.8 10.4z" />
    </svg>
  );
}

/**
 * Our X post (`appetizerPostUrl`) in a box of the site's own look, read through the server (`GET /api/appetizer/post`,
 * no script or frame from X): the author, the text, the picture and a "Like + comment on X" key. The whole box is one
 * link to the post on X, in a new tab; opening it counts as step 2 (`onOpen`). Read only once the sheet is open. While
 * it loads, a stand-in of the same shape; when X cannot show it, the box still links to the post. `compact`: inside
 * step 2 on narrower screens (a few lines of text, no picture, no key: the step's own button is right under it).
 */
export function PostBox({ url, xHandle, onOpen, compact = false }: { url: string; xHandle: string; onOpen: () => void; compact?: boolean }) {
  const t = useT();
  const [post, setPost] = useState<AppetizerOurPost | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setPost(undefined);
    void loadOurPost(url).then((p) => live && setPost(p));
    return () => {
      live = false;
    };
  }, [url]);
  const handle = post?.handle ?? xHandle.replace(/^@/, '');
  const cls = `ap-xpost${compact ? ' is-compact' : ''}${post === undefined ? ' is-loading' : ''}`;
  return (
    <a className={cls} href={url} target="_blank" rel="noreferrer" onClick={onOpen} data-testid="ap-xpost">
      <span className="ap-xpost__kicker mono" aria-hidden="true">
        <XIcon size={14} /> {t('ld.ap.box.kicker')}
      </span>
      {post === undefined ? (
        <span className="ap-xpost__stand">
          <span className="kb-sr">{t('ld.ap.box.loading')}</span>
          <span className="ap-xpost__head" aria-hidden="true">
            <span className="ap-xpost__avatar halftone" />
            <span className="ap-xpost__bars">
              <span className="halftone" />
              <span className="halftone" />
            </span>
          </span>
          <span className="ap-xpost__line halftone" aria-hidden="true" />
          <span className="ap-xpost__line halftone" aria-hidden="true" />
          <span className="ap-xpost__line ap-xpost__line--short halftone" aria-hidden="true" />
        </span>
      ) : post ? (
        <>
          <span className="ap-xpost__head">
            {post.avatar ? (
              <img className="ap-xpost__avatar" src={post.avatar} alt="" width={40} height={40} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
            ) : (
              <span className="ap-xpost__avatar ap-xpost__avatar--x" aria-hidden="true">
                <XIcon size={18} />
              </span>
            )}
            <span className="ap-xpost__who">
              <span className="ap-xpost__name">{post.name}</span>
              <span className="ap-xpost__handle">
                @{post.handle}
                {post.at !== null && !compact && <span className="ap-xpost__date"> · {day(post.at)}</span>}
              </span>
            </span>
          </span>
          {post.text && <span className="ap-xpost__text">{post.text}</span>}
          {post.photo && !compact && (
            <img
              className="ap-xpost__photo"
              src={post.photo.url}
              alt=""
              width={post.photo.width}
              height={post.photo.height}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
            />
          )}
        </>
      ) : (
        <span className="ap-xpost__head">
          <span className="ap-xpost__avatar ap-xpost__avatar--x" aria-hidden="true">
            <XIcon size={18} />
          </span>
          <span className="ap-xpost__who">
            <span className="ap-xpost__name">@{handle}</span>
            <span className="ap-xpost__fallback">{t('ld.ap.box.fallback')}</span>
          </span>
        </span>
      )}
      {!compact && (
        <span className="ap-xpost__cta kb-btn kb-btn--teal kb-btn--sm">
          <Heart />
          <Icon name="chat" size={16} />
          <span className="kb-btn__label">
            <span className="kb-btn__text">{t('ld.ap.box.cta')}</span>
          </span>
        </span>
      )}
    </a>
  );
}
