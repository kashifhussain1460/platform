import type { ReactNode } from 'react';
import Link from 'next/link';
import { OrlixaLockup } from '@/components/marketing-dark/OrlixaMark';

/** Faint scattered violet star-dots (deterministic, decorative). */
export function Starfield() {
  const dots = [
    [6, 18], [14, 62], [9, 88], [22, 8], [31, 44], [4, 40],
    [88, 12], [94, 40], [82, 70], [96, 84], [70, 6], [90, 60],
    [40, 94], [60, 90], [50, 4],
  ];
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
      {dots.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 0.18 : 0.1} fill="#8B6EF2" opacity={0.35} />
      ))}
    </svg>
  );
}

/**
 * The shell every auth screen uses — brand artwork on the left, form on the
 * right.
 *
 * There used to be two: a centred card for most screens and a split layout with
 * a looping video for login alone. Signing in and then being sent to a
 * different-looking screen to verify your email read as two different products,
 * so there is now one layout and one answer to "what does auth look like".
 *
 * ## Why the artwork panel disappears below `lg`
 *
 * Side-by-side on a phone gives a cramped form next to an illustration too
 * small to read. Below `lg` the artwork is dropped entirely and the form takes
 * the full width — the form is the job of the page.
 */
export function AuthShell({
  heading,
  subtitle,
  children,
  topSlot,
  width = 'max-w-[400px]',
  /** Left-panel artwork. One image for every auth screen, on purpose. */
  image = '/Auth.png',
}: {
  heading?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  topSlot?: ReactNode;
  width?: string;
  image?: string;
}) {
  return (
    <main className="font-marketing relative flex min-h-screen bg-[#02030a]">
      {/* The panel is painted the artwork's OWN backdrop (#010210, sampled from
          its edges) rather than the app's #02030a. They differ only in the blue
          channel, but that was enough to draw a visible rectangle around the
          letterboxed illustration. Matching them makes the bars disappear. */}
      <div className="relative hidden w-[60%] shrink-0 overflow-hidden bg-[#010210] lg:block">
        {/* Decorative: the illustration repeats the product story the form's
            own copy already tells, so announcing it would only be noise. */}
        {/* `contain`, not `cover`. The artwork is 3:2 and this panel is close to
            square at 1440×900, so filling it cropped away a third of the width —
            taking the "AI Employee / Processes the task" cards with it, which
            are the only part of the illustration that says anything. The
            letterbox bars are invisible because the panel above is painted the
            artwork's own backdrop. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          aria-hidden
          alt=""
          src={image}
          className="absolute inset-0 h-full w-full object-contain object-center"
        />
        {/* A narrow seam, not a wash. The fade used to run from the middle of
            the panel and swallowed the "Trigger / AI Employee / Action" cards —
            which are the only part of the illustration that says anything. It
            now starts at 88%, wide enough that the join with the form panel is
            not a hard line, narrow enough that the artwork survives. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent from-[88%] to-[#02030a]"
        />
      </div>

      <div className="relative flex w-full items-center justify-center overflow-hidden px-6 py-10 lg:w-[40%]">
        <div aria-hidden className="pointer-events-none absolute -right-32 top-0 h-[420px] w-[420px] rounded-full bg-violet/15 blur-[130px]" />
        <div aria-hidden className="pointer-events-none absolute -left-24 bottom-0 h-[340px] w-[340px] rounded-full bg-violet-accent/10 blur-[110px]" />
        <Starfield />

        <div className={`relative z-10 w-full ${width}`}>
          <Link href="/" className="mx-auto block w-fit">
            {/* Larger than the nav's 38px because it is the only brand mark on
                the screen, but nowhere near the 84px it was — that competed
                with "Welcome back" instead of introducing it. */}
            <OrlixaLockup height={52} />
          </Link>

          {topSlot}

          {heading && (
            <h1 className="mt-6 text-center text-[26px] font-bold leading-tight tracking-tight text-white">{heading}</h1>
          )}
          {subtitle && (
            <p className="mx-auto mt-2 max-w-xs text-center text-sm leading-relaxed text-zinc-400">{subtitle}</p>
          )}

          <div className="mt-7">{children}</div>
        </div>
      </div>
    </main>
  );
}
