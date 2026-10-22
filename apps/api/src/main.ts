import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { loadDotEnv } from './config/dotenv.js';
import { EnvValidationError, loadEnv } from './config/env.js';
import { mountWeb } from './web/mount-web.js';

async function bootstrap(): Promise<void> {
  loadDotEnv();
  // Fail fast: validate every variable (and the rzp_live_ guard) before Nest builds anything.
  const env = loadEnv(process.env);

  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  if (!mountWeb(app, process.env['WEB_DIST_DIR'])) {
    app
      .get(Logger)
      .warn('the web console is not built (npm run build -w @ziro/web); serving the API only');
  }
  app.enableShutdownHooks();
  await app.listen(env.PORT);
}

bootstrap().catch((err: unknown) => {
  console.error(err instanceof EnvValidationError ? err.message : err);
  process.exit(1);
});
