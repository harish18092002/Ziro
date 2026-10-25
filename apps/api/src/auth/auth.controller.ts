import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { RateLimiter } from '../demo/rate-limit.js';
import { adminRequired } from './admin.guard.js';
import { COOKIE_NAME, isAuthorised, safeEqual, SESSION_HOURS, sessionValue } from './session.js';

const loginSchema = z.strictObject({ token: z.string().min(1).max(500) });

/** Sign in, sign out, and say whether sign-in is needed at all. These paths are open (see session.isOpenPath). */
@Controller('auth')
export class AuthController {
  // Ten wrong guesses a minute per address is a speed bump; the token's length is the real defence.
  private readonly attempts = new RateLimiter([{ windowMs: 60_000, max: 10 }]);

  constructor(@Inject(ENV) private readonly env: Pick<Env, 'ADMIN_TOKEN' | 'DEMO_MODE'>) {}

  @Get('status')
  status(@Req() req: Request) {
    const token = this.env.ADMIN_TOKEN;
    const required = adminRequired(this.env);
    return {
      required,
      authenticated:
        !required ||
        (token !== undefined &&
          isAuthorised(
            { cookie: req.headers.cookie, authorization: req.headers.authorization },
            token,
          )),
    };
  }

  @Post('login')
  @HttpCode(200)
  login(
    @Body(new ZodPipe(loginSchema)) body: { token: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = this.env.ADMIN_TOKEN;
    if (token === undefined || !adminRequired(this.env))
      return { required: false, authenticated: true };

    const verdict = this.attempts.check(req.ip ?? 'unknown');
    if (!verdict.ok) {
      res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
      throw new HttpException(
        {
          error: 'too_many_attempts',
          message: `wait ${verdict.retryAfterSeconds} seconds and try again`,
        },
        429,
      );
    }
    if (!safeEqual(body.token, token)) {
      throw new UnauthorizedException({
        error: 'wrong_token',
        message: 'that is not the admin token',
      });
    }
    res.cookie(COOKIE_NAME, sessionValue(token), {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      path: '/',
      maxAge: SESSION_HOURS * 3_600_000,
    });
    return { required: true, authenticated: true };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  }
}
