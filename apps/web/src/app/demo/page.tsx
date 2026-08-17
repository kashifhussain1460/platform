import type { Metadata } from 'next';
import Link from 'next/link';
import { OrlixaMark } from '@/components/marketing-dark/OrlixaMark';

export const metadata: Metadata = {
  title: 'Orlixa — Product demo',
  description: 'How Orlixa works, in six steps.',
};

/**
 * The recorded product-explainer video (`/how-it-works.mp4`) — the final
 * output of the self-playing animation in `components/marketing-dark/demo/`
 * (kept there, unused now, in case the video is ever re-recorded).
 */
export default function DemoPage() {
  return (
    <main className="font-marketing relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#050408] px-6 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(60% 60% at 30% 30%, rgba(124,58,237,0.20), transparent 70%),' +
            'radial-gradient(50% 50% at 80% 80%, rgba(147,51,234,0.16), transparent 70%)',
        }}
      />

      <Link href="/" className="absolute left-8 top-7 z-20 flex items-center gap-2">
        <OrlixaMark size={26} />
        <span className="text-sm font-bold tracking-tight text-white">Orlixa</span>
      </Link>
      <span className="absolute right-8 top-8 z-20 text-xs font-medium tracking-wide text-fg-muted">orlixa.io</span>

      <div className="relative z-10 w-full max-w-4xl">
        <video
          controls
          autoPlay
          playsInline
          preload="metadata"
          className="w-full rounded-dark-lg shadow-dark-card"
          src="/how-it-works.mp4"
        />
      </div>
    </main>
  );
}
