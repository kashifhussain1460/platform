import { DarkSectionHeading, DarkHl } from './DarkSectionHeading';
import { MacWindowVideo } from './MacWindowVideo';

const PAIN_POINTS = ['Sending Emails', 'Sales Outreach', 'Recruitment', 'Accounting', 'CRM Updates', 'Report Generation'];

/** "The Problem" — the market-gap pitch video, ahead of "What is Orlixa?". */
export function MarketGapSection() {
  return (
    <section className="border-t border-white/[0.06] py-20 sm:py-28">
      <div className="mx-auto max-w-[1440px] px-8">
        <DarkSectionHeading kicker="The Problem">
          Repetitive work never stops. <DarkHl>Your headcount can&apos;t scale with it.</DarkHl>
        </DarkSectionHeading>
        <p className="mx-auto mt-5 max-w-2xl text-center text-[15px] leading-relaxed text-zinc-400">
          Today it&apos;s stitched together with people, spreadsheets, Zapier, and ChatGPT — more tools,
          more subscriptions, and it still doesn&apos;t scale.
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-2.5">
          {PAIN_POINTS.map((label) => (
            <span
              key={label}
              className="rounded-full border border-white/[0.08] bg-white/[0.03] px-4 py-1.5 text-sm text-zinc-300"
            >
              {label}
            </span>
          ))}
        </div>

        <div className="mx-auto mt-12 max-w-4xl">
          <MacWindowVideo
            src="/market-gap.mp4"
            label="Why repetitive work stops scaling before your headcount does"
          />
        </div>
      </div>
    </section>
  );
}
