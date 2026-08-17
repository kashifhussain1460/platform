import Link from 'next/link';

/** Cute robot mascot — hand-authored gradient SVG (no external asset). */
function RobotMascot({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 300 280" className={className} role="img" aria-label="AI employee robot mascot" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: 'auto', overflow: 'visible' }}>
      <defs>
        <linearGradient id="rb-body" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="60%" stopColor="#E9E3FB" />
          <stop offset="100%" stopColor="#C4B5FD" />
        </linearGradient>
        <linearGradient id="rb-accent" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#A78BFA" />
          <stop offset="100%" stopColor="#6D3FE0" />
        </linearGradient>
        <radialGradient id="rb-eye" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#C4B5FD" />
          <stop offset="60%" stopColor="#8B6EF2" />
          <stop offset="100%" stopColor="#6D3FE0" />
        </radialGradient>
        <radialGradient id="rb-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(196,181,253,0.5)" />
          <stop offset="100%" stopColor="rgba(196,181,253,0)" />
        </radialGradient>
      </defs>

      {/* floating skill tiles */}
      <g stroke="rgba(255,255,255,0.35)" strokeWidth="1.2" fill="rgba(255,255,255,0.06)">
        <rect x="18" y="60" width="30" height="30" rx="8" />
        <rect x="6" y="130" width="30" height="30" rx="8" />
        <rect x="40" y="196" width="30" height="30" rx="8" />
        <rect x="250" y="70" width="30" height="30" rx="8" />
        <rect x="264" y="150" width="30" height="30" rx="8" />
        <rect x="232" y="210" width="30" height="30" rx="8" />
      </g>
      <g stroke="rgba(196,181,253,0.7)" strokeWidth="1.4" fill="none" strokeLinecap="round">
        <path d="M25 71 h16 M25 78 h16 M25 85 h9" />
        <path d="M13 141 h16 M13 148 h16" />
        <circle cx="279" cy="85" r="6" />
        <path d="M271 165 h16 M271 172 h10" />
      </g>

      {/* soft glow behind robot */}
      <ellipse cx="150" cy="150" rx="120" ry="120" fill="url(#rb-glow)" />

      {/* waving arm (behind body) */}
      <path d="M96 168 C70 160 58 130 66 108" fill="none" stroke="url(#rb-accent)" strokeWidth="15" strokeLinecap="round" />
      <circle cx="64" cy="104" r="12" fill="url(#rb-body)" />

      {/* body */}
      <rect x="104" y="150" width="92" height="86" rx="30" fill="url(#rb-body)" />
      <circle cx="150" cy="196" r="11" fill="url(#rb-accent)" />
      <circle cx="150" cy="196" r="5" fill="#EDE9FE" opacity="0.8" />
      {/* right arm */}
      <rect x="188" y="164" width="26" height="46" rx="13" fill="url(#rb-body)" />

      {/* neck */}
      <rect x="138" y="138" width="24" height="20" rx="6" fill="#D8CEF7" />

      {/* head */}
      <rect x="92" y="66" width="116" height="86" rx="34" fill="url(#rb-body)" />
      {/* ears */}
      <rect x="82" y="96" width="12" height="30" rx="6" fill="url(#rb-accent)" />
      <rect x="206" y="96" width="12" height="30" rx="6" fill="url(#rb-accent)" />
      {/* antenna */}
      <path d="M150 66 v-14" stroke="#B8A8F5" strokeWidth="4" strokeLinecap="round" />
      <circle cx="150" cy="48" r="6" fill="url(#rb-accent)" />

      {/* visor */}
      <rect x="104" y="82" width="92" height="56" rx="26" fill="#120E22" />
      {/* eyes */}
      <ellipse cx="132" cy="108" rx="9" ry="12" fill="url(#rb-eye)" />
      <ellipse cx="168" cy="108" rx="9" ry="12" fill="url(#rb-eye)" />
      {/* smile */}
      <path d="M138 124 q12 8 24 0" fill="none" stroke="#8B6EF2" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** Closing CTA banner — violet gradient, copy + two CTAs + robot mascot. */
export function FinalCta() {
  return (
    <section className="px-8 py-16 sm:py-20">
      <div className="mx-auto max-w-[1440px]">
        <div className="relative overflow-hidden rounded-3xl bg-[linear-gradient(120deg,#6D28D9_0%,#7C3AED_55%,#9333EA_100%)] px-8 py-12 sm:px-14 sm:py-14">
          {/* subtle sheen */}
          <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
          <div className="relative grid items-center gap-8 md:grid-cols-2">
            <div>
              <h2 className="text-[30px] font-bold leading-tight tracking-tight text-white sm:text-[40px]">
                Ready to build your AI workforce?
              </h2>
              <p className="mt-4 max-w-md text-[15px] leading-relaxed text-white/90">
                Join thousands of companies already automating work with AI employees.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href="/register"
                  className="rounded-full bg-white px-6 py-3 text-[15px] font-semibold text-violet-accent transition-transform hover:scale-[1.03]"
                >
                  Hire AI Employee
                </Link>
                <Link
                  href="#"
                  className="rounded-full border border-white/40 px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-white/10"
                >
                  Book a Demo
                </Link>
              </div>
            </div>

            <div className="mx-auto w-56 sm:w-64 md:ml-auto md:mr-4">
              <RobotMascot />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
