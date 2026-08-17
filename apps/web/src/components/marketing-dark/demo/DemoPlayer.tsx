'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { RotateCcw } from 'lucide-react';
import { OrlixaMark } from '../OrlixaMark';
import {
  IntroScene,
  HireScene,
  SkillsScene,
  KnowledgeScene,
  WorkflowScene,
  ApprovalScene,
  MeasureScene,
  OutroScene,
} from './scenes';

interface Scene {
  key: string;
  dur: number; // ms on screen
  Render: () => JSX.Element;
}

const SCENES: Scene[] = [
  { key: 'intro', dur: 4500, Render: IntroScene },
  { key: 'hire', dur: 9000, Render: HireScene },
  { key: 'skills', dur: 9000, Render: SkillsScene },
  { key: 'knowledge', dur: 9000, Render: KnowledgeScene },
  { key: 'workflow', dur: 10500, Render: WorkflowScene },
  { key: 'approval', dur: 9500, Render: ApprovalScene },
  { key: 'measure', dur: 9000, Render: MeasureScene },
  { key: 'outro', dur: 8000, Render: OutroScene },
];

/**
 * Self-playing Orlixa product explainer (~68s). Full-viewport, dark/violet,
 * smooth Framer-Motion scene transitions. Screen-record to MP4.
 * `?scene=N` freezes on a single scene (deterministic capture / manual frames).
 */
export function DemoPlayer() {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [frozen, setFrozen] = useState(false);

  // ?scene=N → jump to + freeze a single scene
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const s = p.get('scene');
    if (s != null) {
      const n = Math.max(0, Math.min(SCENES.length - 1, parseInt(s, 10) || 0));
      setI(n);
      setPlaying(false);
      setFrozen(true);
    }
  }, []);

  // auto-advance
  useEffect(() => {
    if (!playing || frozen) return;
    if (i >= SCENES.length - 1) return; // stop on outro
    const t = setTimeout(() => setI((v) => v + 1), SCENES[i].dur);
    return () => clearTimeout(t);
  }, [i, playing, frozen]);

  const atEnd = i >= SCENES.length - 1;
  const Active = SCENES[i].Render;

  return (
    <div className="font-marketing relative h-screen w-screen overflow-hidden bg-[#050408]">
      {/* ambient background */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(60% 60% at 30% 30%, rgba(124,58,237,0.20), transparent 70%),' +
            'radial-gradient(50% 50% at 80% 80%, rgba(147,51,234,0.16), transparent 70%)',
        }}
      />
      <div aria-hidden className="pointer-events-none absolute -left-40 top-1/4 h-96 w-96 rounded-full bg-violet/20 blur-[120px]" />
      <div aria-hidden className="pointer-events-none absolute -right-40 bottom-1/4 h-96 w-96 rounded-full bg-violet-accent/20 blur-[120px]" />

      {/* persistent brand mark */}
      <div className="absolute left-8 top-7 z-20 flex items-center gap-2">
        <OrlixaMark size={26} />
        <span className="text-sm font-bold tracking-tight text-white">Orlixa</span>
      </div>
      <span className="absolute right-8 top-8 z-20 text-xs font-medium tracking-wide text-fg-muted">orlixa.io</span>

      {/* stage */}
      <div className="absolute inset-0 flex items-center justify-center px-10">
        <AnimatePresence mode="wait">
          <motion.div
            key={SCENES[i].key}
            initial={{ opacity: 0, scale: 0.98, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 1.02, y: -14 }}
            transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            className="flex w-full items-center justify-center"
          >
            <Active />
          </motion.div>
        </AnimatePresence>
      </div>

      {/* progress ticks */}
      <div className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5">
        {SCENES.map((s, idx) => (
          <span
            key={s.key}
            className={`h-1 rounded-full transition-all duration-500 ${
              idx === i ? 'w-8 bg-violet' : idx < i ? 'w-4 bg-violet/50' : 'w-4 bg-white/15'
            }`}
          />
        ))}
      </div>

      {/* replay (shown at end, non-frozen) */}
      {atEnd && !frozen && (
        <button
          type="button"
          onClick={() => setI(0)}
          className="absolute bottom-5 right-8 z-20 flex items-center gap-2 rounded-full border border-white/[0.12] bg-void-card/80 px-4 py-2 text-sm font-medium text-white backdrop-blur hover:bg-white/[0.08]"
        >
          <RotateCcw className="h-4 w-4" strokeWidth={2} />
          Replay
        </button>
      )}
    </div>
  );
}
