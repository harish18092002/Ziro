import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MOTION, MOTION_CSS } from './motion';
import { ACTOR, STATE } from './states';

// tokens.css is the one place for colour and motion. These checks read it as text: the dark theme is written
// twice (OS setting and the toggle) and the two copies must not drift; text and the ink inside every money-state
// fill must reach WCAG AA (4.5:1) in both themes; and every colour the code names must exist.
const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

type Tokens = Map<string, string>;

function block(source: string, opener: string): Tokens {
  const start = source.indexOf(opener);
  if (start < 0) throw new Error(`no block ${opener}`);
  const open = source.indexOf('{', start + opener.length - 1);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const body = source.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Tokens = new Map();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (m[1] !== undefined && m[2] !== undefined) out.set(m[1], m[2].trim().replace(/\s+/g, ' '));
  }
  return out;
}

const light = block(css, ':root {');
const fixed = block(css.slice(css.indexOf(':root {') + 7), ':root {');
const darkMedia = block(css, ":root:where(:not([data-theme='light'])) {");
const darkToggle = block(css, ":root[data-theme='dark'] {");
const dark: Tokens = new Map([...light, ...darkMedia]);

function luminance(hex: string): number {
  const v = hex.replace('#', '');
  const channel = (i: number) => {
    const c = parseInt(v.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
const hexOf = (t: Tokens, name: string): string => {
  const v = t.get(name);
  if (v === undefined || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${name} is not a hex colour`);
  return v;
};
const themes: [string, Tokens][] = [
  ['light', light],
  ['dark', dark],
];

describe('tokens.css', () => {
  it('writes the dark theme twice, identically (OS setting and the toggle)', () => {
    expect([...darkToggle.entries()]).toEqual([...darkMedia.entries()]);
  });

  it('gives every themed colour a dark value', () => {
    const themed = [...light.keys()].filter((k) => !k.startsWith('--blob'));
    for (const name of themed) expect(darkMedia.has(name), name).toBe(true);
  });

  it.each(themes)('text reaches 4.5:1 on every surface in %s', (_mode, t) => {
    for (const text of ['--ink', '--ink-2', '--ink-3', '--link', '--good-text']) {
      for (const surface of ['--page', '--card', '--card-2']) {
        const ratio = contrast(hexOf(t, text), hexOf(t, surface));
        expect(ratio, `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(themes)('words inside every money-state fill reach 4.5:1 in %s', (_mode, t) => {
    for (const state of ['rules', 'ai', 'you', 'wait', 'open', 'ignored']) {
      const ratio = contrast(hexOf(t, `--on-st-${state}`), hexOf(t, `--st-${state}`));
      expect(ratio, state).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(hexOf(t, '--on-brand'), hexOf(t, '--brand'))).toBeGreaterThanOrEqual(4.5);
  });

  it('defines every colour the code names', () => {
    const named = [
      ...Object.values(STATE).flatMap((s) => [s.color, s.ink]),
      ...Object.values(ACTOR).map((a) => a.color),
    ];
    for (const ref of named) {
      const name = /^var\((--[\w-]+)\)$/.exec(ref)?.[1];
      expect(name, ref).toBeDefined();
      expect(light.has(name ?? '') && darkMedia.has(name ?? ''), ref).toBe(true);
    }
  });

  it('keeps green for done: the three done states are greens, waiting and open are not', () => {
    const hue = (hex: string) => {
      const v = hex.replace('#', '');
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [
        number,
        number,
        number,
      ];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min) return 0;
      const d = max - min;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    for (const [, t] of themes) {
      for (const done of ['--st-rules', '--st-ai', '--st-you']) {
        const h = hue(hexOf(t, done));
        expect(h, done).toBeGreaterThan(90);
        expect(h, done).toBeLessThan(185);
      }
      for (const notDone of ['--st-wait', '--st-open']) {
        expect(hue(hexOf(t, notDone)), notDone).toBeLessThan(60);
      }
    }
  });

  it('has the fixed scales: type, 8-point spacing, radius, stacking and motion', () => {
    for (const n of ['--fs-xs', '--fs-base', '--fs-display', '--sp-1', '--sp-9', '--tap']) {
      expect(fixed.has(n), n).toBe(true);
    }
    for (const [name, value] of fixed) {
      if (name.startsWith('--sp-')) expect(Number.parseInt(value, 10) % 4, name).toBe(0);
    }
    for (const n of ['--r-sm', '--r-md', '--z-sticky', '--z-tooltip', '--ease-out', '--stagger']) {
      expect(fixed.has(n), n).toBe(true);
    }
  });
});

describe('motion.ts', () => {
  it('mirrors the CSS motion tokens exactly', () => {
    for (const [key, cssName] of Object.entries(MOTION_CSS)) {
      expect(fixed.get(cssName), cssName).toBe(`${MOTION[key as keyof typeof MOTION]}ms`);
    }
  });
});
