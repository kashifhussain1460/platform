'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { motion, useReducedMotion, type Variants } from 'framer-motion';

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, delay: i, ease: [0.22, 1, 0.36, 1] },
  }),
};

/**
 * Scroll-reveal wrapper for marketing sections and grid items. Skips
 * straight to the visible state (no animation) when the OS "reduce motion"
 * preference is set, or when `MotionFlag`'s `?nomo` escape hatch has added
 * `nomo` to `<html>` — that flag already existed for deterministic
 * screenshots but had no consumer until this component.
 */
export function FadeIn({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  /** Stagger delay in seconds, e.g. `i * 0.06` inside a `.map()`. */
  delay?: number;
  className?: string;
}) {
  const prefersReducedMotion = useReducedMotion();
  const [noMotion, setNoMotion] = useState(false);

  useEffect(() => {
    setNoMotion(document.documentElement.classList.contains('nomo'));
  }, []);

  const skip = prefersReducedMotion || noMotion;

  return (
    <motion.div
      className={className}
      variants={fadeUp}
      custom={delay}
      initial={skip ? 'show' : 'hidden'}
      animate={skip ? 'show' : undefined}
      whileInView={skip ? undefined : 'show'}
      viewport={{ once: true, margin: '-80px' }}
    >
      {children}
    </motion.div>
  );
}
