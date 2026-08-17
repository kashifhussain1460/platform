'use client';

import { useEffect, useRef } from 'react';

/** The real macOS traffic-light colours, in window order. */
const TRAFFIC_LIGHTS = ['#FF5F56', '#FFBD2E', '#27C93F'];

/**
 * A video presented as a macOS window, which starts playing when it scrolls
 * into view and stops when it leaves.
 *
 * ## Why it autoplays muted, with controls left on
 *
 * Browsers only allow autoplay without sound, so the video starts silent. That
 * is a real trade for a pitch video, and the answer is not to hide it: the
 * native controls stay, so anyone who wants the audio has an obvious way to
 * turn it on, scrub, or stop it. Autoplaying with sound is not an option any
 * browser would honour anyway.
 *
 * ## Why it pauses on the way out
 *
 * A video that keeps running three sections down is a sound you cannot find and
 * a download nobody asked for. Pausing on exit also means someone who scrolls
 * back gets the frame they left, not a video that finished without them.
 */
export function MacWindowVideo({
  src,
  poster,
  label,
}: {
  src: string;
  poster?: string;
  /** Screen-reader name for the video — say what is in it, not "video". */
  label: string;
}) {
  // A ref rather than state: this reads and drives the DOM video element
  // directly (play/pause), which is not React-rendered data.
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Someone who asked their system for less motion did not ask for a video to
    // start itself. They keep the controls and start it if they want it.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          // Autoplay can still be refused (battery saver, an OS setting); the
          // poster and controls remain, so a refusal costs nothing.
          void video.play().catch(() => undefined);
        } else {
          video.pause();
        }
      },
      // Half of it on screen — enough that it is genuinely being looked at,
      // rather than clipping the top edge on the way past.
      { threshold: 0.5 },
    );

    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  return (
    <figure className="overflow-hidden rounded-[14px] border border-white/[0.12] bg-void-card shadow-[0_30px_80px_-20px_rgba(0,0,0,0.85)]">
      {/* Window chrome. Decorative: the dots are not buttons, so they are
          hidden from assistive tech rather than announced as three blank
          images. */}
      <div
        aria-hidden
        className="flex h-9 items-center gap-2 border-b border-white/[0.07] bg-gradient-to-b from-white/[0.07] to-white/[0.02] px-4"
      >
        {TRAFFIC_LIGHTS.map((color) => (
          <span
            key={color}
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: color }}
          />
        ))}
      </div>

      <video
        ref={videoRef}
        controls
        muted
        playsInline
        preload="metadata"
        poster={poster}
        aria-label={label}
        className="block w-full bg-black"
        src={src}
      />
    </figure>
  );
}
