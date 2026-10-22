import type { Rng } from './rng.js';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Razorpay-style ids (`pay_` + 14 alphanumerics), unique within one dataset. */
export class IdFactory {
  private readonly used = new Set<string>();

  constructor(private readonly rng: Rng) {}

  make(prefix: string, length = 14): string {
    for (;;) {
      const id = `${prefix}${this.rng.string(ALPHABET, length)}`;
      if (!this.used.has(id)) {
        this.used.add(id);
        return id;
      }
    }
  }
}
