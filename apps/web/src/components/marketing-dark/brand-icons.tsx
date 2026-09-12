/**
 * Simplified flat-color brand marks for the Integrations grid + trusted-by
 * row. Hand-authored inline SVG (house style, no external logo assets) using
 * each brand's real, well-known colors for recognizability.
 */

type IconProps = { className?: string };
const box: React.CSSProperties = { width: '100%', height: '100%' };

export function SlackIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M9 2a2 2 0 1 0 0 4h2V4a2 2 0 0 0-2-2Z" fill="#36C5F0" />
      <path d="M9 8H4a2 2 0 1 0 0 4h5V8Z" fill="#36C5F0" />
      <path d="M22 9a2 2 0 1 0-4 0v2h2a2 2 0 0 0 2-2Z" fill="#2EB67D" />
      <path d="M16 9V4a2 2 0 1 0-4 0v5h4Z" fill="#2EB67D" />
      <path d="M15 22a2 2 0 1 0 0-4h-2v2a2 2 0 0 0 2 2Z" fill="#E01E5A" />
      <path d="M15 16h5a2 2 0 1 0 0-4h-5v4Z" fill="#E01E5A" />
      <path d="M2 15a2 2 0 1 0 4 0v-2H4a2 2 0 0 0-2 2Z" fill="#ECB22E" />
      <path d="M8 15v5a2 2 0 1 0 4 0v-5H8Z" fill="#ECB22E" />
    </svg>
  );
}

export function GmailIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="5" width="20" height="14" rx="2" fill="#FFFFFF" />
      <path d="M2 7l10 7 10-7" fill="none" stroke="#EA4335" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 7v10.5A1.5 1.5 0 0 0 3.5 19H6V9.2z" fill="#4285F4" />
      <path d="M22 7v10.5a1.5 1.5 0 0 1-1.5 1.5H18V9.2z" fill="#34A853" />
    </svg>
  );
}

export function GoogleDriveIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M8.6 2 1 15.2 4.9 22l7.6-13.2Z" fill="#00AC47" />
      <path d="M15.9 2H8.6l3.9 6.8h7.3Z" fill="#EA4335" />
      <path d="M20.1 22 24 15.2 19.8 8.8h-7.3l7.6 13.2Z" fill="#4285F4" />
      <path d="M4.9 22h15.2l-3.9-6.8H8.8Z" fill="#FFBA00" />
    </svg>
  );
}

export function HubSpotIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#FF7A59" />
      <path
        d="M15.5 10.6V8.4a1.7 1.7 0 1 0-1.6 0v2.2a4.6 4.6 0 0 0-2.2 1L7.1 8.2a1.9 1.9 0 1 0-.8 1.1l4.5 3.3a4.6 4.6 0 1 0 7.3 3.7 4.6 4.6 0 0 0-2.6-4.1Zm-1.6 6.9a2.3 2.3 0 1 1 0-4.6 2.3 2.3 0 0 1 0 4.6Z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

export function SalesforceIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path
        d="M10.2 6.4a3.6 3.6 0 0 1 5.9 1.1 3 3 0 0 1 4.1 3.4 3.4 3.4 0 0 1-1 6.6H8.6a4 4 0 0 1-.6-8 4 4 0 0 1 2.2-3.1Z"
        fill="#00A1E0"
      />
    </svg>
  );
}

export function NotionIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="20" height="20" rx="4" fill="#FFFFFF" />
      <path d="M7 6.5h2.3l5.6 8.4V6.5H17v11h-2.3L9.1 9.1v8.4H7Z" fill="#000000" />
    </svg>
  );
}

export function WhatsAppIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#25D366" />
      <path
        d="M12 5.5a6.5 6.5 0 0 0-5.6 9.8L5.5 18.5l3.3-.9A6.5 6.5 0 1 0 12 5.5Zm0 1.6a4.9 4.9 0 0 1 4 7.7c-.2.3-1.7 2.4-4 2.4a4.9 4.9 0 0 1-2.4-.6l-.3-.2-1.9.5.5-1.8-.2-.3A4.9 4.9 0 0 1 12 7.1Z"
        fill="#FFFFFF"
      />
      <path
        d="M10.2 9.3c-.2-.4-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.3.3-1 1-1 2.3s1 2.7 1.1 2.9c.1.1 2 3.1 4.8 4.2.4.2.8.3 1 .3.4.1.8.1 1.1 0 .4-.1 1.2-.5 1.4-1 .2-.5.2-.9.1-1l-.4-.2c-.2-.1-1.3-.6-1.5-.7-.2-.1-.3-.1-.5.1l-.6.8c-.1.1-.2.2-.4.1-.2-.1-.9-.3-1.7-1-.6-.6-1-1.3-1.2-1.5-.1-.2 0-.3.1-.4l.3-.4c.1-.1.1-.2.2-.4.1-.1 0-.3 0-.4Z"
        fill="#25D366"
      />
    </svg>
  );
}

export function MicrosoftIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="9.3" height="9.3" fill="#F25022" />
      <rect x="12.7" y="2" width="9.3" height="9.3" fill="#7FBA00" />
      <rect x="2" y="12.7" width="9.3" height="9.3" fill="#00A4EF" />
      <rect x="12.7" y="12.7" width="9.3" height="9.3" fill="#FFB900" />
    </svg>
  );
}

export function GoogleGIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M22 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.6a4.8 4.8 0 0 1-2.1 3.1v2.6h3.4c2-1.8 3.1-4.5 3.1-7.6Z" fill="#4285F4" />
      <path d="M12 22c2.8 0 5.2-.9 6.9-2.5l-3.4-2.6c-.9.6-2.1 1-3.5 1-2.7 0-5-1.8-5.8-4.3H2.7v2.7A10 10 0 0 0 12 22Z" fill="#34A853" />
      <path d="M6.2 13.6a6 6 0 0 1 0-3.8V7.1H2.7a10 10 0 0 0 0 9z" fill="#FBBC05" />
      <path d="M12 6.4c1.5 0 2.8.5 3.9 1.5l2.9-2.9C17.2 3.3 14.8 2 12 2a10 10 0 0 0-9.3 5.1l3.5 2.7c.8-2.5 3.1-4.4 5.8-4.4Z" fill="#EA4335" />
    </svg>
  );
}

export function AirbnbIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 2c.7 0 1.3.4 1.7 1.1 2 3.6 6.6 11 6.6 13.9a5 5 0 0 1-8.3 3.7 5 5 0 0 1-8.3-3.7c0-2.9 4.6-10.3 6.6-13.9C10.7 2.4 11.3 2 12 2Z"
        fill="#FF5A5F"
      />
    </svg>
  );
}

export function CalendarIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="4" width="20" height="18" rx="3" fill="#FFFFFF" />
      <rect x="2" y="4" width="20" height="5" rx="2" fill="#4285F4" />
      <rect x="6" y="2" width="2" height="4" rx="1" fill="#1A73E8" />
      <rect x="16" y="2" width="2" height="4" rx="1" fill="#1A73E8" />
      <rect x="5" y="12" width="3" height="3" fill="#34A853" />
      <rect x="10.5" y="12" width="3" height="3" fill="#FBBC05" />
      <rect x="16" y="12" width="3" height="3" fill="#EA4335" />
      <rect x="5" y="16.5" width="3" height="3" fill="#4285F4" />
    </svg>
  );
}

export function ZoomIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="#2D8CFF" />
      <rect x="5" y="8" width="10" height="8" rx="2" fill="#FFFFFF" />
      <path d="M16 10.5 20 8v8l-4-2.5Z" fill="#FFFFFF" />
    </svg>
  );
}

export function StripeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="22" height="22" rx="5" fill="#635BFF" />
      <path
        d="M11.4 8.9c0-.6.5-.9 1.3-.9 1.2 0 2.6.4 3.8 1V6.1A9.9 9.9 0 0 0 12.7 5c-2.9 0-4.9 1.5-4.9 4 0 3.9 5.4 3.3 5.4 5 0 .7-.6 1-1.5 1-1.3 0-3-.5-4.3-1.2v2.9A10.6 10.6 0 0 0 11.7 18c3 0 5.1-1.5 5.1-4.1 0-4.2-5.4-3.4-5.4-5Z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

export function AsanaIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="5.5" r="3.5" fill="#F06A6A" />
      <circle cx="5.5" cy="16" r="3.5" fill="#F06A6A" />
      <circle cx="18.5" cy="16" r="3.5" fill="#F06A6A" />
    </svg>
  );
}

export function ClickUpIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="cu-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#8930FD" />
          <stop offset="100%" stopColor="#49CCF9" />
        </linearGradient>
      </defs>
      <path d="M4 15.5 12 9l8 6.5-2.4 1.9L12 13l-5.6 4.4Z" fill="url(#cu-g)" />
      <path d="M4 19.5 12 13l8 6.5-2.4 1.9L12 17l-5.6 4.4Z" fill="url(#cu-g)" opacity=".55" />
    </svg>
  );
}

export function PipedriveIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#000000" />
      <path
        d="M11.3 6.2c2.7 0 4.5 1.8 4.5 4.4 0 2.7-1.8 4.5-4.2 4.5-1 0-1.8-.3-2.3-.9v4.6H6.8V6.5h2.4l.1 1c.5-.8 1.3-1.3 2-1.3Zm-.6 6.9c1.3 0 2.2-.9 2.2-2.4 0-1.4-.9-2.4-2.2-2.4-1.3 0-2.2 1-2.2 2.4 0 1.5.9 2.4 2.2 2.4Z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

export function CanvaIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="canva-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#00C4CC" />
          <stop offset="100%" stopColor="#7D2AE8" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="11" fill="url(#canva-g)" />
      <path
        d="M16.8 11.3c0-.3-.2-.5-.5-.4-.7.2-1.2 1-1.7 1.8-.5.8-1 1.6-1.7 1.6-.6 0-.9-.5-.9-1.3 0-1.5.9-3.6 1.7-5 .1-.3 0-.5-.3-.5h-1.3c-.2 0-.3.1-.4.3-1 2-1.7 4.2-1.7 5.9 0 1.6.8 2.6 2.1 2.6 1.1 0 1.9-.7 2.5-1.6.1.9.7 1.6 1.7 1.6 1.4 0 2.2-1.5 2.2-3.1 0-.6-.1-1.3-.3-1.9Z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

/** "+ More" tile glyph — plain plus, no brand. */
export function MoreIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/* ── Social glyphs (lucide dropped brand icons; hand-authored, currentColor) ── */
export function XIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg" fill="currentColor">
      <path d="M17.53 3H20.5l-6.49 7.42L21.75 21h-6.02l-4.71-6.16L5.62 21H2.64l6.94-7.94L2.25 3h6.17l4.26 5.63L17.53 3Zm-1.06 16.2h1.64L7.6 4.71H5.85L16.47 19.2Z" />
    </svg>
  );
}
export function LinkedInIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg" fill="currentColor">
      <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3 9h4v12H3V9Zm6 0h3.8v1.64h.05c.53-1 1.83-2.06 3.76-2.06 4.02 0 4.76 2.65 4.76 6.1V21h-4v-5.4c0-1.29-.02-2.95-1.8-2.95-1.8 0-2.07 1.4-2.07 2.85V21H9V9Z" />
    </svg>
  );
}
export function GitHubIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49l-.01-1.7c-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.9-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.700 0 0 .84-.28 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.93-2.35 4.79-4.58 5.05.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}
export function DiscordIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={box} aria-hidden xmlns="http://www.w3.org/2000/svg" fill="currentColor">
      <path d="M19.54 5.34A16.3 16.3 0 0 0 15.5 4.1l-.2.37c1.83.44 2.67 1.08 3.55 1.87A12.6 12.6 0 0 0 12 5.06c-2.4 0-4.6.55-6.85 1.28.88-.79 1.87-1.5 3.55-1.87l-.2-.37c-1.6.28-3.02.79-4.04 1.24C1.9 8.4 1.2 11.6 1.5 15.4a15 15 0 0 0 4.6 2.34l.5-.68c-.78-.29-1.5-.66-2.13-1.14.18-.13.35-.26.52-.4a10.7 10.7 0 0 0 9.02 0c.17.14.34.27.52.4-.63.48-1.35.85-2.13 1.14l.5.68a15 15 0 0 0 4.6-2.34c.35-4.15-.6-7.32-2.06-10.06ZM8.7 14.2c-.9 0-1.63-.83-1.63-1.85s.72-1.85 1.63-1.85c.9 0 1.64.84 1.63 1.85 0 1.02-.72 1.85-1.63 1.85Zm6.6 0c-.9 0-1.63-.83-1.63-1.85s.72-1.85 1.63-1.85c.9 0 1.64.84 1.63 1.85 0 1.02-.73 1.85-1.63 1.85Z" />
    </svg>
  );
}
