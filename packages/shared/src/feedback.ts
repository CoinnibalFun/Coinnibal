/**
 * Player feedback: the game page's "Feedback" sheet (`POST /api/feedback`) and the admin panel's Feedback drawer
 * (`/api/admin/feedback`). The text is plain text everywhere: stored as sent (control characters removed), never
 * rendered as HTML.
 */

export const FEEDBACK_LIMITS = {
  /** The message (required). */
  text: 1000,
  /** "How can we reach you?" (optional). */
  contact: 100,
  /** The page path the sheet was opened on. */
  page: 200,
  /** The app build. */
  build: 40,
  /** The JSON body of `POST /api/feedback` (bytes): the fields above, in UTF-8, with room to spare. */
  bodyBytes: 8 * 1024,
  /** Entries kept on the server (the newest). */
  kept: 5000,
  /** Entries per page of the admin list (at most). */
  pageMax: 500,
} as const;

/** The kind of room a message was sent from (none: the lobby). */
export const FEEDBACK_ROOMS = ['practice', 'private', 'custom', 'arena', 'test'] as const;
export type FeedbackRoom = (typeof FEEDBACK_ROOMS)[number];

export function isFeedbackRoom(v: unknown): v is FeedbackRoom {
  return typeof v === 'string' && (FEEDBACK_ROOMS as readonly string[]).includes(v);
}

/** A viewport size as the sheet sends it: `<width>x<height>` in CSS pixels. */
export const FEEDBACK_VIEWPORT_RE = /^\d{1,5}x\d{1,5}$/;

/** `POST /api/feedback`. The signed-in wallet comes from the session (`Authorization`), never from the body. */
export interface FeedbackRequest {
  text: string;
  contact?: string;
  page?: string;
  room?: FeedbackRoom | null;
  viewport?: string;
  build?: string;
}

/** One message as the admin reads it. */
export interface FeedbackEntry {
  id: string;
  /** Unix ms, when the server received it. */
  at: number;
  text: string;
  /** "How can we reach you?"; empty when not given. */
  contact: string;
  /** The signed-in wallet (EIP-55) when there was a session; null for a guest. */
  wallet: string | null;
  /** The page path (empty when not sent). */
  page: string;
  room: FeedbackRoom | null;
  /** `<w>x<h>`, empty when not sent. */
  viewport: string;
  /** The app build, empty when not sent. */
  build: string;
  read: boolean;
}

/** `GET /api/admin/feedback`: newest first. */
export interface FeedbackList {
  items: FeedbackEntry[];
  /** Messages kept (all of them, not only this page). */
  total: number;
  /** Messages not marked read. */
  unread: number;
}
