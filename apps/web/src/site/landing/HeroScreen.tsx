import { useEffect, useRef } from 'react';
import { useOffscreenPause, useReducedMotion } from '../../design';
import { useT } from '../../i18n';

/** The clip's files in public/media: a 7.5 s seamless loop of real play, 960x600, no audio track. */
const CLIP = '/media/hero-loop';

/**
 * The game itself, in the hero: a short muted loop of real play (coins eating coins on an arena floor) in a cream
 * screen that stands in the illustrated world beside the hero card (under it on a phone). No controls and nothing to
 * focus; the loop plays only while it is on screen. Reduced motion shows its first frame, a still.
 */
export function HeroScreen() {
  const t = useT();
  const reduced = useReducedMotion();
  const [ref, visible] = useOffscreenPause<HTMLElement>();
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    // muted as a property too: some browsers only autoplay a video that is muted before it plays
    v.muted = true;
    try {
      if (visible) void v.play()?.catch(() => {});
      else v.pause();
    } catch {
      // no media playback here (a test DOM): the poster stays
    }
  }, [visible]);
  return (
    <figure ref={ref} className="ld-screen" data-testid="ld-screen">
      <div className="ld-screen__glass">
        {reduced ? (
          <img className="ld-screen__media" src={`${CLIP}-poster.webp`} alt="" width={960} height={600} decoding="async" />
        ) : (
          <video
            ref={video}
            className="ld-screen__media"
            width={960}
            height={600}
            muted
            autoPlay
            loop
            playsInline
            preload="metadata"
            poster={`${CLIP}-poster.webp`}
            disablePictureInPicture
            aria-hidden="true"
            tabIndex={-1}
          >
            <source src={`${CLIP}.webm`} type="video/webm" />
            <source src={`${CLIP}.mp4`} type="video/mp4" />
          </video>
        )}
      </div>
      <figcaption className="ld-screen__cap">
        <i className="ld-screen__dot" aria-hidden="true" />
        {t('ld.screen.cap')}
      </figcaption>
    </figure>
  );
}
