// The admin gate's arithmetic, with no framework: what the cookie holds, how a request proves itself, and
// which paths stay open. A shared secret for a private deployment, not user accounts.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'ziro_admin';
/** Long enough that guessing it is not the weak point. */
export const MIN_TOKEN_LENGTH = 16;
export const SESSION_HOURS = 8;

/**
 * What the cookie holds: an HMAC of a fixed label, keyed by the token. The token itself never sits in a
 * cookie, and a cookie from one token is worthless under another.
 */
export function sessionValue(token: string): string {
  return createHmac('sha256', token).update('ziro-admin-session-v1').digest('hex');
}

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();

/** Equal-time comparison. Both sides are hashed first, so a different length leaks nothing either. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** One cookie out of a `Cookie` header, or null. */
export function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

export interface Credentials {
  readonly cookie: string | undefined;
  readonly authorization: string | undefined;
}

/** A valid session cookie (the browser) or `Authorization: Bearer <token>` (a script). */
export function isAuthorised(credentials: Credentials, token: string): boolean {
  const cookie = cookieValue(credentials.cookie, COOKIE_NAME);
  if (cookie !== null && safeEqual(cookie, sessionValue(token))) return true;
  const bearer = /^Bearer (.+)$/.exec(credentials.authorization ?? '');
  return bearer?.[1] !== undefined && safeEqual(bearer[1], token);
}

/** Health checks and the sign-in itself must stay reachable, or nobody could ever sign in. */
export function isOpenPath(path: string): boolean {
  return (
    path === '/health' ||
    path.startsWith('/health/') ||
    path === '/auth' ||
    path.startsWith('/auth/')
  );
}
