import type { FlowStep } from './types';

export interface PanelContent {
  /** Only `welcome` carries this — the rest jump straight to the headline. */
  eyebrow?: string;
  headlineLead: string;
  /** Final word(s) of the headline, rendered in the violet gradient. */
  headlineHighlight: string;
  tagline: string;
  /** Always 4 — paired positionally with the fixed icon/colour set in BrandPanel. */
  bullets: [string, string, string, string];
  /** 1 caption (welcome) or 2 floating cards (every other screen). */
  annotations: string[];
  /** Absent only on `welcome`, which has no progress to reflect on yet. */
  quote?: string;
}

export const PANEL_CONTENT: Record<FlowStep, PanelContent> = {
  welcome: {
    eyebrow: 'AI employees for real business',
    headlineLead: 'Hire AI Employees. Get Real Work',
    headlineHighlight: 'Done.',
    tagline:
      'Orlixa helps you build, configure and deploy AI employees that understand your business, use your tools, and work 24/7.',
    bullets: ['Automate real work', 'Connect your tools', 'Use your company knowledge', 'Scale with AI employees'],
    annotations: ['Your AI team is ready to help.'],
  },
  company: {
    headlineLead: 'From Idea to',
    headlineHighlight: 'Impact',
    tagline: 'Build your AI workforce and focus on what matters most.',
    bullets: ['Automate operations', 'Connect your favourite tools', 'Use your company knowledge', 'Scale with AI employees'],
    annotations: ['Ideas → Action', 'Your AI team works for you 24/7'],
    quote: 'The fastest way to grow is with the right AI team.',
  },
  departments: {
    headlineLead: 'Structure Your',
    headlineHighlight: 'Organization.',
    tagline: 'Add the teams you actually have — AI Employees and approvals can be scoped to them later.',
    bullets: ['Mirrors how you already work', 'Nobody is restricted by default', 'Change it anytime', 'Powers approval routing later'],
    annotations: ['Teams, mapped.', 'Ready for approvals & routing.'],
    quote: 'Structure now, so nothing has to be rebuilt later.',
  },
  goals: {
    headlineLead: 'Turn Your Goals Into',
    headlineHighlight: 'Real Outcomes.',
    tagline: "Whether it's growth, support, or automation — Orlixa helps you achieve more with AI employees.",
    bullets: ['Real business impact', 'Connect your existing tools', 'Use your company knowledge', 'Scale with AI employees'],
    annotations: ["Set your goals. We'll help you get there.", 'Smarter work starts with clarity.'],
    quote: 'Clear goals. Real progress.',
  },
  plan: {
    headlineLead: 'Built for Businesses',
    headlineHighlight: 'of Tomorrow.',
    tagline: 'Choose a plan that fits your goals and start building your AI workforce today.',
    bullets: ['Flexible plans', 'More AI employees', 'Connect your favourite tools', 'Real business results'],
    annotations: ['Scale smarter with AI employees.', 'Choose. Configure. Grow.'],
    quote: 'Right plan. Bigger possibilities.',
  },
  selectEmployees: {
    headlineLead: 'Meet Your Future',
    headlineHighlight: 'AI Workforce.',
    tagline: 'Choose the AI employees that match the work your business needs done.',
    bullets: ['Purpose-built roles', 'Ready in minutes', 'Trained on your business', 'Works alongside your team'],
    annotations: ['Choose your team.', 'Every role, ready to hire.'],
    quote: 'The right hire changes everything.',
  },
  configureEmployees: {
    headlineLead: 'Give Each Hire Its Own',
    headlineHighlight: 'Voice.',
    tagline: "Set the name, persona and language for every AI employee you're building.",
    bullets: ['Personalised persona', 'Multi-language ready', 'Matches your brand tone', 'Easy to fine-tune'],
    annotations: ['Make it yours.', 'Configured in minutes.'],
    quote: 'Personality is part of the job.',
  },
  skills: {
    headlineLead: 'Equip Them With',
    headlineHighlight: 'Real Skills.',
    tagline: 'Assign the tools and abilities each AI employee needs to get work done.',
    bullets: ['Ready-made skill library', 'Email, CRM & more', 'Mix and match freely', 'Add more anytime'],
    annotations: ['Skills, assigned.', 'Built to take action.'],
    quote: 'Give them the tools. Watch them work.',
  },
  connections: {
    headlineLead: 'Plug Into The Tools You Already',
    headlineHighlight: 'Use.',
    tagline: 'Connect the accounts your AI employees need — safely, and only where you say yes.',
    bullets: ['Gmail, Slack, HubSpot & more', 'Secure, revocable access', 'Per-employee or company-wide', 'Connect now or later'],
    annotations: ['One click to connect.', 'Your tools, their toolkit.'],
    quote: 'Great teams use great tools.',
  },
  knowledge: {
    headlineLead: 'Teach Them What Your Business',
    headlineHighlight: 'Knows.',
    tagline: 'Upload the docs and guides that make your AI employees sound like your business.',
    bullets: ['Docs, guides & FAQs', 'Instantly searchable', 'Shared or role-specific', 'Keeps answers accurate'],
    annotations: ['Knowledge in, answers out.', 'Smarter with every doc.'],
    quote: 'Context makes AI useful.',
  },
  workflows: {
    headlineLead: 'Turn Steps Into',
    headlineHighlight: 'Automatic Work.',
    tagline: "Chain your AI employees' actions into workflows that run without you.",
    bullets: ['Trigger on events or schedule', 'No-code step builder', 'Approvals built in', 'Runs 24/7'],
    annotations: ['Set it. Forget it.', 'Work that runs itself.'],
    quote: 'Automation is time, given back.',
  },
  review: {
    headlineLead: 'One Last Look Before',
    headlineHighlight: 'Launch.',
    tagline: 'Check every AI employee is ready — skills connected, knowledge loaded, workflows set.',
    bullets: ['Readiness at a glance', 'Fix issues in one click', "Nothing launches half-built", "You're always in control"],
    annotations: ['Almost there.', 'Ready means ready.'],
    quote: 'Measure twice. Hire once.',
  },
  success: {
    headlineLead: 'Your AI Workforce Is',
    headlineHighlight: 'Live.',
    tagline: 'Every AI employee you hired is active and ready to get to work.',
    bullets: ['Working around the clock', 'Learning as they go', 'Always reviewable', 'Easy to expand later'],
    annotations: ['Welcome to the team.', 'Real work starts now.'],
    quote: 'From idea to impact — together.',
  },
};
