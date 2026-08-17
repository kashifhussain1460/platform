'use client';

import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ElementType,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { Eye, EyeOff, Lock } from 'lucide-react';
import { GoogleGIcon, MicrosoftIcon, GitHubIcon } from '@/components/marketing-dark/brand-icons';

/* ── Input with a left icon (+ optional right slot) ─────────────────────── */
type IconInputProps = InputHTMLAttributes<HTMLInputElement> & {
  icon: ElementType<{ className?: string }>;
  rightSlot?: ReactNode;
};
export const IconInput = forwardRef<HTMLInputElement, IconInputProps>(function IconInput(
  { icon: Icon, rightSlot, className = '', ...rest },
  ref,
) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center text-fg-muted">
        <Icon className="h-4 w-4" />
      </span>
      <input
        ref={ref}
        className={`field-modern ${className}`}
        style={{ paddingLeft: '2.75rem', paddingRight: rightSlot ? '2.75rem' : undefined }}
        {...rest}
      />
      {rightSlot && <div className="absolute right-2 top-1/2 -translate-y-1/2">{rightSlot}</div>}
    </div>
  );
});

/* ── Password input: lock icon + show/hide eye ──────────────────────────── */
export const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function PasswordInput(props, ref) {
    const [show, setShow] = useState(false);
    return (
      <IconInput
        ref={ref}
        icon={Lock}
        type={show ? 'text' : 'password'}
        rightSlot={
          <button
            type="button"
            aria-label={show ? 'Hide password' : 'Show password'}
            onClick={() => setShow((s) => !s)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:text-zinc-200"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        }
        {...props}
      />
    );
  },
);

/* ── Primary violet button (exact mockup violet + glow) ─────────────────── */
export function AuthButton({
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      // A keyboard user tabbing to "Sign In" had no way to tell they were on it:
      // the button defined a hover lift and a glow but nothing at all for focus,
      // so the whole form was navigable and invisible. The ring sits OUTSIDE the
      // button (offset) because the button's own surface is a saturated violet
      // gradient — a ring drawn on top of it would be the thing that disappears.
      className={`w-full rounded-xl bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] px-4 py-3 text-sm font-semibold text-white shadow-[0_14px_34px_-12px_rgba(91,33,230,0.85)] transition-all duration-200 hover:-translate-y-0.5 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-secondary disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Violet inline link (Sign in / Sign up / Forgot password?). */
export function AuthLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-[#8b6ef2] transition-colors hover:text-white">
      {children}
    </Link>
  );
}

/** "or continue with" divider. */
export function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-white/[0.08]" />
      <span className="text-xs text-fg-muted">{label}</span>
      <span className="h-px flex-1 bg-white/[0.08]" />
    </div>
  );
}

/** Three social sign-in buttons (Google / Microsoft / GitHub) — UI only. */
export function SocialRow() {
  const items: { Icon: ElementType<{ className?: string }>; label: string }[] = [
    { Icon: GoogleGIcon, label: 'Google' },
    { Icon: MicrosoftIcon, label: 'Microsoft' },
    { Icon: GitHubIcon, label: 'GitHub' },
  ];
  return (
    <div className="grid grid-cols-3 gap-3">
      {items.map(({ Icon, label }) => (
        <button
          key={label}
          type="button"
          aria-label={`Continue with ${label}`}
          className="flex items-center justify-center rounded-xl border border-white/[0.1] bg-white/[0.03] py-3 text-white transition-colors hover:border-white/20 hover:bg-white/[0.06]"
        >
          <span className="h-5 w-5">
            <Icon className="h-5 w-5" />
          </span>
        </button>
      ))}
    </div>
  );
}

/** Checkbox + label row. */
export function AuthCheckbox({
  label,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-400">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-white/20 bg-white/5 accent-[#6a30ec]"
        {...rest}
      />
      {label}
    </label>
  );
}

/** "Resend in mm:ss" countdown → becomes a clickable Resend when it hits 0. */
export function ResendCountdown({ seconds = 45 }: { seconds?: number }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (left === 0) return;
    const t = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  return left > 0 ? (
    <span className="font-medium text-[#8b6ef2]">
      Resend in {mm}:{ss}
    </span>
  ) : (
    <button
      type="button"
      onClick={() => setLeft(seconds)}
      className="font-medium text-[#8b6ef2] transition-colors hover:text-white"
    >
      Resend
    </button>
  );
}

/* ── 6-box OTP input (auto-advance, backspace) ──────────────────────────── */
export function OtpInput({ length = 6 }: { length?: number }) {
  const [vals, setVals] = useState<string[]>(Array(length).fill(''));
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const set = (i: number, v: string) => {
    const d = v.replace(/\D/g, '').slice(-1);
    setVals((prev) => {
      const next = [...prev];
      next[i] = d;
      return next;
    });
    if (d && i < length - 1) refs.current[i + 1]?.focus();
  };

  const onKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !vals[i] && i > 0) refs.current[i - 1]?.focus();
  };

  return (
    <div className="flex justify-center gap-2.5 sm:gap-3">
      {Array.from({ length }).map((_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          inputMode="numeric"
          maxLength={1}
          value={vals[i]}
          onChange={(e) => set(i, e.target.value)}
          onKeyDown={(e) => onKey(i, e)}
          className="h-14 w-11 rounded-xl border border-white/[0.12] bg-white/[0.03] text-center text-xl font-semibold text-white transition-all focus:border-[#7c5cf0] focus:bg-white/[0.05] focus:shadow-[0_0_0_3px_rgba(94,60,232,0.28)] focus:outline-none sm:w-12"
        />
      ))}
    </div>
  );
}
