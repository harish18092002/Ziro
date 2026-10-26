// The flow diagram's dots, planned from a run: one round of DOTS dots shared between the fast lane (proved by
// code), the investigation lane, and a refusal (a proposal the checker sent back). Lanes are in proportion to
// the run, and every path that has records gets at least one dot, so a small lane never disappears. Pure.

export const DOTS = 20;
export const ROUND_MS = 9_000;

export type Route = 'fast' | 'investigate' | 'refused';

export interface DotPlan {
  fast: number;
  investigate: number;
  refused: number;
}

/** `share` is the part proved by code (0 to 1); `refused` is how many proposals the checker refused. */
export function dotPlan(share: number, refused: number, exceptions: number): DotPlan {
  const s = Math.min(1, Math.max(0, share));
  const ref = refused > 0 ? 1 : 0;
  const inv = exceptions > 0 ? Math.max(1, Math.round(DOTS * (1 - s)) - ref) : 0;
  return { fast: Math.max(0, DOTS - inv - ref), investigate: inv, refused: ref };
}

export interface Dot {
  route: Route;
  /** When it sets off within the round, in ms. */
  at: number;
}

/** The round's dots, spread evenly, investigation and refusal dots placed among the fast ones. */
export function schedule(plan: DotPlan): Dot[] {
  const routes: Route[] = [
    ...Array<Route>(plan.fast).fill('fast'),
    ...Array<Route>(plan.investigate).fill('investigate'),
    ...Array<Route>(plan.refused).fill('refused'),
  ];
  // the slow lanes leave early in the round so they arrive before it ends
  const slow = routes.filter((r) => r !== 'fast');
  const fast = routes.filter((r) => r === 'fast');
  const ordered = [...slow, ...fast];
  const gap = (ROUND_MS * 0.6) / Math.max(1, ordered.length);
  return ordered.map((route, i) => ({ route, at: Math.round(i * gap) }));
}

/** How long each route takes, end to end. */
export const TRAVEL_MS: Record<Route, number> = { fast: 2_600, investigate: 5_200, refused: 4_400 };

/** Progress (0 to 1) of a dot at time t of the round, or null when it is not on its way. */
export function dotProgress(dot: Dot, t: number): number | null {
  const p = (t - dot.at) / TRAVEL_MS[dot.route];
  return p >= 0 && p <= 1 ? p : null;
}
