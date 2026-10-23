// The deploy job: bring the database up to date, then make sure the featured runs exist, so the service never
// builds a 500-order run while a visitor waits. It is the same image as the service, run as a Cloud Run Job
// with the owner role's DIRECT connection string in DATABASE_URL (docs/DEPLOY.md).
//
//   node apps/api/dist/scripts/prepare.js                 migrate, then seed the featured runs
//   node apps/api/dist/scripts/prepare.js --migrate-only  migrate and stop
//
// Idempotent: run it on every deploy. It writes one JSON line per step so the job's log reads like the
// service's. Exits non-zero on any failure, which fails the deploy before the new revision gets traffic.
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { loadDotEnv } from '../config/dotenv.js';
import { EnvValidationError, loadEnv } from '../config/env.js';
import { DemoService } from '../demo/demo.service.js';
import { grantAppRole, runMigrations } from './migrate.js';

const say = (message: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ severity: 'INFO', message, ...extra }));
};

async function main(): Promise<void> {
  loadDotEnv();
  const env = loadEnv(process.env);

  say('applying migrations');
  await runMigrations(env.DATABASE_URL);
  say('migrations applied');

  // Set by the deploy script on the job only: the role the SERVICE connects as. This job runs as the owner.
  const appRole = process.env['APP_DB_ROLE']?.trim();
  if (appRole) {
    await grantAppRole(env.DATABASE_URL, appRole);
    say('application role granted', { role: appRole });
  }
  if (process.argv.includes('--migrate-only')) return;

  // A context, not a server: no port, no worker, and no seeding of its own on boot.
  const app = await NestFactory.createApplicationContext(
    AppModule.register({ ...env, AGENT_WORKER_ENABLED: false, DEMO_SEED_ON_BOOT: false }),
    { logger: ['error', 'warn'] },
  );
  try {
    say('checking the featured runs');
    const seeded = await app.get(DemoService).seedFeatured();
    say('featured runs ready', seeded);
  } finally {
    await app.close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        message:
          error instanceof EnvValidationError ? error.message : `prepare failed: ${String(error)}`,
      }),
    );
    process.exit(1);
  },
);
