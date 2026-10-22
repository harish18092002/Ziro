// Seeded, platform-independent pseudo-random numbers. The same seed gives the same stream on any
// machine and Node version, which is what makes byte-identical datasets possible. No Math.random,
// no clock. Output is integers only.
//
// Generator: sfc32 (public domain, Chris Doty-Humphrey), seeded through a splitmix32-style mixer.
// Math.imul is used for exact 32-bit multiplication; this file is outside the money lint scope.

const TWO_32 = 0x1_0000_0000;

/** FNV-1a over UTF-16 code units: a stable 32-bit hash of a label. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Avalanche-mixes two 32-bit values into one. */
function mix(a: number, b: number): number {
  let z = (a ^ Math.imul(b, 0x9e3779b1)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

export interface Weighted<T> {
  readonly value: T;
  readonly weight: number;
}

export class Rng {
  /** Identifies this stream; `fork` derives children from it, never from consumed state. */
  readonly root: number;
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  private constructor(root: number) {
    this.root = root >>> 0;
    let state = this.root;
    const step = (): number => {
      state = (state + 0x9e3779b9) | 0;
      let z = state;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = step();
    this.b = step();
    this.c = step();
    this.d = step();
    for (let i = 0; i < 15; i++) this.next();
  }

  static fromSeed(seed: number): Rng {
    if (!Number.isInteger(seed) || seed < 0 || seed >= TWO_32) {
      throw new RangeError('seed must be an unsigned 32-bit integer');
    }
    return new Rng(mix(seed, 0x5eed));
  }

  /**
   * An independent stream named by `label`. Because it depends only on this stream's root and the
   * label, adding or reordering other streams never shifts the numbers this one produces.
   */
  fork(label: string): Rng {
    return new Rng(mix(this.root, hashString(label)));
  }

  /** The next unsigned 32-bit integer. */
  next(): number {
    const t0 = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    const t = (t0 + this.d) | 0;
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** A uniform integer in [min, max], inclusive, without modulo bias. */
  int(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError(`invalid integer range [${min}, ${max}]`);
    }
    const span = max - min + 1;
    if (span === 1) return min;
    if (span > TWO_32) throw new RangeError('range wider than 2^32');
    const limit = TWO_32 - (TWO_32 % span);
    let x = this.next();
    while (x >= limit) x = this.next();
    return min + (x % span);
  }

  /** True with probability `bps` / 10 000. */
  chance(bps: number): boolean {
    return this.int(0, 9999) < bps;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new RangeError('cannot pick from an empty list');
    return item;
  }

  weighted<T>(items: readonly Weighted<T>[]): T {
    let total = 0;
    for (const item of items) total += item.weight;
    if (total <= 0) throw new RangeError('weights must sum to more than zero');
    let roll = this.int(0, total - 1);
    for (const item of items) {
      if (roll < item.weight) return item.value;
      roll -= item.weight;
    }
    throw new Error('unreachable: weighted pick fell through');
  }

  /** Fisher-Yates, in place. Returns the same array. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }

  digits(length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) out += String(this.int(0, 9));
    return out;
  }

  /** `length` characters drawn from `alphabet`. */
  string(alphabet: string, length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet.charAt(this.int(0, alphabet.length - 1));
    return out;
  }
}
