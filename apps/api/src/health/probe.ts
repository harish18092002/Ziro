/** A dependency check: resolves if the dependency is reachable, rejects otherwise. */
export type Probe = () => Promise<void>;

export const DB_PROBE = Symbol('DB_PROBE');
export const REDIS_PROBE = Symbol('REDIS_PROBE');

/** Rejects if `work` has not settled within `ms`; always clears its timer. */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
