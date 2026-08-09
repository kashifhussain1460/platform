import type { ReactNode } from 'react';
import Link from 'next/link';
import { OrlixaLockup } from '@/components/marketing-dark/OrlixaMark';
import { Starfield } from './AuthShell';

/**
 * Split-screen auth shell — 60% looping background video (left), 40% form
 * panel (right). Login-only (the other auth screens keep AuthShell's
 * centered-card layout); the video panel hides below `lg` so mobile gets a
 * simple full-width form instead of a cramped side-by-side.
 */
export function AuthSplitShell({
  heading,
  subtitle,
  children,
  bgVideo,
}: {
  heading?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  bgVideo: string;
}) {
  return (
    <main className="font-marketing relative flex min-h-screen bg-[#02030a]">
      <div className="relative hidden w-[60%] shrink-0 overflow-hidden lg:block">
        <video
          aria-hidden
          autoPlay
          muted
          loop
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
          src={bgVideo}
        />
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/10 via-transparent to-[#02030a]" />
      </div>

      <div className="relative flex w-full items-center justify-center overflow-hidden px-6 py-10 lg:w-[40%]">
        <div aria-hidden className="pointer-events-none absolute -right-32 top-0 h-[420px] w-[420px] rounded-full bg-violet/15 blur-[130px]" />
        <div aria-hidden className="pointer-events-none absolute -left-24 bottom-0 h-[340px] w-[340px] rounded-full bg-violet-accent/10 blur-[110px]" />
        <Starfield />

        <div className="relative z-10 w-full max-w-[400px]">
          <Link href="/" className="mx-auto block w-fit">
            <OrlixaLockup height={84} />
          </Link>

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
