'use client';

import { useState } from 'react';
import { Star } from 'lucide-react';
import { DarkSectionHeading, DarkHl } from './DarkSectionHeading';

interface Testimonial {
  quote: string;
  name: string;
  title: string;
  initials: string;
  ring: string;
}

const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      'Orlixa has transformed the way we hire. Our AI Recruiter screens candidates better than our manual process.',
    name: 'James Carter',
    title: 'Head of Talent, TechNova',
    initials: 'JC',
    ring: 'bg-sky-400/20 text-sky-300',
  },
  {
    quote:
      'We automated 80% of our support tickets. Response time dropped and customer satisfaction went up.',
    name: 'Sarah Williams',
    title: 'Customer Success, Cloudly',
    initials: 'SW',
    ring: 'bg-amber-400/20 text-amber-300',
  },
  {
    quote:
      'Finally, a platform that brings all our tools, data and AI employees into one place. Game changer.',
    name: 'David Lee',
    title: 'COO, ScaleUp Inc.',
    initials: 'DL',
    ring: 'bg-emerald-400/20 text-emerald-300',
  },
];

/** "Trusted by businesses" — star-rated testimonial cards + carousel dots. */
export function Testimonials() {
  const [active, setActive] = useState(0);

  return (
    <section className="border-t border-white/[0.06] py-20 sm:py-28">
      <div className="mx-auto max-w-[1440px] px-8">
        <DarkSectionHeading kicker="Trusted by businesses">
          Loved by teams <DarkHl>around the world</DarkHl>
        </DarkSectionHeading>

        <div className="mt-14 grid gap-5 sm:grid-cols-3">
          {TESTIMONIALS.map((t) => (
            <div key={t.name} className="rounded-xl border border-white/[0.08] bg-void-card p-6">
              <div className="flex gap-0.5 text-gold">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} className="h-4 w-4" fill="currentColor" strokeWidth={0} />
                ))}
              </div>
              <p className="mt-4 text-[15px] leading-relaxed text-zinc-300">&ldquo;{t.quote}&rdquo;</p>
              <div className="mt-5 flex items-center gap-3">
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${t.ring}`}
                >
                  {t.initials}
                </span>
                <div>
                  <p className="text-sm font-semibold text-white">{t.name}</p>
                  <p className="text-xs text-fg-muted">{t.title}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 flex justify-center gap-2">
          {TESTIMONIALS.map((t, i) => (
            <button
              key={t.name}
              type="button"
              aria-label={`Show testimonial ${i + 1}`}
              onClick={() => setActive(i)}
              className={`h-2 rounded-full transition-all ${
                active === i ? 'w-6 bg-violet' : 'w-2 bg-white/20'
              }`}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
