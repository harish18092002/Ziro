// Test support: the local Redis from docker-compose (127.0.0.1:6379), and a way to tell whether it is
// there, so tests that need it are skipped, not failed, on a machine without it.
import { Redis } from 'ioredis';

export const LOCAL_REDIS_URL = 'redis://127.0.0.1:6379';

export async function localRedisAnswers(): Promise<boolean> {
  const probe = new Redis(LOCAL_REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    connectTimeout: 500,
  });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

/** Polls until the condition holds, or throws after `ms`. */
export async function until(condition: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}
