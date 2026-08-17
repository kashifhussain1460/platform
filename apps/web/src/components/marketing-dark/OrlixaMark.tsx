import type { CSSProperties } from 'react';

/**
 * Orlixa brand mark. Every place the logo appears — marketing nav and footer,
 * auth and onboarding shells, the app sidebar, the demo player — renders one of
 * these two components, so the brand can be changed in this one file.
 *
 * Both assets are derived from `main-logo.png`, which arrived as a flat RGB
 * image: no alpha, and the artwork sitting in the middle of a large black
 * field. Used as-is it would have shown a black rectangle over the marketing
 * gradient and rendered at roughly a third of its intended size, because most
 * of the file was padding. `orlixa-logo-horizontal.png` and `orlixa-mark.png`
 * are that artwork trimmed to its bounds with the black keyed out, so they sit
 * correctly on any surface. The original is kept untouched at
 * `/main-logo.png`.
 *
 * `object-fit: contain` + one fixed dimension keeps the native aspect ratio.
 */

const base: CSSProperties = {
  display: 'block',
  objectFit: 'contain',
};

/** The mark, small (nav, footer, video corner). */
export function OrlixaMark({ className = '', size = 34 }: { className?: string; size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/orlixa-mark.png"
      alt="Orlixa"
      style={{ ...base, height: size, width: 'auto' }}
      className={className}
    />
  );
}

/**
 * The same mark, large (auth/onboarding shells, demo intro+outro). Pass ONE
 * of `height` or `width`; the other stays `auto` so the native aspect is kept.
 */
export function OrlixaLockup({
  className = '',
  width,
  height,
}: {
  className?: string;
  width?: number;
  height?: number;
}) {
  const style: CSSProperties =
    height != null
      ? { ...base, height, width: 'auto' }
      : { ...base, width: width ?? 280, height: 'auto' };
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/orlixa-logo-horizontal.png" alt="Orlixa — AI Workforce Platform" style={style} className={className} />
  );
}
