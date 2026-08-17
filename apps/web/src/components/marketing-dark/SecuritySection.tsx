import { Check } from 'lucide-react';
import { DarkKicker, DarkHl } from './DarkSectionHeading';

const GUARANTEES = ['SOC 2 Compliant', 'GDPR Ready', 'Role-based Access', 'Audit Logs', 'Data Encryption'];

/** Glossy 3D-style violet shield with a padlock — hand-authored gradient SVG. */
function ShieldLock({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 220 240" className={className} role="img" aria-label="Security shield" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: 'auto', overflow: 'visible' }}>
      <defs>
        <linearGradient id="sh-face" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0%" stopColor="#A78BFA" />
          <stop offset="45%" stopColor="#7C5CF0" />
          <stop offset="100%" stopColor="#4C2FB8" />
        </linearGradient>
        <linearGradient id="sh-bevel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#C4B5FD" />
          <stop offset="100%" stopColor="#7C5CF0" />
        </linearGradient>
        <radialGradient id="sh-glow" cx="50%" cy="55%" r="55%">
          <stop offset="0%" stopColor="rgba(124,58,237,0.55)" />
          <stop offset="100%" stopColor="rgba(124,58,237,0)" />
        </radialGradient>
        <linearGradient id="sh-lock" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F5F3FF" />
          <stop offset="100%" stopColor="#C4B5FD" />
        </linearGradient>
      </defs>

      {/* glow */}
      <ellipse cx="110" cy="130" rx="120" ry="120" fill="url(#sh-glow)" />

      {/* bevel/back plate (slightly larger, lighter) */}
      <path
        d="M110 14 L186 46 V116 C186 172 150 204 110 220 C70 204 34 172 34 116 V46 Z"
        fill="url(#sh-bevel)"
        opacity="0.55"
      />
      {/* main face */}
      <path
        d="M110 22 L178 50 V116 C178 166 146 195 110 210 C74 195 42 166 42 116 V50 Z"
        fill="url(#sh-face)"
      />
      {/* top gloss highlight */}
      <path
        d="M110 22 L178 50 V92 C150 74 70 74 42 92 V50 Z"
        fill="#FFFFFF"
        opacity="0.12"
      />

      {/* padlock */}
      <path d="M92 118 v-12 a18 18 0 0 1 36 0 v12" fill="none" stroke="url(#sh-lock)" strokeWidth="9" strokeLinecap="round" />
      <rect x="80" y="116" width="60" height="52" rx="10" fill="url(#sh-lock)" />
      <circle cx="110" cy="138" r="7" fill="#5E3CE8" />
      <rect x="107" y="140" width="6" height="16" rx="3" fill="#5E3CE8" />
    </svg>
  );
}

/** Enterprise-grade security — copy + shield illustration + guarantees checklist. */
export function SecuritySection() {
  return (
    <section className="border-t border-white/[0.06] py-20 sm:py-28">
      <div className="mx-auto grid max-w-[1440px] items-center gap-10 px-8 lg:grid-cols-3">
        <div>
          <DarkKicker>Security</DarkKicker>
          <h2 className="mt-3 text-[28px] font-bold leading-tight tracking-tight text-white sm:text-4xl">
            Enterprise-grade <DarkHl>security</DarkHl> you can rely on
          </h2>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-zinc-400">
            Your data is encrypted, private, and never used to train public models. Built with
            compliance and auditability in mind.
          </p>
        </div>

        <div className="mx-auto w-52 sm:w-60">
          <ShieldLock />
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-void-card/70 p-6">
          <ul className="space-y-4">
            {GUARANTEES.map((g) => (
              <li key={g} className="flex items-center gap-3 text-[15px] text-zinc-200">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet/20 text-violet-bright">
                  <Check className="h-3.5 w-3.5" strokeWidth={3} />
                </span>
                {g}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
