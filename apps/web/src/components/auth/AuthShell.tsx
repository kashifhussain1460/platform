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
 * Shared shell for every auth screen — near-black bg with violet glow +
 * star-dots, a centered dark card with the Orlixa lockup, heading, subtitle.
 * `bgVideo` is optional (only the login screen uses it): a muted looping clip
 * behind the glow/star-dots, dimmed so the card stays readable.
 */
export function AuthShell({
  heading,
  subtitle,
  children,
  topSlot,
  width = 'max-w-[440px]',
  bgVideo,
}: {
  heading?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  topSlot?: ReactNode;
  width?: string;
  bgVideo?: string;
}) {
  return (
    <main className="font-marketing relative flex min-h-screen items-center justify-center overflow-hidden bg-[#02030a] px-4 py-10">
      {bgVideo && (
        <>
          <video
            aria-hidden
            autoPlay
            muted
            loop
            playsInline
            className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-30"
            src={bgVideo}
          />
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-[#02030a]/70" />
        </>
      )}
      <div aria-hidden className="pointer-events-none absolute -left-40 top-0 h-[440px] w-[440px] rounded-full bg-violet/15 blur-[130px]" />
      <div aria-hidden className="pointer-events-none absolute -right-40 bottom-0 h-[440px] w-[440px] rounded-full bg-violet-accent/10 blur-[130px]" />
      <Starfield />

      <div
        className={`relative z-10 w-full ${width} rounded-3xl border border-white/[0.07] bg-[#080a14]/90 p-8 shadow-[0_30px_90px_-25px_rgba(0,0,0,0.9)] backdrop-blur-sm sm:p-10`}
      >
        <Link href="/" className="mx-auto block w-fit">
          <OrlixaLockup height={84} />
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
    </main>
  );
}
