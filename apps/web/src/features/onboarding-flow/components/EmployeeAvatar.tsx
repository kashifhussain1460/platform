import type { EmployeeTemplate } from '../types';

const SIZE = {
  sm: { box: 'h-9 w-9', icon: 'h-4 w-4' },
  md: { box: 'h-12 w-12', icon: 'h-5 w-5' },
  lg: { box: 'h-16 w-16', icon: 'h-7 w-7' },
} as const;

/** Circular gradient avatar for an AI Employee template — the one place its
 * "face" is drawn, so every list (select, hub, skills/connections/knowledge
 * headers) looks like the same character. */
export function EmployeeAvatar({
  template,
  size = 'md',
  className = '',
}: {
  template: EmployeeTemplate;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const Icon = template.icon;
  const { box, icon } = SIZE[size];
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full shadow-[0_4px_16px_-4px_rgba(0,0,0,0.5)] ${box} ${className}`}
      style={{ background: `linear-gradient(135deg, ${template.avatarFrom}, ${template.avatarTo})` }}
    >
      <Icon className={`${icon} text-white`} />
    </span>
  );
}
