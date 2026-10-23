// What a stranger may do to a public demo (DEMO_MODE). Reading is open. Writing is limited to the three
// things the console offers: start a run, reset the run you are in, and approve or reject a proposal in a
// run of your own (the review service refuses the featured runs). Everything else that creates work, spends
// money or accepts an upload is off: importing CSVs, creating runs by hand, matching, verifying, and the
// investigate endpoint, which would spend the model budget with no demo limit in front of it.
//
// A default-deny allowlist, so a route added later is closed on the public demo until someone opens it here.
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REVIEW = new RegExp(`^/proposals/${UUID}/(approve|reject)$`, 'i');
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Is this request one a public demo allows? `path` has no query string. */
export function allowedInDemoMode(method: string, path: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  if (method.toUpperCase() !== 'POST') return false;
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return clean === '/demo/runs' || clean === '/demo/reset' || REVIEW.test(clean);
}

@Injectable()
export class DemoModeGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Pick<Env, 'DEMO_MODE'>) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.env.DEMO_MODE) return true;
    const req = context.switchToHttp().getRequest<Pick<Request, 'method' | 'path'>>();
    if (allowedInDemoMode(req.method, req.path)) return true;
    throw new ForbiddenException({
      error: 'disabled_in_demo',
      message: 'this endpoint is switched off on the public demo',
    });
  }
}
