'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { OrlixaLockup } from './OrlixaMark';

/**
 * `href: null` means the page does not exist yet. Those stay as plain text
 * rather than links to `#`: a link that goes nowhere reads as a broken site,
 * and it is the one thing a visitor will remember trying.
 */
const NAV: { label: string; href: string | null }[] = [
  { label: 'Product', href: null },
  { label: 'AI Employees', href: null },
  { label: 'Solutions', href: null },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Resources', href: null },
  { label: 'Company', href: null },
];

/** Sticky nav — transparent at top, glass (blur + hairline) once scrolled. */
export function DarkNav() {
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <motion.header
      initial={{ opacity: 0, y: -16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        // 104px only ever existed to fit a 100px logo. With the lockup at a
        // normal nav size the extra height was just fold pushed off screen.
        'sticky top-0 z-50 h-[76px] transition-colors duration-300',
        scrolled ? 'border-b border-white/[0.08] bg-void/80 backdrop-blur-xl' : 'border-b border-transparent bg-transparent',
      )}
    >
      <div className="mx-auto flex h-full max-w-[1440px] items-center justify-between px-8">
        <Link href="/" className="flex items-center">
          {/* ~half the bar, not all of it. At 100px in a 104px header the logo
              WAS the header: it outweighed the headline it sits above and left
              the nav links looking like a footnote. */}
          <OrlixaLockup height={58} />
        </Link>

        <nav className="hidden items-center gap-8 lg:flex">
          {NAV.map(({ label, href }) =>
            href ? (
              <Link
                key={label}
                href={href}
                aria-current={pathname === href ? 'page' : undefined}
                className={cn(
                  'text-[15px] font-medium transition-colors hover:text-white',
                  pathname === href
                    ? 'text-white underline decoration-violet decoration-2 underline-offset-[10px]'
                    : 'text-zinc-400',
                )}
              >
                {label}
              </Link>
            ) : (
              <span key={label} className="text-[15px] font-medium text-fg-muted">
                {label}
              </span>
            ),
          )}
        </nav>

        <div className="flex items-center gap-3">
          <Link href="/login" className="hidden text-[15px] font-medium text-zinc-300 hover:text-white sm:inline">
            Log in
          </Link>
          <Link
            href="/register"
            className="rounded-full bg-violet px-5 py-2.5 text-[15px] font-semibold text-white shadow-[0_0_0_1px_rgba(255,255,255,0.08)] transition-transform hover:scale-[1.03] hover:bg-violet-hover"
          >
            Get Started
          </Link>
        </div>
      </div>
    </motion.header>
  );
}
