import { useT } from '../i18n';

/**
 * The one stamp of every part of the site that is not open yet (the closed notice, the game's gate, the mint press):
 * "Soon" in the body face, sentence case, the same word as the header's chip. It stands straight (site.css `.cl-soon`).
 */
export function SoonStamp({ className }: { className?: string }) {
  const t = useT();
  return <span className={`cl-soon${className ? ` ${className}` : ''}`}>{t('site.closed.sign')}</span>;
}
