import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { get } from './api';
import { easeOutCubic } from './chart-math';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
}

/** GET a path (or nothing, for null) and keep the latest answer; `reload` asks again. */
export function useLoad<T>(path: string | null): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let live = true;
    get<T>(path)
      .then((d) => {
        if (live) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, reload };
}

/** The current location hash, as it changes. */
export function useHash(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

// ---------- theme ----------

export type ThemeMode = 'system' | 'light' | 'dark';
const THEME_KEY = 'ziro-theme';
const NEXT_THEME: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' };

function storedTheme(): ThemeMode {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system'; // private window, blocked storage: the page works without it
  }
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'system') delete root.dataset['theme'];
  else root.dataset['theme'] = mode;
}

/** Applied before the first render. `?theme=dark` or `?theme=light` wins for that visit and is not saved. */
export function initTheme(): ThemeMode {
  const asked = new URLSearchParams(window.location.search).get('theme');
  const mode = asked === 'light' || asked === 'dark' ? asked : storedTheme();
  applyTheme(mode);
  return mode;
}

/** The viewer's theme choice (system, light, dark) and a way to step to the next one. */
export function useTheme(): [ThemeMode, () => void] {
  const [mode, setMode] = useState<ThemeMode>(() => initTheme());
  const step = useCallback(() => {
    setMode((current) => {
      const next = NEXT_THEME[current];
      applyTheme(next);
      try {
        if (next === 'system') window.localStorage.removeItem(THEME_KEY);
        else window.localStorage.setItem(THEME_KEY, next);
      } catch {
        /* storage blocked: the choice lasts for this visit */
      }
      return next;
    });
  }, []);
  return [mode, step];
}

// ---------- motion ----------

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(query.matches);
    query.addEventListener('change', on);
    return () => query.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * Becomes true once the element is on screen, and stays true: the cue to grow a bar or count a number up.
 * It never leaves content hidden: with no IntersectionObserver, or if one never fires, it turns true anyway.
 */
export function useInView<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const node = ref.current;
    if (seen || node === null) return;
    const watcher = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          watcher.disconnect();
        }
      },
      { threshold: 0.1, rootMargin: '0px 0px -5% 0px' },
    );
    watcher.observe(node);
    const fallback = window.setTimeout(() => setSeen(true), 2500);
    return () => {
      watcher.disconnect();
      window.clearTimeout(fallback);
    };
  }, [seen]);
  return [ref, seen];
}

/** Eased progress from 0 to 1 over `ms`, starting when `active` turns true. Reduced motion jumps straight to 1. */
export function useEased(active: boolean, ms = 1100): number {
  const reduced = usePrefersReducedMotion();
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    if (reduced) {
      setT(1);
      return;
    }
    let frame = 0;
    // Both ends of the interval come from the frame's own timestamp: one clock, never two that can disagree.
    let began: number | null = null;
    const step = (now: number) => {
      began ??= now;
      const p = Math.min(1, Math.max(0, (now - began) / ms));
      setT(easeOutCubic(p));
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [active, reduced, ms]);
  return t;
}
