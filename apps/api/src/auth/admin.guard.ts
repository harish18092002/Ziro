import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { isAuthorised, isOpenPath } from './session.js';

/** Is the admin gate on? A token is set, and this is not the public demo (which is open by design). */
export const adminRequired = (env: Pick<Env, 'ADMIN_TOKEN' | 'DEMO_MODE'>): boolean =>
  env.ADMIN_TOKEN !== undefined && !env.DEMO_MODE;

/**
 * With `ADMIN_TOKEN` set, every API call needs the token (as a session cookie or a bearer header), except
 * the health checks and the sign-in. The console's own files are not behind it: it is the data that is.
 * With no token set, nothing changes: a laptop, or the public demo, stays open.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Pick<Env, 'ADMIN_TOKEN' | 'DEMO_MODE'>) {}

  canActivate(context: ExecutionContext): boolean {
    const token = this.env.ADMIN_TOKEN;
    if (token === undefined || !adminRequired(this.env)) return true;
    const req = context.switchToHttp().getRequest<Pick<Request, 'path' | 'headers'>>();
    if (isOpenPath(req.path)) return true;
    if (
      isAuthorised({ cookie: req.headers.cookie, authorization: req.headers.authorization }, token)
    ) {
      return true;
    }
    throw new UnauthorizedException({
      error: 'admin_required',
      message: 'sign in with the admin token',
    });
  }
}
