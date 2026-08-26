/**
 * Ambient violet radial-glow accents behind a hero, matching `DarkHero` on
 * the homepage (`bg-dark-glow` — see `packages/config/tailwind-preset.cjs`).
 * Render as the first child of a `relative overflow-hidden` section, with
 * the hero's real content given `relative z-10` so it sits above the glow.
 */
export function HeroGlow() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 top-0 h-[600px] w-[600px] bg-dark-glow blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/4 top-1/3 h-[360px] w-[360px] bg-dark-glow opacity-40 blur-3xl"
      />
    </>
  );
}
