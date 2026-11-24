import type { AppetizerCard, ShareCard } from '@coinnibal/shared';
import { renderAppetizerCard, renderShareCard, renderStandingsCard, shareCardSelfCheck } from './share-card';

/**
 * One card picture to draw, as it crosses to a card worker (`card-renderer.ts`): plain data (structured clone).
 * `selfcheck` is the startup check (`shareCardSelfCheck`) run where the cards are drawn.
 */
export type CardJob =
  | { kind: 'share'; card: ShareCard; site: string }
  | { kind: 'standings'; card: ShareCard; site: string }
  | { kind: 'appetizer'; card: Pick<AppetizerCard, 'no' | 'handle' | 'at'>; site: string }
  | { kind: 'selfcheck' };

/** What a job gives back: the PNG bytes, or the self-check's verdict. */
export type CardJobResult = { png: Uint8Array } | { check: { ok: true } | { ok: false; error: string } };

/** Draws one job on this thread (a card worker, or the main thread with `CARD_WORKERS=0`). Throws as the renderers do. */
export function runCardJob(job: CardJob): CardJobResult {
  switch (job.kind) {
    case 'share':
      return { png: renderShareCard(job.card, job.site) };
    case 'standings':
      return { png: renderStandingsCard(job.card, job.site) };
    case 'appetizer':
      return { png: renderAppetizerCard(job.card, job.site) };
    case 'selfcheck':
      return { check: shareCardSelfCheck() };
  }
}
