import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** Where `npm run build -w @ziro/web` puts the console, relative to apps/api/{src,dist}. */
export const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../../web/dist', import.meta.url));

// The console is one script, one stylesheet and calls back to this origin only. Nothing is framed,
// nothing is inlined, and the page never loads anything from elsewhere. Everything a stranger wrote
// (memos, narrations, model text) is rendered by React as text; this policy is the second wall.
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

/**
 * The one page that has to talk to Razorpay: the test-payments helper opens Razorpay's own Checkout, which
 * loads its script and frames its payment form from razorpay.com. It gets its own, narrow policy (Razorpay's
 * hosts for script, frames, connections, images and fonts; styles may be inline because Checkout writes
 * some). Everything else, the console included, keeps the strict policy above. The page holds no
 * user-supplied markup, takes no secrets, and cannot be framed.
 */
export const PAY_PAGE_PATH = '/pay.html';
export const PAY_PAGE_CSP =
  "default-src 'self'; script-src 'self' https://checkout.razorpay.com; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.razorpay.com; " +
  "font-src 'self' data: https://*.razorpay.com; connect-src 'self' https://*.razorpay.com; " +
  "frame-src https://*.razorpay.com; base-uri 'none'; form-action 'self'; " +
  "frame-ancestors 'none'; object-src 'none'";

/** The headers for one request path. */
export function securityHeadersFor(path: string): Record<string, string> {
  return path === PAY_PAGE_PATH
    ? { ...SECURITY_HEADERS, 'Content-Security-Policy': PAY_PAGE_CSP }
    : SECURITY_HEADERS;
}

/**
 * Serves the built console from this process (one URL) and sets the security headers on every response.
 * `trust proxy` makes `req.ip` the real client behind Cloud Run's front end, which the demo's rate limit
 * relies on. Returns false, and serves no files, when the console has not been built.
 */
export function mountWeb(app: NestExpressApplication, dir: string = DEFAULT_WEB_DIST): boolean {
  app.set('trust proxy', 1);
  app.use(
    (
      req: { path: string },
      res: { setHeader(name: string, value: string): void },
      next: () => void,
    ) => {
      for (const [name, value] of Object.entries(securityHeadersFor(req.path))) {
        res.setHeader(name, value);
      }
      next();
    },
  );
  if (!existsSync(`${dir}/index.html`)) return false;
  app.useStaticAssets(dir, { index: 'index.html', maxAge: '1h', fallthrough: true });
  return true;
}
