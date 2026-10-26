// The motion tokens JavaScript needs (count-ups and story timelines run on requestAnimationFrame, not CSS).
// They mirror the --dur-* and --stagger values in tokens.css; motion.test.ts fails if the two drift apart.
export const MOTION = {
  instant: 100,
  fast: 160,
  base: 280,
  slow: 480,
  reveal: 700,
  grow: 1000,
  count: 1200,
  stagger: 70,
} as const;

export type MotionToken = keyof typeof MOTION;

/** The CSS custom property each JavaScript value mirrors. */
export const MOTION_CSS: Record<MotionToken, string> = {
  instant: '--dur-instant',
  fast: '--dur-fast',
  base: '--dur-base',
  slow: '--dur-slow',
  reveal: '--dur-reveal',
  grow: '--dur-grow',
  count: '--dur-count',
  stagger: '--stagger',
};
