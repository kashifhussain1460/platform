import type { ReactNode } from 'react';
import Link from 'next/link';
import { OrlixaLockup } from '@/components/marketing-dark/OrlixaMark';

const STEP_LABELS = [1, 2, 3] as const;

function StepDots({ current }: { current: 1 | 2 | 3 }) {
  return (
    <div
      className="flex shrink-0 items-center gap-2"
      role="group"
      aria-label={`Step ${current} of 3`}
    >
      {STEP_LABELS.map((n, i) => (
        <div key={n} className="flex items-center gap-2">
          <span
            aria-current={n === current ? 'step' : undefined}
            className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold transition-colors ${
              n === current
                ? 'bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] text-white shadow-[0_0_18px_-4px_rgba(91,33,230,0.85)]'
                : n < current
                  ? 'bg-violet/25 text-violet-bright'
                  : 'bg-white/[0.06] text-fg-muted'
            }`}
          >
            {n}
          </span>
          {i < STEP_LABELS.length - 1 && <span className="h-px w-10 bg-white/[0.12]" />}
        </div>
      ))}
    </div>
  );
}

/**
 * Shared shell for the 3-step onboarding wizard.
 *
 * The left panel is a bordered, rounded card with the brand illustration as its
 * background rather than a full-bleed edge-to-edge image. That is the whole
 * difference in feel: inset in a card it reads as a piece of the product being
 * shown to you, while bled to the window edge it reads as wallpaper the form
 * happens to sit on.
 *
 * One image across all three steps, on purpose. The wizard used to swap a
 * different SVG per step, which meant the scenery changed under you every time
 * you pressed Continue — motion that carried no information and competed with
 * the step counter, which is the thing that actually tells you where you are.
 */
export function OnboardingShell({
  step,
  heading,
  subtitle,
  children,
}: {
  step: 1 | 2 | 3;
  heading: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="font-marketing flex min-h-screen gap-6 bg-[#02030a] p-4 lg:p-6">
      {/* The card takes the artwork's own 3:2 shape, so the image IS the card
          rather than a picture parked inside a taller box. Matching the aspect
          also means `cover` crops nothing — the six feature labels stay whole,
          which an earlier taller card sliced in half ("AI Employees" rendered
          as "mployees").
          No logo is drawn on top: the illustration already carries the wordmark
          at its centre, and a second lockup in the corner was the same brand
          twice in one frame. */}
      <section className="hidden w-[46%] shrink-0 items-center justify-center lg:flex">
        <div
          aria-hidden
          className="w-full overflow-hidden rounded-3xl border border-violet/30 bg-[#000007] bg-[url('/Onboarding.png')] bg-cover bg-center"
          style={{
            aspectRatio: '3 / 2',
            // Inline, not a `shadow-[…]` utility: a two-part shadow needs a
            // comma, and Tailwind's arbitrary-value parser drops the whole
            // declaration when it sees one. The class compiled to an empty
            // shadow and the glow silently never rendered — the halo that
            // looked right in a screenshot was the artwork's own.
            boxShadow:
              '0 0 90px -20px rgba(124,58,237,0.55), 0 30px 80px -30px rgba(0,0,0,0.9)',
          }}
        />
      </section>

      <section className="flex flex-1 items-center justify-center px-2 py-8 sm:px-8">
        <div className="w-full max-w-[560px]">
          {/* On a phone the illustration card is hidden, so this is the only
              place the brand appears. */}
          <Link href="/" className="mb-8 block w-fit lg:hidden">
            <OrlixaLockup height={38} />
          </Link>

          <div className="flex justify-center">
            <StepDots current={step} />
          </div>

          <h1 className="mt-9 text-[34px] font-bold leading-[1.15] tracking-tight text-white">
            {heading}
          </h1>
          {subtitle && (
            <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">{subtitle}</p>
          )}

          <div className="mt-8">{children}</div>
        </div>
      </section>
    </main>
  );
}
