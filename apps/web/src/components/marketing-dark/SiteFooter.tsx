import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { XIcon, LinkedInIcon, GitHubIcon, DiscordIcon } from './brand-icons';
import { OrlixaMark } from './OrlixaMark';

const COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'AI Employees', href: '/register' },
      { label: 'Workflows', href: '#' },
      { label: 'Integrations', href: '#' },
      { label: 'Pricing', href: '#pricing' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Documentation', href: '#' },
      { label: 'Blog', href: '#' },
      { label: 'Help Center', href: '#' },
      { label: 'API', href: '#' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About Us', href: '#' },
      { label: 'Careers', href: '#' },
      { label: 'Privacy Policy', href: '#' },
      { label: 'Terms of Service', href: '#' },
    ],
  },
];

const SOCIALS = [
  { label: 'X', Icon: XIcon },
  { label: 'LinkedIn', Icon: LinkedInIcon },
  { label: 'GitHub', Icon: GitHubIcon },
  { label: 'Discord', Icon: DiscordIcon },
];

/** Site footer — brand + link columns + newsletter + socials. */
export function SiteFooter() {
  return (
    <footer className="border-t border-white/[0.06] bg-void px-8 py-14">
      <div className="mx-auto max-w-[1440px]">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1.6fr]">
          {/* brand */}
          <div>
            <div className="flex items-center gap-2.5">
              <OrlixaMark size={32} />
              <span className="flex flex-col leading-none">
                <span className="text-base font-extrabold tracking-tight text-white">Orlixa</span>
                <span className="text-[10px] font-medium tracking-wide text-fg-muted">AI Workforce Platform</span>
              </span>
            </div>
            <p className="mt-5 text-xs text-fg-subtle">© 2026 Orlixa. All rights reserved.</p>
          </div>

          {/* link columns */}
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <p className="text-sm font-semibold text-white">{col.title}</p>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link href={l.href} className="text-sm text-zinc-400 transition-colors hover:text-white">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/* newsletter */}
          <div>
            <p className="text-sm font-semibold text-white">Stay updated</p>
            <p className="mt-4 text-sm text-zinc-400">Get the latest updates on features, releases and more.</p>
            <form className="mt-4 flex items-center gap-2" action="#">
              <input
                type="email"
                required
                placeholder="Enter your email"
                aria-label="Email address"
                className="min-w-0 flex-1 rounded-lg border border-white/[0.1] bg-void-card px-3.5 py-2.5 text-sm text-white placeholder:text-fg-muted focus:border-violet/50"
              />
              <button
                type="submit"
                aria-label="Subscribe"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet text-white transition-colors hover:bg-violet-hover"
              >
                <ArrowRight className="h-4 w-4" strokeWidth={2.4} />
              </button>
            </form>
            <div className="mt-5 flex items-center gap-3">
              {SOCIALS.map(({ label, Icon }) => (
                <a
                  key={label}
                  href="#"
                  aria-label={label}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.08] bg-void-card text-zinc-400 transition-colors hover:border-violet/40 hover:text-white"
                >
                  <span className="h-4 w-4">
                    <Icon />
                  </span>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
