import { type DynamicModule, Module } from '@nestjs/common';
import type { Env } from './env.js';

/** Injection token for the validated, typed environment. */
export const ENV = Symbol('ENV');

@Module({})
export class ConfigModule {
  /** Takes an already-validated Env: validation happens once in main.ts, before Nest starts. */
  static forRoot(env: Env): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
