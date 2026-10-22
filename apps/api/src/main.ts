import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { loadDotEnv } from './config/dotenv.js';
import { EnvValidationError, loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  loadDotEnv();
  // Fail fast: validate every variable (and the rzp_live_ guard) before Nest builds anything.
  const env = loadEnv(process.env);

  const app = await NestFactory.create(AppModule.register(env), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(env.PORT);
}

bootstrap().catch((err: unknown) => {
  console.error(err instanceof EnvValidationError ? err.message : err);
  process.exit(1);
});
