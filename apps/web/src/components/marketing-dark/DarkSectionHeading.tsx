import type { ReactNode } from 'react';

/** Mono/tracked-caps kicker used above every dark-section headline. */
export function DarkKicker({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-xs font-semibold uppercase tracking-[0.14em] text-fg-muted ${className}`}>
      {children}
    </p>
  );
}

/** The one highlighted word/phrase in a dark-section headline. */
export function DarkHl({ children }: { children: ReactNode }) {
  return <span className="text-violet-secondary">{children}</span>;
}

/** Kicker + headline, shared by every section below the hero. */
export function DarkSectionHeading({
  kicker,
  children,
  align = 'center',
  className = '',
}: {
  kicker: string;
  children: ReactNode;
  align?: 'center' | 'left';
  className?: string;
}) {
  const centered = align === 'center';
  return (
    <div className={`${centered ? 'text-center' : 'text-left'} ${className}`}>
      <DarkKicker>{kicker}</DarkKicker>
      <h2
        className={`mt-3 text-[28px] font-bold leading-tight tracking-tight text-white sm:text-4xl ${centered ? 'mx-auto max-w-2xl' : ''}`}
      >
        {children}
      </h2>
    </div>
  );
}
